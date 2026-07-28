import { describe, expect, it, vi } from "vitest";
import {
  createRuntimePlan,
  type RuntimePlan,
} from "@polpo-ai/core";
import {
  completionRoutes,
  prepareChatCompletionExecution,
  type CompletionRouteDeps,
} from "../completions.js";
import { buildChatRunInjection } from "./chat-via-run-handler.js";

function makePlan(): RuntimePlan {
  return createRuntimePlan(
    {
      surface: "channel",
      source: "channel",
      model: { selection: "mock", source: "agent" },
      tools: { allowed: ["bash"] },
      audit: { planner: "test-planner" },
    },
    {
      createId: () => "plan-1",
      now: () => new Date("2026-07-28T10:00:00.000Z"),
    },
  );
}

function makeDeps(overrides: Partial<CompletionRouteDeps> = {}): CompletionRouteDeps {
  return {
    getAgents: async () => [{
      name: "agent-1",
      model: "mock",
      systemPrompt: "private prompt",
      allowedTools: ["bash"],
    }],
    getConfig: () => ({ settings: { chatExecution: "run" } }),
    getMemoryStore: () => null,
    getSessionStore: () => null,
    getStore: () => null,
    emit: () => {},
    resolveAgentModel: async () => ({
      model: {
        id: "mock",
        name: "Mock",
        provider: "mock",
        runtimeMode: "provider",
        aiModel: {} as any,
        contextWindow: 200_000,
        maxTokens: 8_192,
      },
    }),
    buildAgentPrompt: async () => "private prompt",
    resolveAgentTools: async () => ({
      tools: [],
      executor: async () => "ok",
    }),
    runChatViaRun: async () => ({
      status: "completed",
      result: { exitCode: 0, stdout: "", stderr: "" },
    }),
    ...overrides,
  };
}

