import { describe, expect, it, vi } from "vitest";
import {
  channelProviderCapabilities,
  createOfficialChannelAdapter,
} from "../providers.js";
import type { ChannelInstallation } from "../types.js";

const installations: ChannelInstallation[] = [
  {
    credentials: { botToken: "xoxb-test", signingSecret: "signing" },
    credentialRevision: "1",
    id: "slack-1",
    provider: "slack",
  },
  {
    credentials: { botToken: "123:test", secretToken: "secret" },
    credentialRevision: "1",
    id: "telegram-1",
    provider: "telegram",
  },
  {
    credentials: {
      applicationId: "123",
      botToken: "discord-token",
      publicKey: "a".repeat(64),
    },
    credentialRevision: "1",
    id: "discord-1",
    provider: "discord",
  },
  {
    credentials: {
      accessToken: "wa-token",
      appSecret: "app-secret",
      phoneNumberId: "123",
      verifyToken: "verify",
    },
    credentialRevision: "1",
    id: "whatsapp-1",
    provider: "whatsapp",
  },
];

describe("createOfficialChannelAdapter", () => {
  it.each(installations)("creates the official $provider adapter", (installation) => {
    expect(createOfficialChannelAdapter(installation).name).toBe(installation.provider);
  });

  it("suppresses provider-owned typing side effects when disabled", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const adapter = createOfficialChannelAdapter({
      credentials: { botToken: "123:test", secretToken: "secret" },
      credentialRevision: "1",
      id: "telegram-shadow",
      provider: "telegram",
      typingEnabled: false,
    });

    await adapter.startTyping?.("telegram:123");

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("channelProviderCapabilities", () => {
  it("publishes explicit native, fallback, and unsupported behavior", () => {
    expect(channelProviderCapabilities("slack")).toMatchObject({
      actions: "native",
      cards: "native",
      modals: "native",
      streaming: "native",
      voiceReplies: "file-fallback",
    });
    expect(channelProviderCapabilities("telegram")).toMatchObject({
      actions: "native",
      cards: "partial",
      modals: "unsupported",
      streaming: "native",
      voiceReplies: "native",
    });
    expect(channelProviderCapabilities("discord")).toMatchObject({
      cards: "native",
      modals: "unsupported",
      streaming: "fallback",
    });
    expect(channelProviderCapabilities("whatsapp")).toMatchObject({
      cards: "partial",
      files: "native",
      streaming: "buffered",
      voiceReplies: "native",
    });
  });

  it("returns immutable provider capability snapshots", () => {
    const capabilities = channelProviderCapabilities("slack");
    expect(Object.isFrozen(capabilities)).toBe(true);
  });
});
