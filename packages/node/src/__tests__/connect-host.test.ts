import { describe, expect, it } from "vitest";
import { createConnectService, MemoryConnectStore, MemoryConnectionSecretStore } from "@polpo-ai/connect-server";
import { createApp } from "../server/app.js";

describe("self-hosted Connect HTTP wiring", () => {
  it("mounts Connect behind the normal server authentication only when explicitly configured", async () => {
    const connectService = createConnectService({ providers: [], store: new MemoryConnectStore(), secrets: new MemoryConnectionSecretStore() });
    const app = createApp({ isInitialized: true } as never, {} as never, { connectService, apiKeys: ["local-control-key"] });
    expect((await app.request("/api/v1/connect/catalog")).status).toBe(401);
    const response = await app.request("/api/v1/connect/catalog", { headers: { authorization: "Bearer local-control-key" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: [] });
    const unconfigured = createApp({ isInitialized: true } as never, {} as never);
    expect((await unconfigured.request("/api/v1/connect/catalog")).status).toBe(404);
  });
});
