import { describe, expect, it, vi } from "vitest";
import type { ChannelRuntime } from "@polpo-ai/channels";
import { createApp } from "../server/app.js";

describe("self-hosted channel webhooks", () => {
  it("mounts the public opaque route and delegates to the OSS dispatcher", async () => {
    const runtime = {
      handleWebhook: vi.fn(async (_installation, request: Request) =>
        Response.json({ body: await request.json(), ok: true })),
      shutdown: vi.fn(),
    } as unknown as ChannelRuntime;
    const resolveInstallation = vi.fn(async () => ({
      concurrency: { strategy: "concurrent" as const },
      credentialRevision: "revision-1",
      credentials: { botToken: "token" },
      id: "installation-1",
      provider: "telegram" as const,
    }));
    const app = createApp({} as never, {} as never, {
      channels: { resolveInstallation, runtime },
    });

    const response = await app.request(
      "/v1/channel-webhooks/telegram/opaque-key",
      {
        body: JSON.stringify({ update_id: 42 }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      body: { update_id: 42 },
      ok: true,
    });
    expect(resolveInstallation).toHaveBeenCalledWith(expect.objectContaining({
      provider: "telegram",
      routeKey: "opaque-key",
    }));
  });

  it("does not mount Channels when no runtime is configured", async () => {
    const app = createApp({} as never, {} as never);
    const response = await app.request("/v1/channel-webhooks/telegram", {
      method: "POST",
    });
    expect(response.status).toBe(404);
  });
});
