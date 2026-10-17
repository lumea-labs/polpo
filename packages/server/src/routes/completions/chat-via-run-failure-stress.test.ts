import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import { createRunOutputPolicy, RuntimeGuardrailEngine } from "@polpo-ai/core";
import {
  executeStreamingChatViaRun,
  runChatTurnViaRun,
  runNonStreamingChatViaRun,
} from "./chat-via-run-handler.js";
import { executeStreamingChatCompletion, type ChatCompletionExecution } from "./chat-handler.js";

const failure = 'Active run "chatcmpl-ZIMLVXC2vzsak4n2in-2Wdk8" was not found';
type FailureMode = "event" | "outcome" | "throw";

function fixture(id: string, mode: FailureMode, fragments: string[], clientTool = false) {
  const updateMessage = vi.fn(async (..._args: any[]) => true);
  const commitCanonicalTurn = vi.fn(async (input: any) => ({ created: true, turn: input.turn }));
  const release = vi.fn(async () => {});
  const accounting = vi.fn();
  const sessionStore = {
    addMessage: vi.fn(async () => ({ id: `assistant-${id}` })),
    updateMessage,
    commitCanonicalTurn,
  };
  const execution = {
    deps: {
      getConfig: () => ({ settings: {} }),
      emit: () => {},
      createRunSteeringScope: async () => ({ release }),
      onCompletionFinished: accounting,
      runChatViaRun: async (_inject: unknown, hooks: any) => {
        for (const text of fragments) {
          await Promise.resolve();
          hooks.onEvent({ type: "text-delta", text });
        }
        hooks.onEvent({ type: "usage", usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } });
        if (clientTool) hooks.onEvent({ type: "client_tool_call", toolId: `call-${id}`,
          tool: "apply_site_change", input: { instruction: "Add language flags" } });
        if (mode === "throw") throw new Error(failure);
        if (mode === "event") hooks.onEvent({ type: "error", error: { message: failure } });
        return { status: "failed", result: { exitCode: 1, stdout: "", stderr: failure } };
      },
    },
    body: { agent: "site-namer", stream: true },
    completionId: id,
    agentConfig: { name: "site-namer", model: "mock" },
    agentMode: true,
    fullSystemPrompt: "Proponi nomi brevi per un sito dimostrativo sul caffè italiano.",
    m: { id: "mock", provider: "mock", aiModel: {}, contextWindow: 200000, maxTokens: 8192 },
    modelSelection: { primary: "mock", fallbacks: [] },
    effectiveTools: [],
    effectiveToolExecutor: async () => "ok",
    interactionSettings: { allowUserQuestions: true, suggestions: { enabled: false, maxItems: 3 } },
    aiMessages: [{ role: "user", content: "Proponi tre nomi brevi per un sito dimostrativo sul caffè italiano" }],
    sessionStore,
    sessionId: `session-${id}`,
    canonicalTurn: { turnId: `turn-${id}`, agentName: "site-namer", surface: "chat",
      userMessageId: `user-${id}`, trustedInvocation: {}, learningPolicy: {} },
  } as unknown as ChatCompletionExecution;
  return { execution, sessionStore, release, accounting };
}

