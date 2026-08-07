import { describe, expect, it, vi } from "vitest";
import { dispatchChannelWebhook } from "../webhook.js";
import type { ChannelRuntime } from "../runtime.js";
import type { TelegramChannelInstallation } from "../types.js";

const installation: TelegramChannelInstallation = {
  concurrency: { strategy: "concurrent" },
  credentialRevision: "revision-1",
  credentials: { botToken: "token" },
  id: "installation-1",
  provider: "telegram",
};

describe("dispatchChannelWebhook", () => {
  it("rejects unsupported providers before resolving an installation", async () => {
    const resolveInstallation = vi.fn();
    const runtime = { handleWebhook: vi.fn() } as unknown as ChannelRuntime;

    const response = await dispatchChannelWebhook({
      provider: "unknown",
      request: new Request("https://example.test", { method: "POST" }),
      resolveInstallation,
      runtime,
    });

    expect(response.status).toBe(404);
    expect(resolveInstallation).not.toHaveBeenCalled();
    expect(runtime.handleWebhook).not.toHaveBeenCalled();
  });

  it("fails closed when the route resolves no installation", async () => {
    const runtime = { handleWebhook: vi.fn() } as unknown as ChannelRuntime;
    const response = await dispatchChannelWebhook({
      provider: "telegram",
      request: new Request("https://example.test", { method: "POST" }),
      resolveInstallation: async () => null,
      routeKey: "opaque-key",
      runtime,
    });

    expect(response.status).toBe(404);
    expect(runtime.handleWebhook).not.toHaveBeenCalled();
  });

  it("never dispatches a cross-provider installation", async () => {
    const runtime = { handleWebhook: vi.fn() } as unknown as ChannelRuntime;
    const response = await dispatchChannelWebhook({
      provider: "slack",
      request: new Request("https://example.test", { method: "POST" }),
      resolveInstallation: async () => installation,
      runtime,
    });

    expect(response.status).toBe(404);
    expect(runtime.handleWebhook).not.toHaveBeenCalled();
  });

  it("lets candidate resolution inspect a clone without consuming the signed body", async () => {
    const request = new Request("https://example.test", {
      body: JSON.stringify({ update_id: 42 }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const seen: string[] = [];
    const runtime = {
      handleWebhook: vi.fn(async (_installation, original: Request) => {
        seen.push(await original.text());
        return new Response("ok");
      }),
    } as unknown as ChannelRuntime;

    const response = await dispatchChannelWebhook({
      provider: "telegram",
      request,
      resolveInstallation: async ({ request: clone, routeKey }) => {
        expect(routeKey).toBe("opaque-key");
        seen.push(await clone.text());
        return installation;
      },
      routeKey: "opaque-key",
      runtime,
    });

    expect(response.status).toBe(200);
    expect(seen).toEqual([
      JSON.stringify({ update_id: 42 }),
      JSON.stringify({ update_id: 42 }),
    ]);
  });
});
