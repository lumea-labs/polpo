import { describe, expect, it, vi } from "vitest";
import {
  createToolInvocationContext,
  MemoryLoopRunStore,
  RuntimeGuardrailEngine,
  createRunOutputPolicy,
  createRunToolMiddleware,
  type LoopTraceEvent,
} from "@polpo-ai/core";
import {
  completionRoutes,
  runConversationTurn,
  type CompletionRouteDeps,
} from "./completions.js";
import { runProjectLoopCompletion } from "./completions/project-loop-runner.js";

describe("completionRoutes project loop runtime", () => {
  function makeDeps(projectLoop?: any): CompletionRouteDeps {
    let now = 100;
    return {
      getAgents: async () => [{
        name: "timer",
        model: "test",
        assignedLoops: ["time-tracker"],
        allowedTools: ["*"],
      }],
      getConfig: () => ({}),
      getMemoryStore: () => null,
      getSessionStore: () => null,
      getStore: () => null,
      emit: () => {},
      buildAgentPrompt: () => {
        throw new Error("tool-only project loop should not build an agent prompt");
      },
      resolveAgentModel: async () => {
        throw new Error("tool-only project loop should not resolve a model");
      },
      resolveAgentTools: async () => ({
        tools: [],
        executor: async (name, args) => {
          if (name === "audit_step") return JSON.stringify({ ok: true, args });
          if (name !== "unix_time") return `Error: Unknown tool "${name}"`;
          const value = now;
          now += 5;
          return String(value);
        },
      }),
      getProjectLoop: async (name) => projectLoop ?? ({
        name,
        context: "shared",
        start: "capture_start",
        steps: {
          capture_start: {
            type: "tool",
            tool: "unix_time",
            saveAs: "timing.start",
            next: "capture_end",
          },
          capture_end: {
            type: "tool",
            tool: "unix_time",
            saveAs: "timing.end",
            next: "end",
          },
        },
      }),
    };
  }

  it("executes an assigned default project loop and returns shared tool context", async () => {
    const deps = makeDeps();

    const app = completionRoutes(() => deps);
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "timer",
        loop: "time-tracker",
        messages: [{ role: "user", content: "track it" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-loop")).toBe("time-tracker");
    const json = await res.json() as any;
    expect(json.choices[0].message.content).toContain('"timing"');
    expect(JSON.parse(json.choices[0].message.content)).toEqual({
      timing: {
        start: "100",
        end: "105",
      },
    });
    expect(json.loop_trace.map((event: any) => event.type)).toEqual([
      "loop.start",
      "tool.call",
      "tool.result",
      "transition",
      "tool.call",
      "tool.result",
      "loop.end",
    ]);
    expect(json.loop_trace[0]).toMatchObject({ loop: "time-tracker", status: "started" });
  });

  it("recalculates Loop tools without inheriting the Channel Route restriction", async () => {
    const result = await runConversationTurn(makeDeps(), {
      body: {
        agent: "timer",
        loop: "time-tracker",
        stream: false,
        messages: [{ role: "user", content: "track it" }],
      },
      runtime: {
        surface: "channel",
        source: "channel",
        toolPolicy: { routeAllowedTools: [] },
      },
    });

    expect(result.runStatus).toBe("completed");
    expect(JSON.parse(result.text)).toEqual({
      timing: { start: "100", end: "105" },
    });
  });

  it("fails closed when the Project Loop policy denies a deterministic tool", async () => {
    const execute = vi.fn(async () => "100");
    const deps = makeDeps({
      name: "time-tracker",
      allowedTools: [],
      start: "capture",
      steps: {
        capture: { type: "tool", tool: "unix_time", next: "end" },
      },
    });
    deps.resolveAgentTools = async () => ({
      tools: [{ name: "unix_time" }],
      executor: execute,
    });

    const res = await completionRoutes(() => deps).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "timer",
        loop: "time-tracker",
        messages: [{ role: "user", content: "track it" }],
      }),
    });

    expect(res.status).toBe(403);
    expect(execute).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({
      error: { code: "tool_policy_denied" },
    });
  });

  it("runs an atomic client-tool continuation into a Project Loop through the internal conversation surface", async () => {
    const deps = makeDeps();
    const prepareContinuation = vi.fn(async (input: any) => ({
      status: "prepared" as const,
      sessionVersion: 3,
      runId: input.runId,
      messages: [
        { id: "u1", role: "user", content: "Start", ts: "2026-01-01T00:00:00Z" },
        {
          id: "a1",
          role: "assistant",
          content: "",
          ts: "2026-01-01T00:00:01Z",
          toolCalls: [{
            id: "call-1",
            name: "configure",
            arguments: {},
            state: "completed",
            result: "configured",
          }],
        },
        {
          id: "t1",
          role: "tool",
          content: "configured",
          ts: "2026-01-01T00:00:02Z",
          toolCallId: "call-1",
        },
      ],
    }));
    const addMessage = vi.fn(async (_sessionId, role, content) => ({
      id: `message-${role}`,
      role,
      content,
      ts: new Date().toISOString(),
    }));
    deps.getSessionStore = () => ({
      prepareContinuation,
      addMessage,
      updateMessage: vi.fn(async () => true),
    } as any);

    const result = await runConversationTurn(deps, {
      body: {
        agent: "timer",
        loop: "time-tracker",
        stream: true,
        messages: [{ role: "tool", tool_call_id: "call-1", content: "configured" }],
        polpo: {
          continuation: {
            type: "client_tool",
            tool_call_id: "call-1",
            expected_session_version: 2,
          },
          delivery: { onDisconnect: "continue" },
        },
      },
      sessionId: "session-1",
      continuation: {
        idempotencyKey: "channel-event-1",
        fingerprint: "fingerprint-1",
      },
      runtime: {
        surface: "channel",
        source: "channel",
        channelId: "channel-1",
        requestId: "event-1",
        user: "user-1",
        scope: { key: "site-1", version: "3" },
      },
    } as any);

    expect(result).toMatchObject({
      sessionId: "session-1",
      sessionVersion: 4,
      runStatus: "completed",
    });
    expect(JSON.parse(result.text)).toEqual({
      timing: { start: "100", end: "105" },
    });
    expect(prepareContinuation).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1",
      toolCallId: "call-1",
      expectedSessionVersion: 2,
      idempotencyKey: "channel-event-1",
      user: "user-1",
      scope: { key: "site-1", version: "3" },
    }));
    expect(addMessage).toHaveBeenCalledWith("session-1", "assistant", "");
  });

  it("binds request metadata into the first deterministic tool step without an LLM call", async () => {
    const execute = vi.fn(async (_name: string, args: Record<string, unknown>) =>
      JSON.stringify({ checkedOut: args.projectRef }),
    );
    const deps = makeDeps({
      name: "time-tracker",
      start: "checkout",
      steps: {
        checkout: {
          type: "tool",
          tool: "project_checkout",
          input: {
            projectRef: { $context: "request.metadata.projectRef" },
            createIfMissing: true,
          },
          saveAs: "checkout",
          next: "end",
        },
      },
    });
    deps.getAgents = async () => [{
      name: "timer",
      model: "test",
      assignedLoops: ["time-tracker"],
      allowedTools: ["project_checkout"],
    }];
    const resolveAgentTools = vi.fn(async (
      _agentConfig: any,
      _scope?: unknown,
      _invocation?: unknown,
    ) => ({
      tools: [{
        name: "project_checkout",
        description: "Checkout a project",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            projectRef: { type: "string" },
            createIfMissing: { type: "boolean" },
          },
          required: ["projectRef"],
        },
      }],
      executor: execute,
    }));
    deps.resolveAgentTools = resolveAgentTools;

    const res = await completionRoutes(() => deps).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "timer",
        loop: "time-tracker",
        metadata: { projectRef: "project-123" },
        messages: [{ role: "user", content: "checkout" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(
      "project_checkout",
      { projectRef: "project-123", createIfMissing: true },
      expect.objectContaining({ callId: expect.any(String) }),
    );
    expect(resolveAgentTools.mock.calls[0]?.[2]).toMatchObject({
      surface: "loop",
      metadata: { projectRef: "project-123" },
    });
    expect(Object.isFrozen(resolveAgentTools.mock.calls[0]?.[2])).toBe(true);
    const json = await res.json() as any;
    expect(JSON.parse(json.choices[0].message.content)).toEqual({
      checkout: { checkedOut: "project-123" },
    });
    expect(json.loop_trace).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "tool.call",
        input: { projectRef: "project-123", createIfMissing: true },
      }),
    ]));
  });

  it("fails before tool execution when a request binding is missing", async () => {
    const execute = vi.fn(async () => "must not run");
    const deps = makeDeps({
      name: "time-tracker",
      start: "checkout",
      steps: {
        checkout: {
          type: "tool",
          tool: "project_checkout",
          input: { projectRef: { $context: "request.metadata.projectRef" } },
          next: "end",
        },
      },
    });
    deps.resolveAgentTools = async () => ({ tools: [], executor: execute });

    const res = await completionRoutes(() => deps).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "timer",
        loop: "time-tracker",
        messages: [{ role: "user", content: "checkout" }],
      }),
    });

    expect(res.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({
      error: {
        type: "loop_runtime_error",
        code: "loop_binding_missing",
      },
    });
  });

  it("returns a typed 400 when projected agent input fails its schema before model invocation", async () => {
    const deps = makeDeps({
      name: "time-tracker",
      start: "repair",
      steps: {
        repair: {
          type: "agent",
          input: { failures: [], attempt: 0 },
          inputSchema: {
            type: "object",
            required: ["failures", "attempt"],
            properties: {
              failures: { type: "array", minItems: 1 },
              attempt: { type: "integer", minimum: 1 },
            },
          },
          next: "end",
        },
      },
    });
    const model = vi.fn();
    deps.resolveAgentModel = model as any;

    const res = await completionRoutes(() => deps).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "timer",
        loop: "time-tracker",
        messages: [{ role: "user", content: "repair" }],
      }),
    });

    expect(res.status).toBe(400);
    expect(model).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({
      error: {
        type: "loop_runtime_error",
        code: "loop_agent_input_invalid",
      },
    });
  });

  it("streams a projected agent binding failure without invoking the model", async () => {
    const deps = makeDeps({
      name: "time-tracker",
      start: "repair",
      steps: {
        repair: {
          type: "agent",
          input: { failures: { $context: "validation.failures" } },
          next: "end",
        },
      },
    });
    const model = vi.fn();
    deps.resolveAgentModel = model as any;

    const res = await completionRoutes(() => deps).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "timer",
        loop: "time-tracker",
        stream: true,
        messages: [{ role: "user", content: "repair" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(model).not.toHaveBeenCalled();
    const body = await res.text();
    expect(body).toContain('"code":"loop_binding_missing"');
    expect(body).toContain("[DONE]");
  });

  it("validates resolved values against the tool schema before side effects", async () => {
    const execute = vi.fn(async () => "must not run");
    const deps = makeDeps({
      name: "time-tracker",
      start: "checkout",
      steps: {
        checkout: {
          type: "tool",
          tool: "project_checkout",
          input: { projectRef: { $context: "request.metadata.projectRef" } },
          next: "end",
        },
      },
    });
    deps.resolveAgentTools = async () => ({
      tools: [{
        name: "project_checkout",
        description: "Checkout a project",
        parameters: {
          type: "object",
          properties: { projectRef: { type: "number" } },
          required: ["projectRef"],
        },
      }],
      executor: execute,
    });

    const res = await completionRoutes(() => deps).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "timer",
        loop: "time-tracker",
        metadata: { projectRef: "not-a-number" },
        messages: [{ role: "user", content: "checkout" }],
      }),
    });

    expect(res.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({
      error: {
        type: "loop_runtime_error",
        code: "loop_tool_input_invalid",
      },
    });
  });

  it("uses the full runtime catalog to validate tools hidden behind the router", async () => {
    const execute = vi.fn(async () => "must not run");
    const deps = makeDeps({
      name: "time-tracker",
      start: "checkout",
      steps: {
        checkout: {
          type: "tool",
          tool: "project_checkout",
          input: { projectRef: { $context: "request.metadata.projectRef" } },
          next: "end",
        },
      },
    });
    deps.resolveAgentTools = async () => ({
      tools: [{
        name: "tool_call",
        parameters: {
          type: "object",
          properties: { name: { type: "string" }, args: { type: "object" } },
          required: ["name", "args"],
        },
      }],
      runtimeTools: [{
        name: "project_checkout",
        parameters: {
          type: "object",
          properties: { projectRef: { type: "number" } },
          required: ["projectRef"],
        },
      }],
      executor: async () => "router only",
      runtimeExecutor: execute,
    });

    const res = await completionRoutes(() => deps).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "timer",
        loop: "time-tracker",
        metadata: { projectRef: "not-a-number" },
        messages: [{ role: "user", content: "checkout" }],
      }),
    });

    expect(res.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({
      error: { code: "loop_tool_input_invalid" },
    });
  });

  it("streams resolved request bindings without invoking a model", async () => {
    const execute = vi.fn(async (_name: string, args: Record<string, unknown>) =>
      JSON.stringify({ checkedOut: args.projectRef }),
    );
    const deps = makeDeps({
      name: "time-tracker",
      start: "checkout",
      steps: {
        checkout: {
          type: "tool",
          tool: "project_checkout",
          input: { projectRef: { $context: "request.metadata.projectRef" } },
          saveAs: "checkout",
          next: "end",
        },
      },
    });
    deps.resolveAgentTools = async () => ({
      tools: [],
      executor: execute,
    });

    const res = await completionRoutes(() => deps).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "timer",
        loop: "time-tracker",
        stream: true,
        metadata: { projectRef: "project-stream" },
        messages: [{ role: "user", content: "checkout" }],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(execute).toHaveBeenCalledWith(
      "project_checkout",
      { projectRef: "project-stream" },
      expect.objectContaining({ callId: expect.any(String) }),
    );
    expect(body).toContain("project-stream");
    expect(body).toContain("[DONE]");
  });

  it("streams a typed binding error and never executes the tool", async () => {
    const execute = vi.fn(async () => "must not run");
    const deps = makeDeps({
      name: "time-tracker",
      start: "checkout",
      steps: {
        checkout: {
          type: "tool",
          tool: "project_checkout",
          input: { projectRef: { $context: "request.metadata.projectRef" } },
          next: "end",
        },
      },
    });
    deps.resolveAgentTools = async () => ({ tools: [], executor: execute });

    const res = await completionRoutes(() => deps).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "timer",
        loop: "time-tracker",
        stream: true,
        messages: [{ role: "user", content: "checkout" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(execute).not.toHaveBeenCalled();
    const body = await res.text();
    expect(body).toContain('"code":"loop_binding_missing"');
    expect(body).toContain("[DONE]");
  });

  it("enforces output policy before returning project-loop output", async () => {
    const deps = makeDeps();
    deps.runOutputPolicy = createRunOutputPolicy(new RuntimeGuardrailEngine([{
      id: "redact-loop-output",
      phases: ["output"],
      evaluate: () => ({
        action: "redact",
        risk: "high",
        reason: "sensitive loop result",
        value: "safe loop result",
      }),
    }]));

    const app = completionRoutes(() => deps);
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "timer",
        loop: "time-tracker",
        messages: [{ role: "user", content: "track it" }],
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.choices[0].message.content).toBe("safe loop result");
  });

  it("persists bounded execution-route audit metadata for auto-routed runs", async () => {
    const loopRunStore = new MemoryLoopRunStore();
    const deps = makeDeps();
    deps.getAgents = async () => [{
      name: "timer",
      model: "test",
      assignedLoops: ["time-tracker"],
      executionRouter: {
        mode: "auto",
        allowedLoops: ["time-tracker"],
      },
      allowedTools: ["unix_time"],
    }];
    deps.resolveExecutionRouteClassifier = async () => ({
      classify: async () => ({
        mode: "loop",
        loop: "time-tracker",
        confidence: 0.93,
        reason: "Deterministic timing workflow",
      }),
    });
    deps.getLoopRunStore = () => loopRunStore;

    const app = completionRoutes(() => deps);
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "timer",
        messages: [{ role: "user", content: "PRIVATE REQUEST BODY" }],
      }),
    });

    expect(res.status).toBe(200);
    const runs = await loopRunStore.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].metadata).toMatchObject({
      runtime: "chat.completions",
      surface: "agent",
      source: "request",
      execution: {
        mode: "loop",
        loop: "time-tracker",
        source: "router",
      },
      executionRoute: {
        status: "routed",
        decisionSource: "router",
        confidence: 0.93,
        fallbackUsed: false,
      },
    });
    expect(runs[0].metadata?.executionRoute).not.toHaveProperty("input");
    expect(JSON.stringify(runs[0].metadata)).not.toContain(
      "PRIVATE REQUEST BODY",
    );
  });

  it("does not persist host-trusted tool metadata in public loop records", async () => {
    const loopRunStore = new MemoryLoopRunStore();
    let invocation: unknown;
    const deps = makeDeps({
      name: "private-context",
      start: "audit",
      steps: {
        audit: {
          type: "tool",
          tool: "audit_step",
          next: "end",
        },
      },
    });
    deps.getLoopRunStore = () => loopRunStore;
    deps.resolveAgentTools = async (_agent, _scope, value) => {
      invocation = value;
      return {
        tools: [{
          name: "audit_step",
          parameters: { type: "object", properties: {} },
        }],
        executor: async () => "ok",
      };
    };

    await runProjectLoopCompletion({
      deps,
      agentConfig: { name: "timer", model: "test" },
      projectLoop: await deps.getProjectLoop!("private-context") as any,
      aiMessages: [{ role: "user", content: "run" }],
      extraSystemParts: [],
      runtimeInvocation: {
        surface: "channel",
        source: "channel",
        requestId: "provider-event-1",
        user: "external-user-1",
        scope: { key: "workspace-1", version: "3" },
        metadata: { grant: "secret-grant", tenantId: "tenant-1" },
      },
      user: "external-user-1",
    });

    expect(invocation).toMatchObject({
      surface: "loop",
      user: "external-user-1",
      scope: { key: "workspace-1", version: "3" },
      metadata: { grant: "secret-grant", tenantId: "tenant-1" },
    });
    const runs = await loopRunStore.listRuns();
    expect(JSON.stringify(runs)).not.toContain("secret-grant");
    expect(runs[0]?.metadata?.runtimeInvocation).not.toHaveProperty("metadata");
    expect(runs[0]?.metadata?.runtimeInvocation).not.toHaveProperty("user");
    expect(runs[0]?.metadata?.runtimeInvocation).toMatchObject({
      scope: { key: "workspace-1", version: "3" },
    });
  });

  it("executes deterministic loop tools through the direct runtime executor when model tools are routerized", async () => {
    let runtimeCalls = 0;
    const deps = makeDeps({
      name: "shell-loop",
      context: "shared",
      start: "run_shell",
      steps: {
        run_shell: {
          type: "tool",
          tool: "bash",
          input: { command: "echo ok" },
          saveAs: "shell.output",
          next: "end",
        },
      },
    });
    deps.getAgents = async () => [{
      name: "timer",
      model: "test",
      assignedLoops: ["shell-loop"],
      allowedTools: ["bash"],
    }];
    deps.resolveAgentTools = async () => ({
      tools: [
        {
          name: "tool_call",
          label: "Call Tool",
          parameters: {
            type: "object",
            properties: {
              name: { type: "string" },
              args: { type: "object", additionalProperties: true },
            },
            required: ["name", "args"],
            additionalProperties: false,
          },
        },
      ],
      executor: async (name) =>
        `Error: Tool "${name}" is behind the tool router. Use tool_call with {"name":"${name}","args":{...}}.`,
      runtimeExecutor: async (name, args) => {
        runtimeCalls += 1;
        if (name !== "bash") return `Error: Unknown tool "${name}"`;
        return JSON.stringify({ ok: true, command: args.command });
      },
    });

    const app = completionRoutes(() => deps);
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "timer",
        loop: "shell-loop",
        messages: [{ role: "user", content: "run shell" }],
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(runtimeCalls).toBe(1);
    expect(JSON.parse(json.choices[0].message.content)).toEqual({
      shell: {
        output: {
          ok: true,
          command: "echo ok",
        },
      },
    });
    expect(json.loop_trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "tool.call", tool: "bash" }),
        expect.objectContaining({ type: "tool.result", tool: "bash" }),
      ]),
    );
  });

  it("executes assigned skill tools without duplicating them in static Loop policies", async () => {
    const execute = vi.fn(async (name: string, args: Record<string, unknown>) =>
      JSON.stringify({ name, args, references: ["references/design-system.md"] })
    );
    const deps = makeDeps({
      name: "skill-smoke",
      context: "shared",
      allowedTools: ["read"],
      start: "load_skill",
      steps: {
        load_skill: {
          type: "tool",
          tool: "skill_read",
          input: { name: "frontend-design" },
          saveAs: "skill.bundle",
          next: "end",
        },
      },
    });
    deps.resolveAgentTools = async () => ({
      tools: [{
        name: "skill_read",
        parameters: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
          additionalProperties: false,
        },
      }],
      executor: execute,
    });

    const result = await runProjectLoopCompletion({
      deps,
      agentConfig: {
        name: "timer",
        model: "test",
        skills: ["frontend-design"],
        allowedTools: ["read"],
      },
      projectLoop: await deps.getProjectLoop!("skill-smoke") as any,
      aiMessages: [{ role: "user", content: "load it" }],
      extraSystemParts: [],
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(
      "skill_read",
      { name: "frontend-design" },
      expect.anything(),
    );
    expect(result.context).toMatchObject({
      skill: {
        bundle: {
          name: "skill_read",
          args: { name: "frontend-design" },
          references: ["references/design-system.md"],
        },
      },
    });
  });

  it("enforces the same middleware around deterministic pipeline tool steps", async () => {
    const deps = makeDeps({
      name: "guarded-loop",
      context: "shared",
      start: "audit",
      steps: {
        audit: {
          type: "tool",
          tool: "audit_step",
          input: { source: "raw" },
          saveAs: "audit",
          next: "end",
        },
      },
    });
    deps.getAgents = async () => [{
      name: "timer",
      model: "test",
      assignedLoops: ["guarded-loop"],
      allowedTools: ["audit_step"],
    }];
    deps.runToolMiddleware = createRunToolMiddleware(new RuntimeGuardrailEngine([{
      id: "canonicalize",
      phases: ["tool.before"],
      evaluate: (input) => ({
        action: "rewrite",
        risk: "low",
        reason: "canonical input",
        value: { ...(input.value as Record<string, unknown>), guarded: true },
      }),
    }]));

    const app = completionRoutes(() => deps);
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "timer",
        loop: "guarded-loop",
        messages: [{ role: "user", content: "run it" }],
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(JSON.parse(json.choices[0].message.content)).toEqual({
      audit: {
        ok: true,
        args: { source: "raw", guarded: true },
      },
    });
  });

  it("returns a typed 403 and never dispatches a blocked deterministic tool", async () => {
    const deps = makeDeps();
    const originalResolve = deps.resolveAgentTools;
    const dispatch = vi.fn(async (name: string, args: Record<string, unknown>) =>
      (await originalResolve({})).executor(name, args)
    );
    deps.resolveAgentTools = async () => ({
      tools: [],
      executor: dispatch,
    });
    deps.runToolMiddleware = createRunToolMiddleware(new RuntimeGuardrailEngine([{
      id: "deny",
      phases: ["tool.before"],
      evaluate: () => ({
        action: "block",
        risk: "critical",
        reason: "blocked by policy",
      }),
    }]));

    const app = completionRoutes(() => deps);
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "timer",
        loop: "time-tracker",
        messages: [{ role: "user", content: "track it" }],
      }),
    });

    expect(res.status).toBe(403);
    expect(dispatch).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toEqual({
      error: {
        message: "blocked by policy",
        type: "guardrail_error",
        code: "guardrail_blocked",
      },
    });
  });

  it("continues project loop execution when trace persistence fails", async () => {
    class FailingTraceStore extends MemoryLoopRunStore {
      async appendTrace(_runId: string, _event: LoopTraceEvent): Promise<void> {
        throw new Error("trace db unavailable");
      }
    }

    const diagnostics: { event: string; data: any }[] = [];
    const deps = makeDeps();
    deps.getLoopRunStore = () => new FailingTraceStore();
    deps.emit = (event, data) => diagnostics.push({ event, data });

    const app = completionRoutes(() => deps);
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "timer",
        loop: "time-tracker",
        messages: [{ role: "user", content: "track it" }],
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(JSON.parse(json.choices[0].message.content)).toEqual({
      timing: {
        start: "100",
        end: "105",
      },
    });
    expect(json.loop_run_id).toMatch(/^looprun-/);
    expect(json.loop_trace.map((event: any) => event.type)).toContain("loop.end");
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "loop_run:trace_persist_failed",
          data: expect.objectContaining({
            loop: "time-tracker",
            error: "trace db unavailable",
          }),
        }),
      ]),
    );
  });

  it("retries idempotent terminal persistence after transient database timeouts", async () => {
    class FlakyTerminalStore extends MemoryLoopRunStore {
      completedAttempts = 0;

      override async updateRun(runId: string, patch: any) {
        if (patch.status === "completed") {
          this.completedAttempts += 1;
          if (this.completedAttempts < 3) {
            throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
          }
        }
        return super.updateRun(runId, patch);
      }
    }

    const store = new FlakyTerminalStore();
    const diagnostics: { event: string; data: any }[] = [];
    const deps = makeDeps();
    deps.getLoopRunStore = () => store;
    deps.emit = (event, data) => diagnostics.push({ event, data });

    const app = completionRoutes(() => deps);
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "timer",
        loop: "time-tracker",
        messages: [{ role: "user", content: "track it" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(store.completedAttempts).toBe(3);
    expect((await store.listRuns())[0]?.status).toBe("completed");
    expect(diagnostics.filter(({ event }) => event === "loop_run:persist_retry"))
      .toHaveLength(2);
  });

  it("streams project loop step tool call events", async () => {
    const app = completionRoutes(() => makeDeps());
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "timer",
        loop: "time-tracker",
        stream: true,
        messages: [{ role: "user", content: "track it" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-loop")).toBe("time-tracker");
    const body = await res.text();
    const chunks = body
      .split("\n\n")
      .map((block) => block.trim())
      .filter((block) => block.startsWith("data: "))
      .map((block) => block.slice("data: ".length))
      .filter((data) => data !== "[DONE]")
      .map((data) => JSON.parse(data));
    const toolEvents = chunks
      .map((chunk) => chunk.choices?.[0]?.tool_call)
      .filter(Boolean);
    const traceEvents = chunks
      .map((chunk) => chunk.choices?.[0]?.loop_trace)
      .filter(Boolean);

    expect(toolEvents.map((event: any) => event.state)).toContain("calling");
    expect(toolEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "unix_time", result: "100", state: "completed" }),
        expect.objectContaining({ name: "unix_time", result: "105", state: "completed" }),
      ]),
    );
    expect(traceEvents.map((event: any) => event.type)).toContain("tool.call");
    expect(traceEvents.map((event: any) => event.type)).toContain("loop.end");
  });

  it("executes project loop hook tool actions through the completion runtime", async () => {
    const app = completionRoutes(() => makeDeps({
      name: "time-tracker",
      context: "shared",
      start: "capture_start",
      hooks: {
        "tool:after": [{ tool: "audit_step", input: { source: "hook" }, saveAs: "audit.last" }],
      },
      steps: {
        capture_start: {
          type: "tool",
          tool: "unix_time",
          saveAs: "timing.start",
          next: "end",
        },
      },
    }));

    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "timer",
        loop: "time-tracker",
        messages: [{ role: "user", content: "track it" }],
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(JSON.parse(json.choices[0].message.content)).toMatchObject({
      timing: { start: "100" },
      audit: { last: { ok: true, args: { source: "hook" } } },
    });
    expect(json.loop_trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "tool.call", tool: "audit_step", data: expect.objectContaining({ hook: "tool:after" }) }),
        expect.objectContaining({ type: "tool.result", tool: "audit_step", data: expect.objectContaining({ hook: "tool:after" }) }),
      ]),
    );
  });

  it("blocks project loop execution when a runtime policy denies a lifecycle point", async () => {
    const app = completionRoutes(() => makeDeps({
      name: "time-tracker",
      context: "shared",
      start: "capture_start",
      policies: [
        { id: "block-time", effect: "deny", hook: "tool:before", when: "tool.name == 'unix_time'", message: "time capture disabled" },
      ],
      steps: {
        capture_start: {
          type: "tool",
          tool: "unix_time",
          saveAs: "timing.start",
          next: "end",
        },
      },
    }));

    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "timer",
        loop: "time-tracker",
        messages: [{ role: "user", content: "track it" }],
      }),
    });

    expect(res.status).toBe(403);
    const json = await res.json() as any;
    expect(json.error).toMatchObject({
      type: "loop_runtime_error",
      code: "loop_policy_blocked",
      message: 'Loop policy "block-time" denied tool:before: time capture disabled',
    });
  });
});
