import { MemoryStateAdapter } from "@chat-adapter/state-memory";
import { createMockAdapter, createTestMessage } from "@chat-adapter/tests";
import type { Adapter, ChatInstance } from "chat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelRuntime } from "../runtime.js";
import { CHANNEL_SUGGESTION_PREFIX } from "../suggestions.js";
import type { ChannelInboundTurn, TelegramChannelInstallation } from "../types.js";

const installation: TelegramChannelInstallation = { id: "install", provider: "telegram", credentialRevision: "rev",
  credentials: { botToken: "test" }, concurrency: { strategy: "concurrent" } };
const source = { sessionId: "session", assistantMessageId: "assistant", agent: "leo", user: "trusted-user" };
const runtimes: ChannelRuntime[] = [];
afterEach(async () => { await Promise.all(runtimes.splice(0).map(runtime => runtime.shutdown())); });
function setup(options: { enabled?: boolean; failControls?: boolean; events?: boolean; state?: MemoryStateAdapter } = {}) {
  let chat: ChatInstance; let adapter: Adapter;
  const turns: ChannelInboundTurn[] = [];
  const onEvent = vi.fn();
  const postMessage = vi.fn(async (_threadId, message) => {
    if (options.failControls && postMessage.mock.calls.length > 1) throw new Error("provider unavailable");
    return { id: `sent-${postMessage.mock.calls.length}`, threadId: "telegram:chat", raw: message };
  });
  adapter = createMockAdapter("telegram", {
    initialize: async instance => { chat = instance; }, isDM: () => true, postMessage,
    handleWebhook: async request => {
      const body = await request.json() as { id: string; actionId?: string; user?: string };
      const user = { userId: body.user ?? "recipient", fullName: "Ada", userName: "ada", isBot: false, isMe: false };
      if (body.actionId) await chat.processAction({ adapter, actionId: body.actionId,
        messageId: "sent-2", threadId: "telegram:chat", user, raw: { id: body.id }, value: "UNTRUSTED" });
      else await chat.processMessage(adapter, "telegram:chat", createTestMessage(body.id, "Hello", { author: user }));
      return new Response("ok");
    },
  });
  const handleTurn = vi.fn(async (turn, context) => {
    turns.push(turn);
    if (turn.suggestionSelection) {
      await context.deliverProgress({ text: "Working" }, { idempotencyKey: "ack" });
      return { text: "Done" };
    }
    return { text: "Original answer", suggestions: { source, items: [{ id: "choice", label: "Next", prompt: "Exact canonical prompt" }] } };
  });
  const handleEvent = vi.fn(async (event, context) => event.type === "message" ? handleTurn(event, context) : undefined);
  const runtime = new ChannelRuntime({ adapterFactory: () => adapter, stateFactory: () => options.state ?? new MemoryStateAdapter(),
    suggestions: options.enabled ?? true, onEvent, ...(options.events ? { handleEvent } : { handleTurn }) });
  runtimes.push(runtime);
  const webhook = (body: unknown) => runtime.handleWebhook(installation, new Request("https://local.test", {
    method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" },
  }));
  const callbackId = () => JSON.stringify(postMessage.mock.calls[1]?.[1]).match(/polpo_suggestion:[a-f0-9]{32}:0/)?.[0];
  return { runtime, webhook, callbackId, handleTurn, handleEvent, onEvent, turns, postMessage };
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
  it("rejects application actions claiming the reserved namespace", async () => {
    const f = setup();
    await expect(f.runtime.post(installation, "telegram:chat", { text: "Unsafe", actions: [{
      id: `${CHANNEL_SUGGESTION_PREFIX}fake`, label: "Next", type: "postback", value: "ordinary",
    }] })).rejects.toThrow("namespace is reserved");
    expect(f.postMessage).not.toHaveBeenCalled();
  });
});
