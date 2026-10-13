import type { ChannelProviderId, ChannelStateAdapter, ChannelSuggestionChoice,
  ChannelSuggestionPresentation, ChannelSuggestionSelection } from "./types.js";

/** Always intercepted, including when negotiation is disabled or an ID is malformed. */
export const CHANNEL_SUGGESTION_PREFIX = "polpo_suggestion:";
const TTL = 24 * 60 * 60_000;
const LOCK_TTL = 5_000;
type Binding = {
  provider: ChannelProviderId; installationId: string; credentialRevision: string;
  threadId: string; recipientId: string; isDirectMessage: boolean;
};
type SelectionSet = Binding & ChannelSuggestionPresentation & {
  expiresAt: number;
  status: "pending_delivery" | "active" | "claimed";
  providerMessageId?: string;
  claimedEventId?: string;
  claimedIndex?: number;
};

/** TTL state, not a second conversation store. Claims are conservatively at-most-once. */
export class ChannelSuggestionSets {
  constructor(private readonly state: ChannelStateAdapter) {}

  async prepare(binding: Binding, presentation: ChannelSuggestionPresentation): Promise<{
    token: string; choices: ChannelSuggestionChoice[];
  }> {
    if (!presentation.items.length || presentation.items.length > 10
      || presentation.items.some(item => !item.id || !item.label.trim() || !item.prompt.trim())) {
      throw new Error("Channel suggestions require 1–10 non-empty choices");
    }
    const token = Array.from(crypto.getRandomValues(new Uint8Array(16)),
      byte => byte.toString(16).padStart(2, "0")).join("");
    await this.state.set(this.key(binding, token), {
      ...binding, ...structuredClone(presentation), expiresAt: Date.now() + TTL,
      status: "pending_delivery",
    } satisfies SelectionSet, TTL);
    return { token, choices: presentation.items.map((item, index) => ({
      id: `${CHANNEL_SUGGESTION_PREFIX}${token}:${index}`, label: item.label,
    })) };
  }

  async activate(token: string, binding: Binding, providerMessageId: string): Promise<boolean> {
    const key = this.key(binding, token);
    const lock = await this.state.acquireLock(key, LOCK_TTL);
    if (!lock) return false;
    try {
      const set = await this.state.get<SelectionSet>(key);
      if (!set || set.status !== "pending_delivery" || set.expiresAt <= Date.now()
        || !providerMessageId || !await this.state.extendLock(lock, LOCK_TTL)) return false;
      await this.state.set(key, { ...set, status: "active", providerMessageId }, set.expiresAt - Date.now());
      return true;
    } finally { await this.state.releaseLock(lock); }
  }

  async claim(input: Omit<Binding, "isDirectMessage"> & {
    actionId: string; providerEventId: string; sourceMessageId?: string;
  }): Promise<(ChannelSuggestionSelection & { isDirectMessage: boolean }) | null> {
    const match = /^polpo_suggestion:([a-f0-9]{32}):([0-9])$/.exec(input.actionId);
    if (!match) return null;
    const key = this.key(input, match[1]);
    const lock = await this.state.acquireLock(key, LOCK_TTL);
    if (!lock) return null;
    try {
      const set = await this.state.get<SelectionSet>(key);
      if (!set || set.status !== "active" || set.expiresAt <= Date.now()
        || set.provider !== input.provider || set.installationId !== input.installationId
        || set.credentialRevision !== input.credentialRevision || set.threadId !== input.threadId
        || set.recipientId !== input.recipientId
        || (input.sourceMessageId !== undefined && set.providerMessageId !== input.sourceMessageId)) return null;
      const item = set.items[Number(match[2])];
      if (!item || !await this.state.extendLock(lock, LOCK_TTL)) return null;
      // NX is also authoritative if a process loses its lock while writing state.
      // Never clear this claim on dispatch failure: tool execution may have started.
      if (!await this.state.setIfNotExists(`${key}:claimed`, true, TTL)) return null;
      await this.state.set(key, { ...set, status: "claimed", claimedEventId: input.providerEventId,
        claimedIndex: Number(match[2]) }, set.expiresAt - Date.now());
      return { source: set.source, item, isDirectMessage: set.isDirectMessage };
    } finally { await this.state.releaseLock(lock); }
  }

  /** Resolve a claimed choice after the normal shared message queue admits it.
   * The queue carries only a reference; its text/raw data is never authority.
   * A separate NX admission survives uncertain execution and duplicate dequeue.
   */
  async admit(input: Omit<Binding, "isDirectMessage"> & {
    actionId: string; providerEventId: string; sourceMessageId: string;
  }): Promise<(ChannelSuggestionSelection & { isDirectMessage: boolean }) | null> {
    const match = /^polpo_suggestion:([a-f0-9]{32}):([0-9])$/.exec(input.actionId);
    if (!match || !input.providerEventId || !input.sourceMessageId) return null;
    const key = this.key(input, match[1]);
    const set = await this.state.get<SelectionSet>(key);
    if (!set || set.status !== "claimed" || set.expiresAt <= Date.now()
      || set.claimedEventId !== input.providerEventId || set.claimedIndex !== Number(match[2])
      || set.provider !== input.provider || set.installationId !== input.installationId
      || set.credentialRevision !== input.credentialRevision || set.threadId !== input.threadId
      || set.recipientId !== input.recipientId || set.providerMessageId !== input.sourceMessageId) return null;
    const item = set.items[Number(match[2])];
    if (!item || !await this.state.setIfNotExists(`${key}:admitted`, true, TTL)
      || set.expiresAt <= Date.now()) return null;
    return { source: set.source, item, isDirectMessage: set.isDirectMessage };
  }

  private key(binding: Pick<Binding, "provider" | "installationId" | "credentialRevision">, token: string) {
    return `polpo:suggestions:v1:${JSON.stringify([binding.provider, binding.installationId, binding.credentialRevision, token])}`;
  }
}
