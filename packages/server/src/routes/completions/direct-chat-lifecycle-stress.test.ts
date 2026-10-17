import { createRunOutputPolicy, RuntimeGuardrailEngine } from "@polpo-ai/core";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import {
  executeStreamingChatCompletion,
  runNonStreamingChatCompletion,
  type ChatCompletionExecution,
} from "./chat-handler.js";

const usage = {
  inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 3, text: 3, reasoning: 0 },
};

function toolStream(name: string, id = `call-${name}`, input: Record<string, unknown> = {}) {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: "stream-start", warnings: [] },
        { type: "tool-call", toolCallId: id, toolName: name, input: JSON.stringify(input) },
        { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
      ] as any[]),
    }),
  });
}

function textStream(onStream?: (options: any) => void) {
  return new MockLanguageModelV3({
    doStream: async (options: any) => {
      onStream?.(options);
      return { stream: convertArrayToReadableStream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "text" },
        { type: "text-delta", id: "text", delta: "done" },
        { type: "text-end", id: "text" },
        { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
      ] as any[]) };
    },
  } as any);
}

function fixture(model: MockLanguageModelV3, options: {
  agentMode?: boolean;
  clientTool?: string;
  interactiveTool?: string;
  failPersistence?: boolean;
  cleanupThrows?: boolean;
  outputPolicy?: ChatCompletionExecution["deps"]["runOutputPolicy"];
} = {}) {
  const accounting = vi.fn();
  const cleanup = options.cleanupThrows
    ? vi.fn(() => { throw new Error("cleanup failed synchronously"); })
    : vi.fn(async () => {});
  const updateMessage = vi.fn(async (..._args: any[]) => {
    if (options.failPersistence) throw new Error("database unavailable");
  });
  const sessionStore = {
    addMessage: vi.fn(async () => ({ id: "assistant-direct" })),
    updateMessage,
  };
  const toolName = options.clientTool ?? options.interactiveTool;
  const execution = {
    deps: {
      getConfig: () => ({ settings: {} }),
      emit: () => {},
      resolveAgentModel: vi.fn(),
      onCompletionFinished: accounting,
      ...(options.outputPolicy ? { runOutputPolicy: options.outputPolicy } : {}),
    },
    body: { agent: "direct-agent", stream: true },
    completionId: "chatcmpl-direct-lifecycle",
    agentConfig: { name: "direct-agent", model: "mock" },
    agentMode: options.agentMode ?? true,
    fullSystemPrompt: "Be helpful.",
    m: { id: "mock", provider: "mock", aiModel: model, contextWindow: 200_000, maxTokens: 8192 },
    modelSelection: { primary: "mock", fallbacks: [] },
    effectiveTools: toolName
      ? [{ name: toolName, description: toolName, parameters: { type: "object", properties: {} } }]
      : [],
    effectiveToolExecutor: vi.fn(async () => "ok"),
    extraAiTools: {},
    isInteractiveFn: (name: string) => name === options.interactiveTool,
    clientSideToolNames: new Set(options.clientTool ? [options.clientTool] : []),
    interactionSettings: { allowUserQuestions: true, suggestions: { enabled: false, maxItems: 3 } },
    aiMessages: [{ role: "user", content: "continue" }],
    sessionStore,
    sessionId: "session-direct-lifecycle",
    onResponseFinished: cleanup,
  } as unknown as ChatCompletionExecution;
  return { execution, sessionStore, updateMessage, accounting, cleanup };
}

function context(signal: AbortSignal) {
  return {
    req: { raw: { signal } },
    json: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status }),
  } as any;
}

