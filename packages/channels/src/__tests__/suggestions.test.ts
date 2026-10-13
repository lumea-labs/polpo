import { MemoryStateAdapter } from "@chat-adapter/state-memory";
import { describe, expect, it, vi } from "vitest";
import { ChannelSuggestionSets, CHANNEL_SUGGESTION_PREFIX } from "../suggestions.js";

const binding = { provider: "whatsapp" as const, installationId: "install", credentialRevision: "rev",
  threadId: "whatsapp:phone:user", recipientId: "user", isDirectMessage: true };
const presentation = { source: { sessionId: "session", assistantMessageId: "assistant", sessionVersion: 2,
  agent: "leo", user: "app-user", scope: { key: "tenant", version: "1" } },
  items: [{ id: "next", label: "Next", prompt: "Show my site" }] };
async function setup() {
  const state = new MemoryStateAdapter(); await state.connect();
  const sets = new ChannelSuggestionSets(state);
  const pending = await sets.prepare(binding, presentation);
  return { state, sets, pending, callback: { ...binding, actionId: pending.choices[0].id,
    providerEventId: "reply", sourceMessageId: "outbound" } };
}

describe("opaque Channel suggestion selections", () => {
  it("publishes bounded opaque IDs and claims a set exactly once across instances", async () => {
    const f = await setup();
    expect(f.callback.actionId.startsWith(CHANNEL_SUGGESTION_PREFIX)).toBe(true);
    expect(f.callback.actionId.length).toBeLessThanOrEqual(64);
    expect(f.callback.actionId).not.toContain("session");
    await f.sets.activate(f.pending.token, binding, "outbound");
    const claims = await Promise.all([f.sets.claim(f.callback), new ChannelSuggestionSets(f.state).claim({ ...f.callback, providerEventId: "reply-2" })]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)?.item.prompt).toBe("Show my site");
    expect(await f.sets.claim(f.callback)).toBeNull();
  });
  it("does not admit a callback before successful delivery", async () => {
    const f = await setup();
    expect(await f.sets.claim(f.callback)).toBeNull();
  });
  it.each([
    { recipientId: "attacker" }, { threadId: "other" }, { installationId: "other" },
    { credentialRevision: "rotated" }, { provider: "telegram" }, { sourceMessageId: "other" },
    { actionId: `${CHANNEL_SUGGESTION_PREFIX}malformed` },
  ])("rejects a mismatched binding %j without consuming the valid selection", async change => {
    const f = await setup(); await f.sets.activate(f.pending.token, binding, "outbound");
    expect(await f.sets.claim({ ...f.callback, ...change } as typeof f.callback)).toBeNull();
    expect(await f.sets.claim(f.callback)).not.toBeNull();
  });
  it("expires controls after at most 24 hours", async () => {
    const f = await setup(); await f.sets.activate(f.pending.token, binding, "outbound");
    const now = Date.now(); const clock = vi.spyOn(Date, "now").mockReturnValue(now + 86_400_001);
    try { expect(await f.sets.claim(f.callback)).toBeNull(); } finally { clock.mockRestore(); }
  });
  it("fails closed if its short state lock has been lost", async () => {
    const f = await setup(); await f.sets.activate(f.pending.token, binding, "outbound");
    vi.spyOn(f.state, "extendLock").mockResolvedValue(false);
    expect(await f.sets.claim(f.callback)).toBeNull();
  });
  it("retains a claim when dispatch outcome is unknown", async () => {
    const f = await setup(); await f.sets.activate(f.pending.token, binding, "outbound");
    expect(await f.sets.claim(f.callback)).not.toBeNull();
    // Simulated process death before a terminal transition: never re-dispatch.
    expect(await new ChannelSuggestionSets(f.state).claim({ ...f.callback, providerEventId: "retry" })).toBeNull();
  });
  it("does not replay after a state write fails immediately after the atomic claim", async () => {
    const f = await setup(); await f.sets.activate(f.pending.token, binding, "outbound");
    const failure = vi.spyOn(f.state, "set").mockRejectedValueOnce(new Error("interrupted"));
    await expect(f.sets.claim(f.callback)).rejects.toThrow("interrupted");
    failure.mockRestore();
    expect(await new ChannelSuggestionSets(f.state).claim({ ...f.callback, providerEventId: "retry" })).toBeNull();
  });
  it("admits a queued claim once across replicas, with the original event binding", async () => {
    const f = await setup(); await f.sets.activate(f.pending.token, binding, "outbound");
    expect(await f.sets.admit(f.callback)).toBeNull();
    await f.sets.claim(f.callback);
    for (const change of [{ providerEventId: "forged" }, { recipientId: "other" }, { sourceMessageId: "other" },
      { threadId: "other" }, { credentialRevision: "other" }, { actionId: f.callback.actionId.replace(/:0$/, ":1") }]) {
      expect(await f.sets.admit({ ...f.callback, ...change })).toBeNull();
    }
    const attempts = await Promise.all([f.sets.admit(f.callback), new ChannelSuggestionSets(f.state).admit(f.callback)]);
    expect(attempts.filter(Boolean)).toHaveLength(1);
    expect(attempts.find(Boolean)?.item.prompt).toBe("Show my site");
    expect(await f.sets.admit(f.callback)).toBeNull();
  });
  it("rejects a claim that expires while waiting in the queue", async () => {
    const f = await setup(); await f.sets.activate(f.pending.token, binding, "outbound");
    await f.sets.claim(f.callback);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 86_400_001);
    try { expect(await f.sets.admit(f.callback)).toBeNull(); } finally { clock.mockRestore(); }
  });
  it("does not admit controls when activation failed after provider acceptance", async () => {
    const f = await setup();
    const failure = vi.spyOn(f.state, "set").mockRejectedValueOnce(new Error("interrupted"));
    await expect(f.sets.activate(f.pending.token, binding, "outbound")).rejects.toThrow();
    failure.mockRestore();
    expect(await f.sets.claim(f.callback)).toBeNull();
  });
});
