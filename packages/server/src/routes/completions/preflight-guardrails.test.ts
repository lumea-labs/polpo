import { describe, expect, it, vi } from "vitest";
import {
  RuntimeGuardrailEngine,
  createConfiguredRunPreflightPolicy,
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
