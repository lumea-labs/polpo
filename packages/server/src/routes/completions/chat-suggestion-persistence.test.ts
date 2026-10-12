import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import { normalizeChatInteractionSettings } from "@polpo-ai/core/chat-interactions";
import { executeStreamingChatCompletion, type ChatCompletionExecution } from "./chat-handler.js";
import { executeStreamingChatViaRun } from "./chat-via-run-handler.js";

const action = { kind: "action", id: "publish", label: "Publish", action: {
  type: "open_url", url: "https://app.example.test/publish",
} } as const;

function fixture(failPersistence = false, canonical = false) {
  const model = new MockLanguageModelV3({
    doStream: async () => ({ stream: convertArrayToReadableStream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "text" },
      { type: "text-delta", id: "text", delta: "Site ready" },
      { type: "text-end", id: "text" },
      { type: "finish", finishReason: { unified: "stop", raw: undefined },
        usage: { inputTokens: { total: 10 }, outputTokens: { total: 2 } } },
    ] as any[]) }),
    doGenerate: async () => ({
      content: [{ type: "text", text: JSON.stringify({ suggestions: [{ label: "Review", prompt: "Review my site." }] }) }],
      finishReason: { unified: "stop", raw: undefined },
      usage: { inputTokens: { total: 5 }, outputTokens: { total: 3 } }, warnings: [],
    }),
  } as any);
  let persisted: any;
  const store = {
    addMessage: vi.fn(async () => ({ id: "assistant" })),
    updateMessage: vi.fn(async (_session, _id, content, _tools, suggestions) => {
      if (failPersistence) throw new Error("store unavailable");
      persisted = { content, suggestions };
    }),
    commitCanonicalTurn: vi.fn(async ({ assistant, turn }) => {
      if (failPersistence) throw new Error("store unavailable");
      persisted = { content: assistant.content, suggestions: assistant.suggestions };
      return { created: true, turn };
    }),
  };
  const onResponseFinished = vi.fn(async () => {});
  const onCompletionFinished = vi.fn();
  const execution: ChatCompletionExecution = {
    deps: {
      getConfig: () => ({}), emit: () => {}, onCompletionFinished, onCanonicalTurnCommitted: vi.fn(),
      runChatViaRun: async (_input, hooks) => {
        hooks.onEvent({ type: "text-delta", text: "Site ready" });
        return { status: "completed", result: { exitCode: 0, stdout: "Site ready", stderr: "" } };
      },
    } as any,
    body: { agent: "leo", messages: [{ role: "user", content: "Create my site" }],
      polpo: { capabilities: { suggestions: { maxItems: 3, actions: [action] } } } },
    completionId: "completion", agentConfig: { name: "leo", model: "mock" },
    agentMode: true, fullSystemPrompt: "Help with the site.",
    m: { id: "mock", provider: "mock", aiModel: model, maxTokens: 8192, contextWindow: 10000 },
    effectiveTools: [], effectiveToolExecutor: async () => "ok", clientSideTools: {},
    interactionSettings: normalizeChatInteractionSettings({ suggestions: { enabled: true } }),
    interactionCapabilities: { askUserQuestion: false, suggestions: true },
    aiMessages: [{ role: "user", content: "Create my site" }],
    sessionStore: store, sessionId: "session", onResponseFinished,
    ...(canonical ? { canonicalTurn: {
      turnId: "turn", userMessageId: "user", agentName: "leo", surface: "chat" as const,
      trustedInvocation: {}, learningPolicy: { mode: "suggest" as const, surfaces: ["chat" as const], kinds: [] },
    } } : {}),
  };
  const frames: string[] = [];
  const snapshots: any[] = [];
  const writer = { writeSSE: async ({ data }: { data: string }) => {
    frames.push(data);
    if (data === "[DONE]" || data.includes('"suggestions"')) {
      snapshots.push(structuredClone(persisted));
    }
  } };
  return { execution, store, writer, frames, snapshots, onResponseFinished, onCompletionFinished };
}

describe.each([
  { name: "inline", execute: executeStreamingChatCompletion },
  { name: "run-backed", execute: executeStreamingChatViaRun },
])("$name streaming suggestion persistence", ({ execute }) => {
  it.each([false, true])("commits the combined list before terminal events (canonical=%s)", async canonical => {
    const f = fixture(false, canonical);
    await execute(f.writer, f.execution, new AbortController().signal);
    const frame = f.frames.find(data => data.includes('"suggestions"'))!;
    const suggestions = JSON.parse(frame).polpo.suggestions;
    expect(suggestions).toHaveLength(2);
    expect(suggestions[0]).toEqual(action);
    expect(suggestions[1]).toMatchObject({ kind: "message", prompt: "Review my site." });
    expect(f.snapshots).toEqual([
      { content: "Site ready", suggestions }, { content: "Site ready", suggestions },
    ]);
    expect(f.store.updateMessage).toHaveBeenCalledTimes(canonical ? 0 : 1);
    expect(f.store.commitCanonicalTurn).toHaveBeenCalledTimes(canonical ? 1 : 0);
    expect(f.execution.deps.onCanonicalTurnCommitted).toHaveBeenCalledTimes(canonical ? 1 : 0);
    expect(f.onCompletionFinished).toHaveBeenCalledOnce();
    expect(f.onResponseFinished).toHaveBeenCalledOnce();
  });

  it.each([false, true])("does not expose an unpersisted list on store failure (canonical=%s)", async canonical => {
    const f = fixture(true, canonical);
    await execute(f.writer, f.execution, new AbortController().signal).catch(() => {});
    expect(f.frames.some(data => data.includes('"suggestions"'))).toBe(false);
    const stopped = f.frames.filter(data => data !== "[DONE]").map(data => JSON.parse(data))
      .filter(frame => frame.choices?.[0]?.finish_reason === "stop");
    expect(stopped).toHaveLength(1);
    expect(stopped[0].choices[0].error).toBeDefined();
    expect(f.store.updateMessage).toHaveBeenCalledTimes(canonical ? 0 : 1);
    expect(f.store.commitCanonicalTurn).toHaveBeenCalledTimes(canonical ? 1 : 0);
    expect(f.execution.deps.onCanonicalTurnCommitted).not.toHaveBeenCalled();
    expect(f.onCompletionFinished).toHaveBeenCalledOnce();
    expect(f.onResponseFinished).toHaveBeenCalledOnce();
  });
});
