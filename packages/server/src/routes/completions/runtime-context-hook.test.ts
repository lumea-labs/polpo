import { describe, expect, it, vi } from "vitest";
import {
  prepareChatCompletionExecution,
  type CompletionRouteDeps,
} from "../completions.js";
import { resolveProjectLoopResumeRuntimeContext } from "./project-loop-runner.js";

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

describe("completion runtime context hook", () => {
  it("is off by default and leaves the existing prompt byte-identical", async () => {
    const prepared = await prepareChatCompletionExecution(deps(), {
      agent: "support",
      stream: false,
      messages: [{ role: "user", content: "What does this customer prefer?" }],
    });

    expect(prepared.kind).toBe("chat");
    if (prepared.kind !== "chat") throw new Error("Expected chat");
    expect(prepared.execution.fullSystemPrompt).toBe("Base runtime prompt");
    expect(prepared.execution.runtimeContext).toBeUndefined();
  });

  it("retrieves once for channel turns and appends a separate context block", async () => {
    const retrieve = vi.fn(async (input) => {
      expect(input).toMatchObject({
        agentName: "support",
        query: "What does this customer prefer?",
        surface: "channel",
        source: "channel",
        externalUserId: "telegram:5062560138",
        sessionId: "session-1",
        channelId: "telegram-chat-1",
        requestId: "telegram-update-1",
      });
      return {
        segments: [{
          kind: "memory" as const,
          entries: [{
            id: "memory-1",
            content: "The customer prefers concise replies.",
            source: {
              type: "memory" as const,
              id: "memory-1",
              label: "preference",
            },
            timestamp: "2026-07-28T10:00:00.000Z",
            trust: "user_provided" as const,
          }],
        }],
      };
    });
    const prepared = await prepareChatCompletionExecution(deps({
      runtimeContext: { tokenBudget: 1_000, retrieve },
    }), {
      agent: "support",
      stream: false,
      user: "telegram:5062560138",
      messages: [{ role: "user", content: "What does this customer prefer?" }],
    }, {
      sessionId: "session-1",
      runtime: {
        surface: "channel",
        source: "channel",
        channelId: "telegram-chat-1",
        requestId: "telegram-update-1",
      },
    });

    expect(prepared.kind).toBe("chat");
    if (prepared.kind !== "chat") throw new Error("Expected chat");
    expect(retrieve).toHaveBeenCalledOnce();
    expect(prepared.execution.runtimeContext?.segments).toHaveLength(1);
    expect(prepared.execution.fullSystemPrompt).toContain("Base runtime prompt");
    expect(prepared.execution.fullSystemPrompt).toContain("## Retrieved Memory");
    expect(prepared.execution.fullSystemPrompt).toContain(
      "The customer prefers concise replies.",
    );
  });

  it("does not add a block when retrieval is empty", async () => {
    const prepared = await prepareChatCompletionExecution(deps({
      runtimeContext: {
        tokenBudget: 1_000,
        retrieve: async () => ({ segments: [] }),
      },
    }), {
      agent: "support",
      stream: false,
      messages: [{ role: "user", content: "Unknown preference" }],
    });

    expect(prepared.kind).toBe("chat");
    if (prepared.kind !== "chat") throw new Error("Expected chat");
    expect(prepared.execution.fullSystemPrompt).toBe("Base runtime prompt");
    expect(prepared.execution.runtimeContext).toBeUndefined();
  });

  it("replaces legacy agent Memory even when typed retrieval has no relevant items", async () => {
    const buildRuntimePrompt = vi.fn(async () => "Base runtime prompt");
    const prepared = await prepareChatCompletionExecution(deps({
      buildRuntimePrompt,
      runtimeContext: {
        tokenBudget: 1_000,
        retrieve: async () => ({
          segments: [],
          legacyMemory: { agent: "replace" },
        }),
      },
    }), {
      agent: "support",
      stream: false,
      messages: [{ role: "user", content: "Unknown preference" }],
    });

    expect(prepared.kind).toBe("chat");
    if (prepared.kind !== "chat") throw new Error("Expected chat");
    expect(prepared.execution.runtimeContext?.legacyMemory).toEqual({
      agent: "replace",
    });
    expect(buildRuntimePrompt).toHaveBeenCalledWith(
      expect.objectContaining({ name: "support" }),
      expect.objectContaining({ includeAgentMemory: false }),
    );
    expect(prepared.execution.fullSystemPrompt).toBe("Base runtime prompt");
  });

  it("does not read legacy agent Memory in the fallback prompt path when it is replaced", async () => {
    const get = vi.fn(async () => "LEGACY_MEMORY_MUST_NOT_BE_READ");
    const prepared = await prepareChatCompletionExecution(deps({
      buildRuntimePrompt: undefined,
      buildAgentPrompt: async () => "Base prompt",
      getMemoryStore: () => ({ get }),
      runtimeContext: {
        tokenBudget: 1_000,
        retrieve: async () => ({
          segments: [],
          legacyMemory: { agent: "replace" },
        }),
      },
    }), {
      agent: "support",
      stream: false,
      messages: [{ role: "user", content: "Unknown preference" }],
    });

    expect(prepared.kind).toBe("chat");
    if (prepared.kind !== "chat") throw new Error("Expected chat");
    expect(get).not.toHaveBeenCalled();
    expect(prepared.execution.fullSystemPrompt).not.toContain(
      "LEGACY_MEMORY_MUST_NOT_BE_READ",
    );
  });

  it("fails closed with a generic error when retrieval fails", async () => {
    const prepared = await prepareChatCompletionExecution(deps({
      runtimeContext: {
        tokenBudget: 1_000,
        retrieve: async () => {
          throw new Error("secret database topology");
        },
      },
    }), {
      agent: "support",
      stream: false,
      messages: [{ role: "user", content: "Preference" }],
    });

    expect(prepared).toEqual({
      kind: "error",
      status: 500,
      body: {
        error: {
          message: "Runtime context retrieval failed",
          type: "server_error",
          code: "runtime_context_failed",
        },
      },
    });
    expect(JSON.stringify(prepared)).not.toContain("database topology");
  });

  it("resolves one context snapshot for a project loop", async () => {
    const retrieve = vi.fn(async (_input: unknown) => ({
      segments: [{
        kind: "memory" as const,
        entries: [{
          id: "memory-1",
          content: "Use the approved release procedure.",
          source: { type: "memory" as const, id: "memory-1" },
          timestamp: "2026-07-28T10:00:00.000Z",
          trust: "trusted" as const,
        }],
      }],
    }));
    const prepared = await prepareChatCompletionExecution(deps({
      getAgents: async () => [{
        name: "support",
        model: "mock",
        assignedLoops: ["release"],
      }],
      getProjectLoop: async () => ({
        name: "release",
        pipeline: { steps: [{ loop: "prepare" }] },
        loops: { prepare: {} },
      } as any),
      runtimeContext: { tokenBudget: 1_000, retrieve },
    }), {
      agent: "support",
      loop: "release",
      stream: false,
      messages: [{ role: "user", content: "Prepare the release" }],
    }, {
      runtime: {
        surface: "channel",
        source: "channel",
        channelId: "telegram-channel-1",
      },
    });

    expect(prepared.kind).toBe("project-loop");
    if (prepared.kind !== "project-loop") throw new Error("Expected project loop");
    expect(retrieve).toHaveBeenCalledOnce();
    expect(prepared.runtimeContext?.segments[0].entries[0].id).toBe("memory-1");
    expect(prepared.runtimeInvocation).toEqual({
      surface: "channel",
      source: "channel",
      channelId: "telegram-channel-1",
    });
  });

  it("re-resolves a fresh scoped snapshot when an approved loop resumes", async () => {
    const retrieve = vi.fn(async (_input: unknown) => ({
      segments: [{
        kind: "memory" as const,
        entries: [{
          id: "memory-resume",
          content: "This value was retrieved after approval.",
          source: { type: "memory" as const, id: "memory-resume" },
          timestamp: "2026-07-28T10:00:00.000Z",
          trust: "trusted" as const,
        }],
      }],
    }));
    const resolution = await resolveProjectLoopResumeRuntimeContext(
      deps({ runtimeContext: { tokenBudget: 1_000, retrieve } }),
      {
        id: "looprun-1",
        loopName: "release",
        agentName: "support",
        sessionId: "session-1",
        user: "external-user-1",
        status: "approval_approved",
        context: {},
        trace: [],
        resume: {
          context: {},
          steps: [{ loop: "publish" }],
          runtime: {
            aiMessages: [{
              role: "user",
              content: [{ type: "text", text: "Publish the approved release" }],
            }],
            extraSystemParts: [],
          },
          createdAt: "2026-07-28T09:00:00.000Z",
        },
        metadata: {
          runtimeInvocation: {
            surface: "channel",
            source: "channel",
            channelId: "telegram-channel-1",
          },
        },
        startedAt: "2026-07-28T09:00:00.000Z",
        updatedAt: "2026-07-28T09:30:00.000Z",
      },
    );

    expect(retrieve).toHaveBeenCalledOnce();
    expect(retrieve.mock.calls[0][0]).toMatchObject({
      agentName: "support",
      query: "Publish the approved release",
      surface: "channel",
      source: "channel",
      externalUserId: "external-user-1",
      sessionId: "session-1",
      channelId: "telegram-channel-1",
      runId: "looprun-1",
    });
    expect(resolution?.segments[0].entries[0].id).toBe("memory-resume");
  });
});
