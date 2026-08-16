import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createOfficialChannelAdapter } from "../providers.js";

describe("official webhook verification", () => {
  it("accepts a current Slack signature and rejects a forged one", async () => {
    const secret = "slack-signing-secret";
    const adapter = createOfficialChannelAdapter({
      credentialRevision: "1",
      credentials: { botToken: "xoxb-test", signingSecret: secret },
      id: "slack-1",
      provider: "slack",
    });
    const body = JSON.stringify({ challenge: "challenge", type: "url_verification" });
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const signature = `v0=${createHmac("sha256", secret)
      .update(`v0:${timestamp}:${body}`)
      .digest("hex")}`;
    const request = (value: string) => new Request("https://example.test", {
      body,
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": value,
      },
      method: "POST",
    });

    expect((await adapter.handleWebhook(request(signature))).status).toBe(200);
    expect((await adapter.handleWebhook(request("v0=forged"))).status).toBe(401);
  });

  it("enforces the Telegram webhook secret token", async () => {
    const adapter = createOfficialChannelAdapter({
      credentialRevision: "1",
      credentials: { botToken: "123:test", secretToken: "telegram-secret" },
      id: "telegram-1",
      provider: "telegram",
    });
    const request = (secret: string) => new Request("https://example.test", {
      body: JSON.stringify({ update_id: 42 }),
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": secret,
      },
      method: "POST",
    });

    expect((await adapter.handleWebhook(request("telegram-secret"))).status).toBe(200);
    expect((await adapter.handleWebhook(request("wrong"))).status).toBe(401);
  });

  it("verifies Discord Ed25519 interaction signatures", async () => {
    const keys = generateKeyPairSync("ed25519");
    const publicKey = (keys.publicKey.export({ format: "der", type: "spki" }) as Buffer)
      .subarray(12)
      .toString("hex");
    const adapter = createOfficialChannelAdapter({
      credentialRevision: "1",
      credentials: {
        applicationId: "application-1",
        botToken: "discord-token",
        publicKey,
      },
      id: "discord-1",
      provider: "discord",
    });
    const body = JSON.stringify({ type: 1 });
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const signature = sign(
      null,
      Buffer.from(timestamp + body),
      keys.privateKey,
    ).toString("hex");
    const request = (value: string) => new Request("https://example.test", {
      body,
      headers: {
        "content-type": "application/json",
        "x-signature-ed25519": value,
        "x-signature-timestamp": timestamp,
      },
      method: "POST",
    });

    expect((await adapter.handleWebhook(request(signature))).status).toBe(200);
    expect((await adapter.handleWebhook(request("00".repeat(64)))).status).toBe(401);
  });

  it("verifies WhatsApp HMAC signatures", async () => {
    const appSecret = "whatsapp-app-secret";
    const adapter = createOfficialChannelAdapter({
      credentialRevision: "1",
      credentials: {
        accessToken: "access-token",
        appSecret,
        phoneNumberId: "phone-1",
        verifyToken: "verify-token",
      },
      id: "whatsapp-1",
      provider: "whatsapp",
    });
    const body = JSON.stringify({
      entry: [{ changes: [{ field: "statuses", value: {} }] }],
    });
    const signature = `sha256=${createHmac("sha256", appSecret)
      .update(body)
      .digest("hex")}`;
    const request = (value: string) => new Request("https://example.test", {
      body,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": value,
      },
      method: "POST",
    });

    expect((await adapter.handleWebhook(request(signature))).status).toBe(200);
    expect((await adapter.handleWebhook(request("sha256=forged"))).status).toBe(401);
  });
});
