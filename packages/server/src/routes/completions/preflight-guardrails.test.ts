import { describe, expect, it, vi } from "vitest";
import {
  RuntimeGuardrailEngine,
  createConfiguredRunOutputPolicy,
  createConfiguredRunPreflightPolicy,
  createConfiguredRunToolMiddleware,
  createRunPreflightPolicy,
} from "@polpo-ai/core/guardrails";
import {
  prepareChatCompletionExecution,
  type CompletionRouteDeps,
} from "../completions.js";

function deps(overrides: Partial<CompletionRouteDeps> = {}): CompletionRouteDeps {
  return {
    getAgents: async () => [{
      name: "support",
      model: "mock",
      systemPrompt: "Base prompt",
    }],
    getConfig: () => ({ settings: {} }),
    getMemoryStore: () => null,
    getSessionStore: () => null,
    getStore: () => null,
    emit: () => {},
    resolveAgentModel: async () => ({
      model: {
        id: "mock",
        provider: "mock",
        aiModel: {} as any,
        contextWindow: 200_000,
        maxTokens: 8_192,
      },
    }),
    buildRuntimePrompt: async () => "Base runtime prompt",
    buildAgentPrompt: async () => "Base prompt",
    resolveAgentTools: async () => ({
      tools: [],
      executor: async () => "ok",
    }),
    ...overrides,
  };
}