describe("direct chat lifecycle invariants", () => {
  it.each([
    { kind: "standard", name: "apply_site_change", finishReason: "tool_calls" },
    { kind: "interactive", name: "ask_user", finishReason: "ask_user" },
  ] as const)("persists a pending $kind tool before publishing its handoff", async ({ kind, name, finishReason }) => {
    const f = fixture(
      toolStream(name, `call-${kind}`, kind === "interactive" ? { questions: [] } : {}),
      kind === "standard"
        ? { clientTool: name }
        : { agentMode: false, interactiveTool: name },
    );
    let persistedAtHandoff = false;
    await executeStreamingChatCompletion({
      write: async () => {},
      writeSSE: async ({ data }) => {
        if (data.includes(`\"finish_reason\":\"${finishReason}\"`)) {
          persistedAtHandoff = f.updateMessage.mock.calls.some((call) =>
            (call[3] as any[]).some((tool) => tool.id === `call-${kind}`),
          );
        }
      },
    }, f.execution, new AbortController().signal);

    expect(persistedAtHandoff).toBe(true);
    expect(f.updateMessage).toHaveBeenCalledTimes(1);
  });

  it("rejects output before recording or publishing a standard client tool", async () => {
    const policy = createRunOutputPolicy(new RuntimeGuardrailEngine([{
      id: "deny-output",
      phases: ["output"],
      evaluate: () => ({ action: "block", risk: "high", reason: "blocked" }),
    }]), { streamingMode: "buffer" });
    const f = fixture(toolStream("apply_site_change"), {
      clientTool: "apply_site_change",
      outputPolicy: policy,
    });
    const frames: string[] = [];

    await executeStreamingChatCompletion({
      write: async () => {},
      writeSSE: async ({ data }) => { frames.push(data); },
    }, f.execution, new AbortController().signal);

    expect(frames.join("\n")).not.toContain('"finish_reason":"tool_calls"');
    expect(frames.some((frame) => frame.includes('"code":"guardrail_blocked"'))).toBe(true);
    expect(f.updateMessage.mock.calls[0]?.[3]).toEqual([]);
  });

  it("does not record or publish a standard client tool when cancellation wins in output policy", async () => {
    const abort = new AbortController();
    const policy = createRunOutputPolicy(new RuntimeGuardrailEngine([{
      id: "cancel-output",
      phases: ["output"],
      evaluate: async () => {
        await Promise.resolve();
        abort.abort();
        return { action: "allow", risk: "low", reason: "allowed" };
      },
    }]), { streamingMode: "buffer" });
    const f = fixture(toolStream("apply_site_change"), {
      clientTool: "apply_site_change",
      outputPolicy: policy,
    });
    const frames: string[] = [];

    await executeStreamingChatCompletion({
      write: async () => {},
      writeSSE: async ({ data }) => { frames.push(data); },
    }, f.execution, abort.signal);

    expect(frames.join("\n")).not.toContain('"finish_reason":"tool_calls"');
    expect(f.updateMessage.mock.calls[0]?.[3]).toEqual([]);
  });

  it("passes the request abort signal to the direct non-streaming model", async () => {
    const abort = new AbortController();
    let modelSignal: AbortSignal | undefined;
    const f = fixture(textStream((options) => { modelSignal = options.abortSignal; }));

    await runNonStreamingChatCompletion(context(abort.signal), f.execution);

    expect(modelSignal).toBe(abort.signal);
  });

  it("does not return or persist a direct non-streaming client tool cancelled during output policy", async () => {
    const abort = new AbortController();
    const policy = createRunOutputPolicy(new RuntimeGuardrailEngine([{
      id: "cancel-output",
      phases: ["output"],
      evaluate: async () => {
        await Promise.resolve();
        abort.abort();
        return { action: "allow", risk: "low", reason: "allowed" };
      },
    }]));
    const f = fixture(toolStream("apply_site_change"), {
      clientTool: "apply_site_change",
      outputPolicy: policy,
    });

    const response = await runNonStreamingChatCompletion(context(abort.signal), f.execution);
    const body = await response.json() as any;

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(body.choices).toBeUndefined();
    expect(f.updateMessage.mock.calls[0]?.[3]).toEqual([]);
  });

  it("always accounts and releases response resources when direct non-streaming persistence fails", async () => {
    const f = fixture(textStream(), { failPersistence: true });

    await expect(runNonStreamingChatCompletion(
      context(new AbortController().signal),
      f.execution,
    )).rejects.toThrow("database unavailable");

    expect(f.accounting).toHaveBeenCalledTimes(1);
    expect(f.cleanup).toHaveBeenCalledTimes(1);
  });

  it.each(["stream", "nonstream"] as const)("contains synchronous cleanup callback failure for direct %s", async (surface) => {
    const f = fixture(textStream(), { cleanupThrows: true });

    if (surface === "stream") {
      await expect(executeStreamingChatCompletion(
        { write: async () => {}, writeSSE: async () => {} },
        f.execution,
        new AbortController().signal,
      )).resolves.toBeUndefined();
    } else {
      const response = await runNonStreamingChatCompletion(
        context(new AbortController().signal),
        f.execution,
      );
      expect(response.status).toBe(200);
    }

    expect(f.accounting).toHaveBeenCalledTimes(1);
    expect(f.cleanup).toHaveBeenCalledTimes(1);
  });
});
