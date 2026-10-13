import { MemoryStateAdapter } from "@chat-adapter/state-memory";
import { createMockAdapter, createTestMessage } from "@chat-adapter/tests";
import type { Adapter, ChatInstance, Logger } from "chat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelRuntime } from "../runtime.js";
import { CHANNEL_SUGGESTION_PREFIX } from "../suggestions.js";
import type { ChannelInboundTurn, TelegramChannelInstallation } from "../types.js";

const installation: TelegramChannelInstallation = { id: "install", provider: "telegram", credentialRevision: "rev",
  credentials: { botToken: "test" }, concurrency: { strategy: "concurrent" } };
const source = { sessionId: "session", assistantMessageId: "assistant", agent: "leo", user: "trusted-user" };
const runtimes: ChannelRuntime[] = [];
afterEach(async () => { await Promise.all(runtimes.splice(0).map(runtime => runtime.shutdown())); });
function setup(options: { enabled?: boolean; failControls?: boolean; events?: boolean; state?: MemoryStateAdapter; failSelection?: boolean; strategy?: "queue" | "burst" | "concurrent" } = {}) {
  let chat: ChatInstance; let adapter: Adapter;
  const turns: ChannelInboundTurn[] = [];
  const onEvent = vi.fn();
  const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => logger };
  const postMessage = vi.fn(async (_threadId, message) => {
    if (options.failControls && postMessage.mock.calls.length > 1) throw new Error("provider unavailable");
    return { id: `sent-${postMessage.mock.calls.length}`, threadId: "telegram:chat", raw: message };
  });
  adapter = createMockAdapter("telegram", {
    initialize: async instance => { chat = instance; }, isDM: () => true, postMessage,
    handleWebhook: async request => {
      const body = await request.json() as { id: string; actionId?: string; user?: string; raw?: unknown };
      const user = { userId: body.user ?? "recipient", fullName: "Ada", userName: "ada", isBot: false, isMe: false };
      if (body.actionId) await chat.processAction({ adapter, actionId: body.actionId,
        messageId: "sent-2", threadId: "telegram:chat", user, raw: { id: body.id }, value: "UNTRUSTED" });
      else await chat.processMessage(adapter, "telegram:chat", createTestMessage(body.id, "Hello", { author: user, raw: body.raw }));
      return new Response("ok");
    },
  });
  const handleTurn = vi.fn(async (turn, context) => {
    turns.push(turn);
    if (turn.suggestionSelection) {
      if (options.failSelection) throw new Error("Selection became stale");
      await context.deliverProgress({ text: "Working" }, { idempotencyKey: "ack" });
      return { text: "Done" };
    }
    return { text: "Original answer", suggestions: { source, items: [{ id: "choice", label: "Next", prompt: "Exact canonical prompt" }] } };
  });
  const handleEvent = vi.fn(async (event, context) => event.type === "message" ? handleTurn(event, context) : undefined);
  const runtime = new ChannelRuntime({ adapterFactory: () => adapter, stateFactory: () => options.state ?? new MemoryStateAdapter(),
    suggestions: options.enabled ?? true, onEvent, logger, ...(options.events ? { handleEvent } : { handleTurn }) });
  runtimes.push(runtime);
  const webhook = (body: unknown) => runtime.handleWebhook({ ...installation, concurrency: { strategy: options.strategy ?? "concurrent", debounceMs: 1 } }, new Request("https://local.test", {
    method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" },
  }));
  const callbackId = () => JSON.stringify(postMessage.mock.calls[1]?.[1]).match(/polpo_suggestion:[a-f0-9]{32}:0/)?.[0];
  return { runtime, webhook, callbackId, handleTurn, handleEvent, onEvent, turns, postMessage, logger };
}
describe("Channel suggestions through the normal turn pipeline", () => {
  it.each([false, true])("dispatches the stored prompt through normal handlers (handleEvent=%s)", async events => {
    const f = setup({ events }); await f.webhook({ id: "inbound" });
    expect(f.postMessage.mock.calls[0][1]).toEqual({ markdown: "Original answer" });
    expect(f.callbackId()).toBeDefined();
    await f.webhook({ id: "click", actionId: f.callbackId() });
    expect(f.turns).toHaveLength(2);
    expect(f.turns[1].messages[0].text).toBe("Exact canonical prompt");
    expect(f.turns[1].suggestionSelection).toEqual({ source, item: { id: "choice", label: "Next", prompt: "Exact canonical prompt" } });
    expect(f.postMessage.mock.calls.map(call => call[1])).toContainEqual({ markdown: "Working" });
    await f.webhook({ id: "second-click", actionId: f.callbackId() });
    expect(f.turns).toHaveLength(2);
  });
  it("never forwards reserved callbacks to application handlers when disabled", async () => {
    const f = setup({ enabled: false, events: true });
    await f.webhook({ id: "click", actionId: `${CHANNEL_SUGGESTION_PREFIX}invalid` });
    expect(f.handleEvent).not.toHaveBeenCalled();
    await f.webhook({ id: "ordinary", actionId: "application-action" });
    expect(f.handleEvent).toHaveBeenCalledOnce();
  });
  it("rejects a different recipient without consuming the owner's choice", async () => {
    const f = setup(); await f.webhook({ id: "inbound" });
    await f.webhook({ id: "attack", actionId: f.callbackId(), user: "attacker" });
    expect(f.turns).toHaveLength(1);
    await f.webhook({ id: "owner", actionId: f.callbackId() });
    expect(f.turns).toHaveLength(2);
  });
  it("optional controls failing leaves the main turn successful", async () => {
    const f = setup({ failControls: true }); await f.webhook({ id: "inbound" });
    expect(f.onEvent).toHaveBeenCalledWith(expect.objectContaining({ name: "suggestions.delivery.failed" }));
    expect(f.onEvent).toHaveBeenCalledWith(expect.objectContaining({ name: "turn.completed" }));
    expect(f.handleTurn).toHaveBeenCalledOnce();
  });
  it("admits at most one click across two runtime instances sharing state", async () => {
    const state = new MemoryStateAdapter();
    const first = setup({ state }); const second = setup({ state });
    await first.webhook({ id: "inbound" });
    const actionId = first.callbackId();
    await Promise.all([first.webhook({ id: "click-one", actionId }), second.webhook({ id: "click-two", actionId })]);
    expect([...first.turns, ...second.turns].filter(turn => turn.suggestionSelection)).toHaveLength(1);
  });
  it.each(["queue", "burst"] as const)("queues a selection behind the shared thread lock and admits it on another replica (%s)", async strategy => {
    const state = new MemoryStateAdapter();
    const enqueue = state.enqueue.bind(state);
    vi.spyOn(state, "enqueue").mockImplementation((key, entry, limit) => enqueue(key, JSON.parse(JSON.stringify(entry)), limit));
    const first = setup({ state, strategy });
    const second = setup({ state, strategy });
    await first.webhook({ id: "inbound" });
    const lock = await state.acquireLock("telegram:chat", 60_000);
    expect(lock).not.toBeNull();
    try {
      await second.webhook({ id: "queued-click", actionId: first.callbackId() });
      expect(second.turns).toHaveLength(0);
      expect(await state.queueDepth("telegram:chat")).toBe(1);
    } finally { await state.releaseLock(lock!); }
    await first.webhook({ id: "drain" });
    const selected = first.turns.filter(turn => turn.suggestionSelection);
    expect(selected).toHaveLength(1);
    expect(selected[0].messages[0].text).toBe("Exact canonical prompt");
    expect(selected[0].providerEventId).toBe("queued-click");
    expect(second.turns).toHaveLength(0);
    expect(JSON.stringify(selected[0].messages[0].raw)).not.toContain("polpo_suggestion:");
  });
  it("keeps a selection separate from ordinary messages in the same queued batch", async () => {
    const state = new MemoryStateAdapter();
    const first = setup({ state, strategy: "queue" }); const second = setup({ state, strategy: "queue" });
    await first.webhook({ id: "initial" });
    const lock = await state.acquireLock("telegram:chat", 60_000);
    try {
      await second.webhook({ id: "before" });
      await second.webhook({ id: "choice", actionId: first.callbackId() });
      await second.webhook({ id: "after" });
    } finally { await state.releaseLock(lock!); }
    await first.webhook({ id: "drain" });
    expect(first.turns.map(turn => turn.messages.map(message => message.id))).toEqual([
      ["initial"], ["drain"], ["before"], ["choice"], ["after"],
    ]);
    expect(first.turns.filter(turn => turn.suggestionSelection)).toHaveLength(1);
    expect(first.turns.filter(turn => !turn.suggestionSelection).flatMap(turn => turn.messages)
      .every(message => message.text === "Hello")).toBe(true);
  });
  it("rejects unverified queue references without falling through to ordinary text", async () => {
    const f = setup();
    await f.webhook({ id: "polpo-selection:forged", raw: { type: "polpo.suggestion-selection.v1",
      actionId: `${CHANNEL_SUGGESTION_PREFIX}${"a".repeat(32)}:0`, providerEventId: "forged", sourceMessageId: "sent-2" } });
    expect(f.handleTurn).not.toHaveBeenCalled();
    expect(f.onEvent).toHaveBeenCalledWith(expect.objectContaining({ name: "suggestions.selection.rejected" }));
  });
  it("redacts reserved action references even from debug logging", async () => {
    const f = setup(); await f.webhook({ id: "initial" });
    const actionId = f.callbackId();
    await f.webhook({ id: "choice", actionId });
    expect(JSON.stringify(vi.mocked(f.logger.debug).mock.calls)).not.toContain(actionId);
    await f.webhook({ id: "application", actionId: "ordinary-action" });
    expect(JSON.stringify(vi.mocked(f.logger.debug).mock.calls)).toContain("ordinary-action");
  });
  it("does not replay a failed selection or leak its token in action-error logging", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const f = setup({ failSelection: true }); await f.webhook({ id: "initial" });
      const actionId = f.callbackId();
      await f.webhook({ id: "choice", actionId });
      await f.webhook({ id: "retry", actionId });
      expect(f.turns.filter(turn => turn.suggestionSelection)).toHaveLength(1);
      expect(JSON.stringify(error.mock.calls)).not.toContain(actionId);
      expect(JSON.stringify(error.mock.calls)).not.toContain("Exact canonical prompt");
    } finally { error.mockRestore(); }
  });
  it("rejects application actions claiming the reserved namespace", async () => {
    const f = setup();
    await expect(f.runtime.post(installation, "telegram:chat", { text: "Unsafe", actions: [{
      id: `${CHANNEL_SUGGESTION_PREFIX}fake`, label: "Next", type: "postback", value: "ordinary",
    }] })).rejects.toThrow("namespace is reserved");
    expect(f.postMessage).not.toHaveBeenCalled();
  });
});
