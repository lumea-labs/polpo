import { describe, expect, it } from "vitest";
import { createConnectService, MemoryConnectStore, MemoryConnectionSecretStore } from "@polpo-ai/connect-server";
import { createApp } from "../server/app.js";

describe("self-hosted environment HTTP wiring", () => {
  it.each(["development", "production"] as const)("only accepts its bound %s identity and still authenticates", async environment => {
    const service = createConnectService({ providers: [], store: new MemoryConnectStore(), secrets: new MemoryConnectionSecretStore() });
    const app = createApp({ isInitialized: true } as never, {} as never, {
      environment, apiKeys: [`${environment}-key`], connectService: service,
    });
    for (const prefix of [`/environments/${environment}/api/v1`, `/api/environments/${environment}/v1`]) {
      expect((await app.request(`${prefix}/connect/catalog`)).status).toBe(401);
      expect((await app.request(`${prefix}/connect/catalog`, { headers: { authorization: "Bearer other-key" } })).status).toBe(401);
      const response = await app.request(`${prefix}/connect/catalog`, { headers: { authorization: `Bearer ${environment}-key` } });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, data: [] });
    }
    const other = environment === "development" ? "production" : "development";
    expect((await app.request(`/environments/${other}/api/v1/connect/catalog`, { headers: { authorization: `Bearer ${environment}-key` } })).status).toBe(404);
    expect((await app.request(`/environments/${environment}/api/v1/health`)).status).toBe(200);
  });

  it("does not pretend an unbound runtime is either environment", async () => {
    const app = createApp({ isInitialized: true } as never, {} as never);
    expect((await app.request("/api/v1/health")).status).toBe(200);
    expect((await app.request("/environments/development/api/v1/health")).status).toBe(404);
    expect((await app.request("/environments/production/api/v1/health")).status).toBe(404);
    expect((await app.request("/environments")).status).toBe(400);
    expect((await app.request("/api/environments")).status).toBe(400);
  });
});