describe("Run-backed completion failure invariants", () => {
  for (const surface of ["stream", "nonstream", "channel"] as const) {
    it(`does not let a throwing host response callback skip ${surface} steering release`, async () => {
      const f = fixture(`throwing-observer-${surface}`, "throw", ["partial"]);
      const callback = vi.fn(() => { throw new Error("observer unavailable"); });
      f.execution.onResponseFinished = callback;
      const signal = new AbortController().signal;
      const operation = surface === "stream"
        ? executeStreamingChatViaRun({ write: async () => {}, writeSSE: async () => {} }, f.execution, signal)
        : surface === "channel"
          ? runChatTurnViaRun(f.execution, { signal })
          : runNonStreamingChatViaRun({ req: { raw: { signal } }, json: () => new Response() } as any, f.execution);
      await expect(operation.then(() => "finished")).resolves.toBe("finished");
      expect(callback).toHaveBeenCalledTimes(1);
      expect(f.accounting).toHaveBeenCalledTimes(1);
      expect(f.release).toHaveBeenCalledTimes(1);
    });

    it(`accounts for consumed tokens and releases steering when ${surface} history persistence fails`, async () => {
      const f = fixture(`persist-failed-${surface}`, "throw", ["partial"]);
      f.sessionStore.updateMessage.mockRejectedValue(new Error("database unavailable"));
      const signal = new AbortController().signal;
      const operation = surface === "stream"
        ? executeStreamingChatViaRun({ write: async () => {}, writeSSE: async () => {} }, f.execution, signal)
        : surface === "channel"
          ? runChatTurnViaRun(f.execution, { signal })
          : runNonStreamingChatViaRun({ req: { raw: { signal } }, json: () => new Response() } as any, f.execution);
      await expect(operation).rejects.toThrow("database unavailable");
      expect(f.accounting).toHaveBeenCalledTimes(1);
      expect(f.release).toHaveBeenCalledTimes(1);
      expect(f.sessionStore.commitCanonicalTurn).not.toHaveBeenCalled();
    });

    it(`does not hand off a client tool when cancelled during ${surface} output policy`, async () => {
      const f = fixture(`policy-cancel-${surface}`, "outcome", []);
      const abort = new AbortController();
      f.execution.deps.runChatViaRun = async (_inject, hooks) => {
        hooks.onEvent({ type: "client_tool_call", toolId: "cancelled-call", tool: "apply_site_change", input: {} });
        return { status: "completed", result: { exitCode: 0, stdout: "", stderr: "" } };
      };
      f.execution.deps.runOutputPolicy = createRunOutputPolicy(new RuntimeGuardrailEngine([{
        id: "cancel-before-publish", phases: ["output"],
        evaluate: async () => { await Promise.resolve(); abort.abort(); return { action: "allow", risk: "low", reason: "allowed" }; },
      }]));
      const frames: string[] = [];
      if (surface === "stream") {
        await executeStreamingChatViaRun({ write: async () => {}, writeSSE: async ({ data }) => { frames.push(data); } }, f.execution, abort.signal);
        expect(frames.join("\n")).not.toContain("cancelled-call");
      } else if (surface === "channel") {
        const result = await runChatTurnViaRun(f.execution, { signal: abort.signal });
        expect(result.clientToolCall).toBeUndefined();
        expect(result.runStatus).toBe("killed");
      } else {
        const response = await runNonStreamingChatViaRun({ req: { raw: { signal: abort.signal } },
          json: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status }) } as any, f.execution);
        expect(response.status).toBeGreaterThanOrEqual(400);
      }
      expect(f.sessionStore.updateMessage.mock.calls[0]?.[3]).toEqual([]);
      expect(f.sessionStore.commitCanonicalTurn).not.toHaveBeenCalled();
      expect(f.release).toHaveBeenCalledTimes(1);
    });
  }

  it("does not commit a successful canonical channel turn when the output guardrail rejects it", async () => {
    const f = fixture("channel-policy-reject", "outcome", []);
    f.execution.deps.runChatViaRun = async (_inject, hooks) => {
      hooks.onEvent({ type: "text-delta", text: "blocked content" });
      return { status: "completed", result: { exitCode: 0, stdout: "", stderr: "" } };
    };
    f.execution.deps.runOutputPolicy = createRunOutputPolicy(new RuntimeGuardrailEngine([{
      id: "deny", phases: ["output"], evaluate: () => ({ action: "block", risk: "high", reason: "blocked by policy" }),
    }]));
    await expect(runChatTurnViaRun(f.execution)).rejects.toThrow("blocked by policy");
    expect(f.sessionStore.commitCanonicalTurn).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(f.accounting).toHaveBeenCalledTimes(1);
  });

  it.each(["run", "direct"])("persists a pending %s client tool before publishing it so an immediate continuation can find it", async (surface) => {
    const f = fixture("immediate-tool-continuation", "outcome", []);
    f.execution.deps.runChatViaRun = async (_inject, hooks) => {
      hooks.onEvent({ type: "client_tool_call", toolId: "ready-call", tool: "apply_site_change", input: {} });
      return { status: "completed", result: { exitCode: 0, stdout: "", stderr: "" } };
    };
    f.execution.clientSideToolNames = new Set(["apply_site_change"]);
    f.execution.effectiveTools = [{ name: "apply_site_change", description: "Apply a site change", parameters: { type: "object", properties: {} } }];
    f.execution.m.aiModel = new MockLanguageModelV3({
      doStream: async () => ({ stream: convertArrayToReadableStream([
        { type: "stream-start", warnings: [] },
        { type: "tool-call", toolCallId: "ready-call", toolName: "apply_site_change", input: "{}" },
        { type: "finish", finishReason: { unified: "tool-calls", raw: undefined },
          usage: { inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 3, text: 3, reasoning: 0 } } },
      ]) }),
    });
    let persistedAtHandoff = false;
    const execute = surface === "direct" ? executeStreamingChatCompletion : executeStreamingChatViaRun;
    await execute({ write: async () => {}, writeSSE: async ({ data }) => {
      if (data.includes('"finish_reason":"tool_calls"')) {
        persistedAtHandoff = f.sessionStore.updateMessage.mock.calls.some(call =>
          (call[3] as any[]).some(tool => tool.id === "ready-call"));
      }
    } }, f.execution, new AbortController().signal);
    expect(persistedAtHandoff).toBe(true);
    expect(f.sessionStore.updateMessage).toHaveBeenCalledTimes(1);
  });

  it("does not publish an executable client tool if persisting the handoff fails", async () => {
    const f = fixture("failed-tool-handoff", "outcome", []);
    f.sessionStore.updateMessage.mockRejectedValue(new Error("database unavailable"));
    f.execution.deps.runChatViaRun = async (_inject, hooks) => {
      hooks.onEvent({ type: "client_tool_call", toolId: "unsaved-call", tool: "apply_site_change", input: {} });
      return { status: "completed", result: { exitCode: 0, stdout: "", stderr: "" } };
    };
    const frames: string[] = [];
    await executeStreamingChatViaRun({ write: async () => {}, writeSSE: async ({ data }) => { frames.push(data); } },
      f.execution, new AbortController().signal).catch(() => {});
    expect(frames.join("\n")).not.toContain('"finish_reason":"tool_calls"');
    expect(frames.some(frame => frame.includes('"error"'))).toBe(true);
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(f.accounting).toHaveBeenCalledTimes(1);
  });

  for (const mode of ["event", "outcome", "throw"] as const) {
    for (const fragments of [[], ["Caffèitaliano"], ["Caffè", "italiano"]]) {
      it(`keeps ${mode} failure out of SSE content/history after ${fragments.length} fragments`, async () => {
        const f = fixture(`stream-${mode}-${fragments.length}`, mode, fragments);
        const frames: string[] = [];
        await executeStreamingChatViaRun({ write: async () => {}, writeSSE: async ({ data }) => { frames.push(data); } },
          f.execution, new AbortController().signal);
        const chunks = frames.filter(data => data !== "[DONE]").map(data => JSON.parse(data));
        expect(chunks.map(c => c.choices?.[0]?.delta?.content ?? "").join("")).toBe(fragments.join(""));
        expect(chunks.filter(c => c.choices?.[0]?.error)).toHaveLength(1);
        expect(frames.filter(data => data === "[DONE]")).toHaveLength(1);
        expect(f.sessionStore.updateMessage.mock.calls[0]?.[2]).toBe(fragments.join(""));
        expect(f.sessionStore.commitCanonicalTurn).not.toHaveBeenCalled();
        expect(f.release).toHaveBeenCalledTimes(1);
        expect(f.accounting).toHaveBeenCalledTimes(1);
      });
    }

    it(`does not return an executable client tool from a failed non-streaming ${mode} completion`, async () => {
      const f = fixture(`nonstream-${mode}`, mode, [], true);
      const context = { req: { raw: { signal: new AbortController().signal } },
        json: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status }) };
      const response = await runNonStreamingChatViaRun(context as any, f.execution);
      const body = await response.json();
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(body.error).toBeDefined();
      expect(body.choices).toBeUndefined();
      expect(f.sessionStore.commitCanonicalTurn).not.toHaveBeenCalled();
      expect(f.sessionStore.updateMessage.mock.calls[0]?.[3]).toEqual([]);
      expect(f.release).toHaveBeenCalledTimes(1);
    });

    it(`does not fabricate assistant text for a failed channel ${mode} completion`, async () => {
      const f = fixture(`channel-${mode}`, mode, []);
      const result = await runChatTurnViaRun(f.execution);
      expect(result.error).toBeDefined();
      expect(result.text).toBe("");
      expect(f.sessionStore.commitCanonicalTurn).not.toHaveBeenCalled();
      expect(f.release).toHaveBeenCalledTimes(1);
    });
  }

  it("isolates 120 concurrent failing streams and never writes content after the terminal frame", async () => {
    const modes = ["event", "outcome", "throw"] as const;
    await Promise.all(Array.from({ length: 120 }, async (_, index) => {
      const fragments = [`response-${index}:`, "Caffè", "italiano"];
      const f = fixture(`concurrent-${index}`, modes[index % modes.length], fragments);
      const frames: string[] = [];
      await executeStreamingChatViaRun({ write: async () => {}, writeSSE: async ({ data }) => {
        // Alternate writer schedules deterministically instead of sleeping.
        for (let turn = 0; turn < index % 4; turn++) await Promise.resolve();
        frames.push(data);
      } }, f.execution, new AbortController().signal);
      expect(frames.at(-1)).toBe("[DONE]");
      const chunks = frames.slice(0, -1).map(data => JSON.parse(data));
      expect(chunks.at(-1).choices[0].error).toBeDefined();
      expect(chunks.map(c => c.choices?.[0]?.delta?.content ?? "").join("")).toBe(fragments.join(""));
      expect(f.sessionStore.updateMessage.mock.calls[0]?.[2]).toBe(fragments.join(""));
      expect(f.sessionStore.commitCanonicalTurn).not.toHaveBeenCalled();
      expect(f.release).toHaveBeenCalledTimes(1);
      expect(f.accounting).toHaveBeenCalledTimes(1);
    }));
  });

  it("does not hand off a client action when cancellation wins immediately before completion", async () => {
    const f = fixture("cancel-before-handoff", "outcome", []);
    const abort = new AbortController();
    f.execution.deps.runChatViaRun = async (_inject, hooks) => {
      hooks.onEvent({ type: "client_tool_call", toolId: "cancelled-call", tool: "apply_site_change", input: {} });
      abort.abort();
      return { status: "completed", result: { exitCode: 0, stdout: "", stderr: "" } };
    };
    const frames: string[] = [];
    await executeStreamingChatViaRun({ write: async () => {}, writeSSE: async ({ data }) => { frames.push(data); } },
      f.execution, abort.signal);
    expect(frames.join("\n")).not.toContain("cancelled-call");
    expect(f.sessionStore.updateMessage.mock.calls[0]?.[3]).toEqual([]);
    expect(f.sessionStore.commitCanonicalTurn).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it("preserves the same error/content separation in direct chat", async () => {
    const f = fixture("direct-partial-error", "outcome", []);
    f.execution.m.aiModel = new MockLanguageModelV3({
      doStream: async () => ({ stream: convertArrayToReadableStream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "text-1" },
        { type: "text-delta", id: "text-1", delta: "Caffèitaliano" },
        { type: "error", error: new Error(failure) },
      ]) }),
    });
    const frames: string[] = [];
    await executeStreamingChatCompletion({ write: async () => {}, writeSSE: async ({ data }) => { frames.push(data); } },
      f.execution, new AbortController().signal);
    const chunks = frames.filter(data => data !== "[DONE]").map(data => JSON.parse(data));
    expect(chunks.map(c => c.choices?.[0]?.delta?.content ?? "").join("")).toBe("Caffèitaliano");
    expect(chunks.at(-1).choices[0].error.message).toBe(failure);
    expect(f.sessionStore.updateMessage.mock.calls[0]?.[2]).toBe("Caffèitaliano");
    expect(f.sessionStore.commitCanonicalTurn).not.toHaveBeenCalled();
  });
});
