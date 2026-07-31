import { describe, expect, it, vi } from "vitest";
import {
  createRuntimePlan,
  type ExecutionRouteClassifier,
  type RuntimePlan,
} from "@polpo-ai/core";
import {
  prepareChatCompletionExecution,
  type CompletionRouteDeps,
} from "../completions.js";

function routeClassifier(decision: unknown): ExecutionRouteClassifier {
  return {
    classify: async () => decision,
  };
}

function makePlan(
  execution: RuntimePlan["execution"],
  surface: RuntimePlan["surface"] = "agent",
  source: RuntimePlan["source"] = "request",
): RuntimePlan {
  return createRuntimePlan({
    surface,
    source,
    execution,
    model: { selection: "mock", source: "agent" },
  }, {
    createId: () => "plan-route",
    now: () => "2026-07-28T12:00:00.000Z",
  });
}

function makeDeps(overrides: Partial<CompletionRouteDeps> = {}): CompletionRouteDeps {
  return {
    getAgents: async () => [{
      name: "agent-1",
      model: "mock",
      allowedTools: ["read"],
      assignedLoops: ["research", "build"],
      executionRouter: {
        mode: "auto",
        allowedLoops: ["research", "build"],
      },
    }],
    getConfig: () => ({}),
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
    buildAgentPrompt: async () => "agent prompt",
    resolveAgentTools: async () => ({
      tools: [],
      executor: async () => "ok",
    }),
    getProjectLoop: async (name) => ({
      name,
      label: name === "research" ? "Research" : "Build",
      description: name === "research"
        ? "Investigate sources."
        : "Create project files.",
      metadata: { secret: "PRIVATE LOOP METADATA" },
      start: "run",
      steps: {
        run: {
          type: "agent",
          systemPrompt: "PRIVATE LOOP PROMPT",
          tools: ["bash"],
          next: "end",
        },
      },
    }),
    resolveExecutionRouteClassifier: async () =>
      routeClassifier({
        mode: "loop",
        loop: "research",
        confidence: 0.95,
        reason: "Research workflow requested",
      }),
    ...overrides,
  };
}