describe("completion runtime plan hook", () => {
  it("plans with the semantic profile, then resolves a concrete model before provider adaptation", async () => {
    const planningInputs: unknown[] = [];
    const resolvedAgentConfigs: any[] = [];
    const deps = makeDeps({
      getAgents: async () => [{
        name: "agent-1",
        model: { profile: "balanced" },
        allowedModelProfiles: ["balanced", "fast"],
      }],
      getConfig: () => ({
        settings: {
          chatExecution: "run",
          modelProfiles: {
            fast: "openai/gpt-4o-mini",
            balanced: {
              primary: "anthropic/claude-sonnet-4",
              fallbacks: [{ profile: "fast" }],
            },
          },
        },
      }),
      resolveRuntimePlan: async (input) => {
        planningInputs.push(input);
        return makePlan();
      },
      resolveAgentModel: async (agentConfig) => {
        resolvedAgentConfigs.push(agentConfig);
        return {
          model: {
            id: "claude-sonnet-4",
            name: "Claude Sonnet 4",
            provider: "anthropic",
            aiModel: {} as any,
            contextWindow: 200_000,
            maxTokens: 8_192,
          },
        };
      },
    });

    const prepared = await prepareChatCompletionExecution(deps, {
      agent: "agent-1",
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    });

    expect(prepared.kind).toBe("chat");
    if (prepared.kind !== "chat") throw new Error("Expected chat preparation");
    expect((planningInputs[0] as any).agent.model).toEqual({ profile: "balanced" });
    expect(resolvedAgentConfigs[0].model).toBe("anthropic/claude-sonnet-4");
    expect(prepared.execution.modelSelection).toEqual({
      primary: "anthropic/claude-sonnet-4",
      fallbacks: ["openai/gpt-4o-mini"],
    });
  });

  it("runs after agent/loop authorization and before prompt, model, and tool resolution", async () => {
    const calls: string[] = [];
    const plan = makePlan();
    const emit = vi.fn((event: string) => {
      calls.push(`emit:${event}`);
    });
    const resolveRuntimePlan = vi.fn(async (input) => {
      calls.push("plan");
      expect(Object.isFrozen(input)).toBe(true);
      expect(Object.isFrozen(input.agent)).toBe(true);
      expect(Object.isFrozen(input.agent?.allowedTools)).toBe(true);
      expect(input).toEqual({
        surface: "channel",
        source: "channel",
        execution: {
          mode: "direct",
          source: "default",
        },
        request: {
          agent: "agent-1",
          sandbox: undefined,
        },
        agent: {
          name: "agent-1",
          model: "mock",
          sandbox: undefined,
          allowedTools: ["bash"],
        },
      });
      expect(JSON.stringify(input)).not.toContain("private prompt");
      expect(JSON.stringify(input)).not.toContain("hello from telegram");
      expect(JSON.stringify(input)).not.toContain("untrusted/request-override");
      return plan;
    });
    const deps = makeDeps({
      emit,
      resolveRuntimePlan,
      buildRuntimePrompt: async () => {
        calls.push("prompt");
        return "runtime prompt";
      },
      resolveAgentModel: async () => {
        calls.push("model");
        return {
          model: {
            id: "mock",
            name: "Mock",
            provider: "mock",
            runtimeMode: "provider",
            aiModel: {} as any,
            contextWindow: 200_000,
            maxTokens: 8_192,
          },
        };
      },
      resolveAgentTools: async () => {
        calls.push("tools");
        return { tools: [], executor: async () => "ok" };
      },
    });

    const prepared = await prepareChatCompletionExecution(deps, {
      agent: "agent-1",
      model: "untrusted/request-override",
      stream: false,
      metadata: { source: "channel", provider: "telegram" },
      messages: [{ role: "user", content: "hello from telegram" }],
    }, {
      runtime: { surface: "channel", source: "channel" },
    });

    expect(prepared.kind).toBe("chat");
    if (prepared.kind !== "chat") throw new Error("Expected chat preparation");
    expect(calls).toEqual(["plan", "emit:runtime:plan", "prompt", "model", "tools"]);
    expect(emit).toHaveBeenCalledWith("runtime:plan", {
      type: "runtime.plan.resolved",
      plan,
    });
    expect(prepared.execution.runtimePlan).toEqual(plan);
    expect(buildChatRunInjection(prepared.execution).runtimePlan).toBe(
      prepared.execution.runtimePlan,
    );
  });

  it("plans an authorized loop from its effective, overlaid agent settings", async () => {
    const resolveRuntimePlan = vi.fn(async (input) => {
      expect(input).toMatchObject({
        surface: "agent",
        source: "request",
        execution: {
          mode: "loop",
          loop: "research",
          source: "request",
        },
        request: {
          agent: "agent-1",
          loop: "research",
        },
        agent: {
          name: "agent-1",
          model: "research-model",
          allowedTools: ["read"],
        },
      });
      expect(JSON.stringify(input)).not.toContain("private loop prompt");
      return createRuntimePlan(
        {
          surface: "agent",
          source: "request",
          execution: { mode: "loop", loop: "research", source: "request" },
          model: { selection: "research-model", source: "agent" },
          tools: { allowed: ["read"] },
        },
        {
          createId: () => "plan-loop",
          now: () => new Date("2026-07-28T10:00:00.000Z"),
        },
      );
    });
    const deps = makeDeps({
      getAgents: async () => [{
        name: "agent-1",
        model: "mock",
        allowedTools: ["bash"],
        loops: {
          research: {
            model: "research-model",
            tools: ["read"],
            systemPrompt: "private loop prompt",
          },
        },
      }],
      resolveRuntimePlan,
    });

    const prepared = await prepareChatCompletionExecution(deps, {
      agent: "agent-1",
      loop: "research",
      stream: false,
      messages: [{ role: "user", content: "research this" }],
    });

    expect(prepared.kind).toBe("chat");
    expect(resolveRuntimePlan).toHaveBeenCalledOnce();
  });

  it("does not invoke planning for a missing agent or unauthorized loop", async () => {
    const resolveRuntimePlan = vi.fn(async () => makePlan());
    const deps = makeDeps({ resolveRuntimePlan });

    const missingAgent = await prepareChatCompletionExecution(deps, {
      agent: "missing",
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    });
    const missingLoop = await prepareChatCompletionExecution(deps, {
      agent: "agent-1",
      loop: "not-authorized",
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    });

    expect(missingAgent).toMatchObject({ kind: "error", status: 404 });
    expect(missingLoop).toMatchObject({ kind: "error", status: 400 });
    expect(resolveRuntimePlan).not.toHaveBeenCalled();
  });

  it("plans orchestrator mode before resolving its prompt, model, or tools", async () => {
    const calls: string[] = [];
    const plan = createRuntimePlan(
      {
        surface: "agent",
        source: "request",
        model: { selection: "orchestrator-model", source: "project" },
      },
      {
        createId: () => "plan-orchestrator",
        now: () => new Date("2026-07-28T10:00:00.000Z"),
      },
    );
    const deps = makeDeps({
      resolveRuntimePlan: async (input) => {
        calls.push("plan");
        expect(input).toEqual({
          surface: "agent",
          source: "request",
          execution: { mode: "direct", source: "default" },
          request: { sandbox: undefined },
        });
        return plan;
      },
      resolveOrchestratorContext: async () => {
        calls.push("orchestrator");
        return {
          systemPrompt: "private orchestrator prompt",
          model: {
            id: "orchestrator-model",
            name: "Orchestrator",
            provider: "mock",
            runtimeMode: "provider",
            aiModel: {} as any,
            contextWindow: 200_000,
            maxTokens: 8_192,
          },
          tools: [],
          executor: async () => "ok",
          isInteractive: () => false,
        };
      },
    });

    const prepared = await prepareChatCompletionExecution(deps, {
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    });

    expect(prepared.kind).toBe("chat");
    expect(calls).toEqual(["plan", "orchestrator"]);
    if (prepared.kind !== "chat") throw new Error("Expected chat preparation");
    expect(prepared.execution.runtimePlan).toEqual(plan);
  });

  it("plans assigned project loops without resolving their tools early", async () => {
    const resolveAgentTools = vi.fn();
    const plan = createRuntimePlan(
      {
        surface: "agent",
        source: "request",
        execution: { mode: "loop", loop: "pipeline", source: "request" },
        model: { selection: "mock", source: "agent" },
      },
      {
        createId: () => "plan-project-loop",
        now: () => new Date("2026-07-28T10:00:00.000Z"),
      },
    );
    const deps = makeDeps({
      getAgents: async () => [{
        name: "agent-1",
        model: "mock",
        assignedLoops: ["pipeline"],
      }],
      getProjectLoop: async () => ({
        name: "pipeline",
        start: "done",
        steps: { done: { type: "agent", next: "end" } },
      }),
      resolveRuntimePlan: async () => plan,
      resolveAgentTools,
    });

    const prepared = await prepareChatCompletionExecution(deps, {
      agent: "agent-1",
      loop: "pipeline",
      stream: false,
      messages: [{ role: "user", content: "run" }],
    });

    expect(prepared.kind).toBe("project-loop");
    if (prepared.kind !== "project-loop") throw new Error("Expected project loop");
    expect(prepared.runtimePlan).toEqual(plan);
    expect(resolveAgentTools).not.toHaveBeenCalled();
  });

  it("does not plan or emit anything when the optional hook is absent", async () => {
    const emit = vi.fn();
    const deps = makeDeps({ emit });

    const prepared = await prepareChatCompletionExecution(deps, {
      agent: "agent-1",
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    });

    expect(prepared.kind).toBe("chat");
    if (prepared.kind !== "chat") throw new Error("Expected chat preparation");
    expect(prepared.execution.runtimePlan).toBeUndefined();
    expect(buildChatRunInjection(prepared.execution).runtimePlan).toBeUndefined();
    expect(emit).not.toHaveBeenCalledWith("runtime:plan", expect.anything());
  });

  it("fails closed before prompt, model, tools, or session writes when planning fails", async () => {
    const buildAgentPrompt = vi.fn(async () => "prompt");
    const resolveAgentModel = vi.fn();
    const resolveAgentTools = vi.fn();
    const sessionStore = {
      create: vi.fn(),
      addMessage: vi.fn(),
    };
    const deps = makeDeps({
      resolveRuntimePlan: async () => {
        throw new Error("classifier timed out with secret detail");
      },
      buildAgentPrompt,
      resolveAgentModel,
      resolveAgentTools,
      getSessionStore: () => sessionStore,
    });

    const prepared = await prepareChatCompletionExecution(deps, {
      agent: "agent-1",
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    });

    expect(prepared).toEqual({
      kind: "error",
      status: 500,
      body: {
        error: {
          message: "Runtime planning failed",
          type: "server_error",
          code: "runtime_planning_failed",
        },
      },
    });
    expect(buildAgentPrompt).not.toHaveBeenCalled();
    expect(resolveAgentModel).not.toHaveBeenCalled();
    expect(resolveAgentTools).not.toHaveBeenCalled();
    expect(sessionStore.create).not.toHaveBeenCalled();
    expect(sessionStore.addMessage).not.toHaveBeenCalled();
  });

  it("never invokes the planner before HTTP authentication and request validation", async () => {
    const resolveRuntimePlan = vi.fn(async () => makePlan());
    const app = completionRoutes(
      () => makeDeps({ resolveRuntimePlan }),
      ["valid-key"],
    );

    const unauthorized = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "agent-1",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    const invalid = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer valid-key",
      },
      body: JSON.stringify({ agent: "agent-1", messages: [] }),
    });

    expect(unauthorized.status).toBe(401);
    expect(invalid.status).toBe(400);
    expect(resolveRuntimePlan).not.toHaveBeenCalled();
  });

  it("does not trust caller-controlled metadata when classifying an HTTP surface", async () => {
    const resolveRuntimePlan = vi.fn(async (input) => {
      expect(input.surface).toBe("agent");
      expect(input.source).toBe("request");
      return createRuntimePlan(
        {
          surface: input.surface,
          source: input.source,
          model: { selection: "mock", source: "agent" },
        },
        {
          createId: () => "plan-http",
          now: () => new Date("2026-07-28T10:00:00.000Z"),
        },
      );
    });
    const app = completionRoutes(() => makeDeps({ resolveRuntimePlan }));

    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "agent-1",
        stream: false,
        metadata: { source: "channel", provider: "telegram" },
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(response.status).toBe(200);
    expect(resolveRuntimePlan).toHaveBeenCalledOnce();
  });
});
