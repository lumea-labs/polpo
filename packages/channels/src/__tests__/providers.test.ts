import { describe, expect, it } from "vitest";
import { createOfficialChannelAdapter } from "../providers.js";
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
});
