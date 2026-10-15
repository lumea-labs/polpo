import { describe, expect, it, vi } from "vitest";
import { PolpoConnectClient, type PolpoConnectClientOptions } from "../client/index.js";

describe("Connect client project environments", () => {
  it.each(["development", "production"] as const)("binds API, MCP, OAuth and setup calls to %s", async environment => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ ok: true, data: {} }));
    const client = new PolpoConnectClient({ baseUrl: "https://host.example/api/", environment,
      headers: { authorization: "Bearer fixture-key" }, fetch: fetchImpl });
    await client.createProjectApiKeyConnection("project/one", { providerId: "custom", apiKey: "fixture-secret" });
    await client.startProjectMcpOAuth("project/one", { url: "https://mcp.example", mode: "dynamic" });
    await client.completeOAuth({ state: "fixture-state", code: "fixture-code" });
    await client.getSetupStatus("setup/one");
    await client.gatewayRequest("connection/one", { request: { method: "GET", path: "/items" } });
    expect(client.environment).toBe(environment);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      `/v1/projects/project%2Fone/connect/connections/api-key`,
      `/v1/projects/project%2Fone/connect/mcp/oauth/start`,
      `/v1/connect/oauth/callback`,
      `/v1/connect/setup/setup%2Fone/status`,
      `/v1/connect/connections/connection%2Fone/request`,
    ].map(path => `https://host.example/api/environments/${environment}${path}`));
    for (const [, init] of fetchImpl.mock.calls) {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-key");
    }
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({ providerId: "custom", apiKey: "fixture-secret" });
  });

  it("keeps interleaved clients and the unscoped compatibility path independent", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ ok: true, data: [] }));
    const development = new PolpoConnectClient({ baseUrl: "https://host.example", environment: "development", fetch: fetchImpl });
    const production = new PolpoConnectClient({ baseUrl: "https://host.example/environments/production", environment: "production", fetch: fetchImpl });
    const legacy = new PolpoConnectClient({ baseUrl: "https://host.example", fetch: fetchImpl });
    await Promise.all([development.listConnections(), production.listConnections(), legacy.listConnections()]);
    await development.listConnections();
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "https://host.example/environments/development/v1/connect/connections",
      "https://host.example/environments/production/v1/connect/connections",
      "https://host.example/v1/connect/connections",
      "https://host.example/environments/development/v1/connect/connections",
    ]);
    expect(legacy.environment).toBeUndefined();
  });

  it("rejects invalid and conflicting selectors before retrieving credentials or making requests", () => {
    const headers = vi.fn(), fetchImpl = vi.fn();
    expect(() => new PolpoConnectClient({ baseUrl: "https://host.example", environment: "test", headers, fetch: fetchImpl } as unknown as PolpoConnectClientOptions)).toThrow(/environment/i);
    expect(() => new PolpoConnectClient({ baseUrl: "https://host.example/environments/production", environment: "development", headers, fetch: fetchImpl })).toThrow(/conflicts/i);
    expect(headers).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not silently escape an environment to change organization OAuth configuration", async () => {
    const headers = vi.fn(), fetchImpl = vi.fn();
    const client = new PolpoConnectClient({ baseUrl: "https://host.example", environment: "development", headers, fetch: fetchImpl });
    await expect(client.listOrganizationOAuthClients("org")).rejects.toThrow(/organization.*environment/i);
    await expect(client.configureOrganizationOAuthClient("org", "google", { clientId: "id", clientSecret: "secret" })).rejects.toThrow(/organization.*environment/i);
    await expect(client.revokeOrganizationOAuthClient("org", "google")).rejects.toThrow(/organization.*environment/i);
    await expect(client.listMcpOAuthConfigurations({ type: "organization", id: "org" })).rejects.toThrow(/organization.*environment/i);
    expect(headers).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never retries an unavailable Development endpoint against Production or the unscoped host", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ ok: false, error: "Environment unavailable" }, { status: 503 }));
    const client = new PolpoConnectClient({ baseUrl: "https://host.example", environment: "development", fetch: fetchImpl });
    await expect(client.createPublicConnection({ providerId: "public" })).rejects.toThrow("Environment unavailable");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://host.example/environments/development/v1/connect/connections/public");
  });
});