describe("completion preflight guardrails", () => {
  it("resolves a strict request policy before input guardrails and session writes", async () => {
    const addMessage = vi.fn();
    const resolveRuntimeGuardrails = vi.fn((request) => {
      expect(request).toEqual({ policyPack: "strict" });
      const settings = { policyPack: "strict" as const };
      const runPreflightPolicy = createConfiguredRunPreflightPolicy(settings);
      const runToolMiddleware = createConfiguredRunToolMiddleware(settings);
      const runOutputPolicy = createConfiguredRunOutputPolicy(settings);
      if (!runPreflightPolicy || !runToolMiddleware || !runOutputPolicy) {
        throw new Error("Expected strict guardrail hooks");
      }
      return {
        runPreflightPolicy,
        runToolMiddleware,
        runOutputPolicy,
      };
    });
    const prepared = await prepareChatCompletionExecution(deps({
      resolveRuntimeGuardrails,
      getSessionStore: () => ({
        create: async () => "session-1",
        addMessage,
      }),
    }), {
      agent: "support",
      stream: false,
      guardrails: { policyPack: "strict" },
      messages: [{
        role: "user",
        content: "token ghp_abcdefghijklmnopqrstuvwxyz1234567890",
      }],
    });

    expect(resolveRuntimeGuardrails).toHaveBeenCalledOnce();
    expect(prepared.kind).toBe("chat");
    expect(addMessage).toHaveBeenCalledWith(
      "session-1",
      "user",
      "token [REDACTED]",
    );
    if (prepared.kind !== "chat") throw new Error("Expected chat");
    expect(prepared.execution.deps.runToolMiddleware).toBeDefined();
    expect(prepared.execution.deps.runOutputPolicy).toBeDefined();
  });

  it("rejects request policy resolution failures before runtime side effects", async () => {
    const resolveAgentModel = vi.fn();
    const resolveAgentTools = vi.fn();
    const create = vi.fn();
    const addMessage = vi.fn();
    const prepared = await prepareChatCompletionExecution(deps({
      resolveRuntimeGuardrails: () => {
        throw new TypeError("Project guardrails are not configured");
      },
      resolveAgentModel,
      resolveAgentTools,
      getSessionStore: () => ({ create, addMessage }),
    }), {
      agent: "support",
      stream: false,
      guardrails: { policyPack: "strict" },
      messages: [{ role: "user", content: "hello" }],
    });

    expect(prepared).toEqual({
      kind: "error",
      status: 400,
      body: {
        error: {
          message: "Project guardrails are not configured",
          type: "invalid_request_error",
          code: "invalid_guardrail_policy",
        },
      },
    });
    expect(resolveAgentModel).not.toHaveBeenCalled();
    expect(resolveAgentTools).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(addMessage).not.toHaveBeenCalled();
  });

  it("rejects a request policy when the host has no resolver", async () => {
    const resolveAgentModel = vi.fn();
    const prepared = await prepareChatCompletionExecution(deps({
      resolveAgentModel,
    }), {
      agent: "support",
      stream: false,
      guardrails: { policyPack: "strict" },
      messages: [{ role: "user", content: "hello" }],
    });

    expect(prepared).toMatchObject({
      kind: "error",
      status: 400,
      body: {
        error: {
          code: "invalid_guardrail_policy",
        },
      },
    });
    expect(resolveAgentModel).not.toHaveBeenCalled();
  });

  it("blocks caller input before routing, context, model, tools, or session writes", async () => {
    const resolveAgentModel = vi.fn();
    const resolveAgentTools = vi.fn();
    const retrieve = vi.fn();
    const create = vi.fn();
    const addMessage = vi.fn();
    const prepared = await prepareChatCompletionExecution(deps({
      runPreflightPolicy: createConfiguredRunPreflightPolicy({
        policyPack: "custom",
        contentRules: [{
          id: "input.blocked-topic",
          phases: ["input"],
          action: "block",
          risk: "high",
          containsAny: ["blocked topic"],
        }],
      }),
      resolveExecutionRouteClassifier: vi.fn(),
      runtimeContext: { tokenBudget: 100, retrieve },
      resolveAgentModel,
      resolveAgentTools,
      getSessionStore: () => ({ create, addMessage }),
    }), {
      agent: "support",
      stream: false,
      messages: [{ role: "user", content: "Discuss the BLOCKED TOPIC" }],
    });

    expect(prepared).toEqual({
      kind: "error",
      status: 403,
      body: {
        error: {
          message: 'Matched content policy "input.blocked-topic"',
          type: "guardrail_error",
          code: "guardrail_blocked",
        },
      },
    });
    expect(retrieve).not.toHaveBeenCalled();
    expect(resolveAgentModel).not.toHaveBeenCalled();
    expect(resolveAgentTools).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(addMessage).not.toHaveBeenCalled();
  });

  it("uses redacted caller input for retrieval, model messages, and persistence", async () => {
    const retrieve = vi.fn(async () => ({ segments: [] }));
    const addMessage = vi.fn();
    const prepared = await prepareChatCompletionExecution(deps({
      runPreflightPolicy: createConfiguredRunPreflightPolicy({
        policyPack: "standard",
      }),
      runtimeContext: { tokenBudget: 100, retrieve },
      getSessionStore: () => ({
        create: async () => "session-1",
        addMessage,
      }),
    }), {
      agent: "support",
      stream: false,
      messages: [{
        role: "user",
        content: "Use ghp_abcdefghijklmnopqrstuvwxyz1234567890",
      }],
    });

    expect(prepared.kind).toBe("chat");
    if (prepared.kind !== "chat") throw new Error("Expected chat");
    expect(retrieve).toHaveBeenCalledWith(expect.objectContaining({
      query: "Use [REDACTED]",
    }));
    expect(prepared.execution.aiMessages).toEqual([
      expect.objectContaining({
        role: "user",
        content: "Use [REDACTED]",
      }),
    ]);
    expect(addMessage).toHaveBeenCalledWith(
      "session-1",
      "user",
      "Use [REDACTED]",
    );
  });

  it("evaluates retrieved context before prompt injection and applies rewrites", async () => {
    const prepared = await prepareChatCompletionExecution(deps({
      runPreflightPolicy: createConfiguredRunPreflightPolicy({
        policyPack: "custom",
        contentRules: [{
          id: "context.private-word",
          phases: ["context"],
          action: "redact",
          risk: "medium",
          containsAny: ["classified"],
          replacement: "[PRIVATE]",
        }],
      }),
      runtimeContext: {
        tokenBudget: 100,
        retrieve: async () => ({
          segments: [{
            kind: "memory" as const,
            entries: [{
              id: "memory-1",
              content: "classified customer note",
              source: { type: "memory" as const, id: "memory-1" },
              timestamp: "2026-07-30T10:00:00.000Z",
              trust: "external" as const,
            }],
          }],
        }),
      },
    }), {
      agent: "support",
      stream: false,
      messages: [{ role: "user", content: "Recall the note" }],
    });

    expect(prepared.kind).toBe("chat");
    if (prepared.kind !== "chat") throw new Error("Expected chat");
    expect(prepared.execution.fullSystemPrompt).toContain("[PRIVATE] customer note");
    expect(prepared.execution.fullSystemPrompt).not.toContain("classified");
  });

  it("runs model preflight after prompt assembly but before model and tool resolution", async () => {
    const resolveAgentModel = vi.fn();
    const resolveAgentTools = vi.fn();
    const runPreflightPolicy = createRunPreflightPolicy(
      new RuntimeGuardrailEngine([{
        id: "model.block",
        phases: ["model.preflight"],
        evaluate: (input) => {
          expect(input.value).toMatchObject({
            systemPrompt: "Base runtime prompt",
            messages: [{ role: "user", content: "hello" }],
          });
          return {
            action: "block",
            risk: "high",
            reason: "Model preflight rejected input",
          };
        },
      }]),
    );

    const prepared = await prepareChatCompletionExecution(deps({
      runPreflightPolicy,
      resolveAgentModel,
      resolveAgentTools,
    }), {
      agent: "support",
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    });

    expect(prepared).toMatchObject({
      kind: "error",
      status: 403,
      body: {
        error: {
          code: "guardrail_blocked",
        },
      },
    });
    expect(resolveAgentModel).not.toHaveBeenCalled();
    expect(resolveAgentTools).not.toHaveBeenCalled();
  });

  it("fails closed when a host policy returns malformed model input", async () => {
    const resolveAgentModel = vi.fn();
    const resolveAgentTools = vi.fn();
    const runPreflightPolicy = createRunPreflightPolicy(
      new RuntimeGuardrailEngine([{
        id: "model.malformed-rewrite",
        phases: ["model.preflight"],
        evaluate: () => ({
          action: "rewrite",
          risk: "high",
          reason: "Malformed host rewrite",
          value: "not a model input",
        }),
      }]),
    );

    const prepared = await prepareChatCompletionExecution(deps({
      runPreflightPolicy,
      resolveAgentModel,
      resolveAgentTools,
    }), {
      agent: "support",
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    });

    expect(prepared).toMatchObject({
      kind: "error",
      status: 403,
      body: {
        error: {
          code: "guardrail_blocked",
          message: "Guardrail rewrote model input to an invalid value",
        },
      },
    });
    expect(resolveAgentModel).not.toHaveBeenCalled();
    expect(resolveAgentTools).not.toHaveBeenCalled();
  });
});