describe("completion execution router", () => {
  it("routes chat requests from caller-supplied bounded labels without classifier work", async () => {
    const resolveExecutionRouteClassifier = vi.fn();
    const prepared = await prepareChatCompletionExecution(makeDeps({
      getAgents: async () => [{
        name: "agent-1",
        model: "mock",
        allowedTools: ["read"],
        assignedLoops: ["research", "build"],
        executionRouter: {
          mode: "auto",
          allowedLoops: ["research", "build"],
          rules: [{
            id: "paid-build",
            mode: "loop",
            loop: "build",
            when: {
              surfaces: ["agent"],
              allLabels: ["plan:paid"],
            },
          }],
        },
      }],
      resolveExecutionRouteClassifier,
    }), {
      agent: "agent-1",
      messages: [{ role: "user", content: "Build an export" }],
      routing: { labels: ["plan:paid"] },
      stream: false,
    });

    expect(prepared.kind).toBe("project-loop");
    if (prepared.kind !== "project-loop") throw new Error("Expected project loop");
    expect(prepared.executionRoute).toMatchObject({
      status: "routed",
      mode: "loop",
      loop: "build",
      reason: 'Matched execution router rule "paid-build"',
    });
    expect(resolveExecutionRouteClassifier).not.toHaveBeenCalled();
  });

  it("routes to an assigned project loop before prompt, model, tools, or session writes", async () => {
    const calls: string[] = [];
    const emit = vi.fn((event: string) => calls.push(`emit:${event}`));
    const sessionStore = {
      create: vi.fn(async () => {
        calls.push("session:create");
        return "session-1";
      }),
      addMessage: vi.fn(async () => {
        calls.push("session:message");
      }),
    };
    const resolveRuntimePlan = vi.fn(async (input) => {
      calls.push("plan");
      expect(input.execution).toEqual({
        mode: "loop",
        loop: "research",
        source: "router",
      });
      return makePlan(input.execution, input.surface, input.source);
    });
    const resolveExecutionRouteClassifier = vi.fn(async () => ({
      classify: async (input: unknown) => {
        calls.push("classify");
        expect(input).toEqual({
          version: 1,
          surface: "channel",
          source: "channel",
          input: "Please research the market",
          loops: [
            {
              name: "research",
              label: "Research",
              description: "Investigate sources.",
            },
            {
              name: "build",
              label: "Build",
              description: "Create project files.",
            },
          ],
          labels: [],
        });
        expect(JSON.stringify(input)).not.toContain("PRIVATE");
        expect(JSON.stringify(input)).not.toContain("bash");
        return {
          mode: "loop",
          loop: "research",
          confidence: 0.95,
          reason: "Research workflow requested",
        };
      },
    }));
    const deps = makeDeps({
      emit,
      getSessionStore: () => sessionStore,
      resolveRuntimePlan,
      buildAgentPrompt: async () => {
        calls.push("prompt");
        return "prompt";
      },
      resolveAgentModel: async () => {
        calls.push("model");
        throw new Error("project loop must not resolve the root model");
      },
      resolveAgentTools: async () => {
        calls.push("tools");
        throw new Error("project loop must not resolve tools during preparation");
      },
      resolveExecutionRouteClassifier,
    });
    const headers = new Map<string, string>();

    const prepared = await prepareChatCompletionExecution(deps, {
      agent: "agent-1",
      user: "external-user-1",
      messages: [
        { role: "user", content: "Old request is not classifier history" },
        { role: "assistant", content: "Old answer" },
        { role: "user", content: "Please research the market" },
      ],
      stream: false,
    }, {
      runtime: { surface: "channel", source: "channel" },
      setHeader: (name, value) => headers.set(name, value),
    });

    expect(prepared.kind).toBe("project-loop");
    if (prepared.kind !== "project-loop") throw new Error("Expected project loop");
    expect(prepared.projectLoop.name).toBe("research");
    expect(prepared.executionRoute).toMatchObject({
      mode: "loop",
      loop: "research",
      decisionSource: "router",
    });
    expect(headers.get("x-loop")).toBe("research");
    expect(resolveExecutionRouteClassifier).toHaveBeenCalledWith({
      surface: "channel",
      source: "channel",
      agentName: "agent-1",
      userId: "external-user-1",
    });
    expect(resolveRuntimePlan).toHaveBeenCalledOnce();
    expect(calls).toEqual([
      "classify",
      "emit:runtime:execution-route",
      "plan",
      "emit:runtime:plan",
      "session:create",
      "session:message",
    ]);
  });

  it("composes automatic loop routing with one scoped runtime-context snapshot", async () => {
    const calls: string[] = [];
    const retrieve = vi.fn(async (input) => {
      calls.push("retrieve");
      expect(input).toMatchObject({
        agentName: "agent-1",
        query: "Please research the customer's launch",
        surface: "channel",
        source: "channel",
        externalUserId: "external-user-1",
        channelId: "telegram-1",
      });
      return {
        segments: [{
          kind: "memory" as const,
          entries: [{
            id: "memory-1",
            content: "The customer launches on Friday.",
            source: { type: "memory" as const, id: "memory-1" },
            timestamp: "2026-07-29T12:00:00.000Z",
            trust: "user_provided" as const,
          }],
        }],
      };
    });
    const prepared = await prepareChatCompletionExecution(makeDeps({
      resolveExecutionRouteClassifier: async () => ({
        classify: async () => {
          calls.push("classify");
          return {
            mode: "loop",
            loop: "research",
            confidence: 0.95,
            reason: "Research workflow requested",
          };
        },
      }),
      resolveRuntimePlan: async (input) => {
        calls.push("plan");
        return makePlan(input.execution, input.surface, input.source);
      },
      runtimeContext: { tokenBudget: 1_000, retrieve },
    }), {
      agent: "agent-1",
      user: "external-user-1",
      messages: [{
        role: "user",
        content: "Please research the customer's launch",
      }],
      stream: false,
    }, {
      runtime: {
        surface: "channel",
        source: "channel",
        channelId: "telegram-1",
      },
    });

    expect(prepared.kind).toBe("project-loop");
    if (prepared.kind !== "project-loop") throw new Error("Expected project loop");
    expect(prepared.executionRoute).toMatchObject({
      mode: "loop",
      loop: "research",
      decisionSource: "router",
    });
    expect(prepared.runtimeContext?.segments[0]?.entries[0]?.id).toBe("memory-1");
    expect(prepared.runtimeInvocation).toEqual({
      surface: "channel",
      source: "channel",
      channelId: "telegram-1",
    });
    expect(retrieve).toHaveBeenCalledOnce();
    expect(calls).toEqual(["classify", "plan", "retrieve"]);
  });

  it("keeps a confident direct route on the normal chat path", async () => {
    const getProjectLoop = vi.fn(makeDeps().getProjectLoop);
    const deps = makeDeps({
      getProjectLoop,
      resolveExecutionRouteClassifier: async () =>
        routeClassifier({
          mode: "direct",
          confidence: 0.99,
          reason: "A normal answer is sufficient",
        }),
    });

    const prepared = await prepareChatCompletionExecution(deps, {
      agent: "agent-1",
      messages: [{ role: "user", content: "Say hello" }],
      stream: false,
    });

    expect(prepared.kind).toBe("chat");
    if (prepared.kind !== "chat") throw new Error("Expected chat");
    expect(prepared.execution.executionRoute).toMatchObject({
      mode: "direct",
      decisionSource: "router",
    });
    expect(getProjectLoop).toHaveBeenCalledTimes(2);
  });

  it("lets an explicit authorized loop win and never creates a classifier", async () => {
    const resolveExecutionRouteClassifier = vi.fn();
    const headers = new Map<string, string>();
    const prepared = await prepareChatCompletionExecution(makeDeps({
      resolveExecutionRouteClassifier,
    }), {
      agent: "agent-1",
      loop: "build",
      messages: [{ role: "user", content: "Do it" }],
      stream: false,
    }, {
      setHeader: (name, value) => headers.set(name, value),
    });

    expect(prepared.kind).toBe("project-loop");
    if (prepared.kind !== "project-loop") throw new Error("Expected project loop");
    expect(prepared.projectLoop.name).toBe("build");
    expect(prepared.executionRoute).toMatchObject({
      status: "explicit",
      mode: "loop",
      loop: "build",
      decisionSource: "request",
    });
    expect(headers.get("x-loop")).toBe("build");
    expect(resolveExecutionRouteClassifier).not.toHaveBeenCalled();
  });

  it("does no router work when configuration is absent or off", async () => {
    const getProjectLoop = vi.fn();
    const resolveExecutionRouteClassifier = vi.fn();
    const emit = vi.fn();
    const deps = makeDeps({
      getAgents: async () => [{
        name: "agent-1",
        model: "mock",
        assignedLoops: ["research"],
      }],
      getProjectLoop,
      resolveExecutionRouteClassifier,
      emit,
    });

    const prepared = await prepareChatCompletionExecution(deps, {
      agent: "agent-1",
      messages: [{ role: "user", content: "Research this" }],
      stream: false,
    });

    expect(prepared.kind).toBe("chat");
    if (prepared.kind !== "chat") throw new Error("Expected chat");
    expect(prepared.execution.executionRoute).toBeUndefined();
    expect(getProjectLoop).not.toHaveBeenCalled();
    expect(resolveExecutionRouteClassifier).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalledWith(
      "runtime:execution-route",
      expect.anything(),
    );
  });

  it("falls back to direct when every allowed assigned loop is missing", async () => {
    const resolveExecutionRouteClassifier = vi.fn();
    const emit = vi.fn();
    const deps = makeDeps({
      getProjectLoop: async () => null,
      resolveExecutionRouteClassifier,
      emit,
    });

    const prepared = await prepareChatCompletionExecution(deps, {
      agent: "agent-1",
      messages: [{ role: "user", content: "Research this" }],
      stream: false,
    });

    expect(prepared.kind).toBe("chat");
    if (prepared.kind !== "chat") throw new Error("Expected chat");
    expect(prepared.execution.executionRoute).toMatchObject({
      mode: "direct",
      status: "skipped",
      fallbackUsed: false,
    });
    expect(resolveExecutionRouteClassifier).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(
      "runtime:execution-route",
      expect.objectContaining({
        route: expect.objectContaining({ mode: "direct" }),
      }),
    );
  });

  it("fails closed when a runtime planner contradicts the validated route", async () => {
    const buildAgentPrompt = vi.fn();
    const resolveAgentModel = vi.fn();
    const resolveAgentTools = vi.fn();
    const sessionStore = { create: vi.fn(), addMessage: vi.fn() };
    const deps = makeDeps({
      resolveExecutionRouteClassifier: async () =>
        routeClassifier({
          mode: "direct",
          confidence: 0.99,
          reason: "Direct",
        }),
      resolveRuntimePlan: async () => makePlan({
        mode: "loop",
        loop: "research",
        source: "router",
      }),
      buildAgentPrompt,
      resolveAgentModel,
      resolveAgentTools,
      getSessionStore: () => sessionStore,
    });

    const prepared = await prepareChatCompletionExecution(deps, {
      agent: "agent-1",
      messages: [{ role: "user", content: "Say hello" }],
      stream: false,
    });

    expect(prepared).toMatchObject({
      kind: "error",
      status: 500,
      body: {
        error: {
          code: "runtime_planning_failed",
        },
      },
    });
    expect(buildAgentPrompt).not.toHaveBeenCalled();
    expect(resolveAgentModel).not.toHaveBeenCalled();
    expect(resolveAgentTools).not.toHaveBeenCalled();
    expect(sessionStore.create).not.toHaveBeenCalled();
  });

  it("never allows a classifier to select an unassigned loop", async () => {
    const prepared = await prepareChatCompletionExecution(makeDeps({
      resolveExecutionRouteClassifier: async () =>
        routeClassifier({
          mode: "loop",
          loop: "admin",
          confidence: 1,
          reason: "Attempted widening",
        }),
    }), {
      agent: "agent-1",
      messages: [{ role: "user", content: "Run admin" }],
      stream: false,
    });

    expect(prepared.kind).toBe("chat");
    if (prepared.kind !== "chat") throw new Error("Expected safe direct fallback");
    expect(prepared.execution.executionRoute).toMatchObject({
      mode: "direct",
      status: "fallback",
      fallbackUsed: true,
    });
  });

  it("rejects malformed router settings before loading manifests", async () => {
    const getProjectLoop = vi.fn();
    const prepared = await prepareChatCompletionExecution(makeDeps({
      getAgents: async () => [{
        name: "agent-1",
        model: "mock",
        assignedLoops: ["research"],
        executionRouter: {
          mode: "auto",
          allowedLoops: [],
        },
      }],
      getProjectLoop,
    }), {
      agent: "agent-1",
      messages: [{ role: "user", content: "Research this" }],
      stream: false,
    });

    expect(prepared).toMatchObject({
      kind: "error",
      status: 500,
      body: {
        error: {
          code: "runtime_execution_routing_failed",
        },
      },
    });
    expect(getProjectLoop).not.toHaveBeenCalled();
  });
});
