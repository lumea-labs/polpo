import { describe, expect, it, vi } from "vitest";
import {
  MemoryLoopRunStore,
  RuntimeGuardrailEngine,
  createRunOutputPolicy,
  createRunToolMiddleware,
  type LoopTraceEvent,
} from "@polpo-ai/core";
import { completionRoutes, type CompletionRouteDeps } from "./completions.js";

describe("completionRoutes project loop runtime", () => {
  function makeDeps(projectLoop?: any): CompletionRouteDeps {
    let now = 100;
    return {
      getAgents: async () => [{
        name: "timer",
        model: "test",
        assignedLoops: ["time-tracker"],
        allowedTools: ["unix_time"],
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
