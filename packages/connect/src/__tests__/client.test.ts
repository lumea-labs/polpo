import { describe, expect, it, vi } from "vitest";

import { openConnectionSetup, PolpoConnectClient } from "../client/index.js";

describe("PolpoConnectClient", () => {
  it("unwraps server envelopes for setup and gateway requests", async () => {
    const responses = [
      ok({
        id: "connsetup_1",
        providerId: "github",
        oauthClientId: "oauth_1",
        projectId: "project-1",
        audience: "end_user",
        subject: { type: "external_user", namespace: "app", id: "user-1" },
        scopes: ["repo"],
        returnUrl: "https://app.example/settings",
        createdAt: "2026-08-31T00:00:00.000Z",
        expiresAt: "2026-08-31T00:10:00.000Z",
      }),
      ok({ authorizationUrl: "https://github.com/login/oauth/authorize", state: "state-1", expiresAt: "soon" }),
      ok({ status: 200, headers: {}, body: { login: "octocat" } }),
    ];
    const fetchImpl = vi.fn(async () => responses.shift()!);
    const client = new PolpoConnectClient({ baseUrl: "https://api.polpo.test", fetch: fetchImpl as typeof fetch });

    await expect(client.createSetupSession({
      providerId: "github",
      projectId: "project-1",
      audience: "end_user",
      subject: { type: "external_user", namespace: "app", id: "user-1" },
      scopes: ["repo"],
      returnUrl: "https://app.example/settings",
      oauthClientMode: "managed",
    })).resolves.toMatchObject({ id: "connsetup_1" });
    await expect(client.startOAuthSetup("connsetup_1")).resolves.toMatchObject({ state: "state-1" });
    await expect(client.gatewayRequest("connection/one", {
      request: { method: "GET", path: "/user" },
    })).resolves.toMatchObject({ status: 200, body: { login: "octocat" } });

    expect(fetchImpl.mock.calls[2]![0]).toBe(
      "https://api.polpo.test/v1/connect/connections/connection%2Fone/request",
    );
  });

  it("keeps compatibility with endpoints that return raw JSON", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([{ id: "github" }]), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const client = new PolpoConnectClient({ baseUrl: "https://api.polpo.test", fetch: fetchImpl as typeof fetch });
    await expect(client.listProviders()).resolves.toEqual([{ id: "github" }]);
  });

  it("uses canonical Cloud routes for MCP reconnect and verification", async () => {
    const responses = [
      ok({ authorizationUrl: "https://provider.example/authorize", state: "state-1" }),
      ok({ tools: [{ name: "search" }, { name: "read" }] }),
    ];
    const fetchImpl = vi.fn(async () => responses.shift()!);
    const client = new PolpoConnectClient({
      baseUrl: "https://api.polpo.test",
      fetch: fetchImpl as typeof fetch,
    });

    await expect(client.reconnectProjectMcpConnection("project/one", "connection/one"))
      .resolves.toMatchObject({ state: "state-1" });
    await expect(client.verifyProjectMcpConnection("project/one", "connection/one"))
      .resolves.toEqual({ ok: true, toolCount: 2 });

    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
      "https://api.polpo.test/v1/projects/project%2Fone/connect/connections/connection%2Fone/reconnect",
      "https://api.polpo.test/v1/projects/project%2Fone/connect/connections/connection%2Fone/mcp/discover",
    ]);
  });

  it("uses logical application capabilities without exposing a physical Connection at invocation time", async () => {
    const responses = [
      ok([{ capabilityId: "github.repositories", status: "active" }]),
      ok({ capabilityId: "github.repositories", status: "active" }),
      ok({ status: 200, headers: {}, body: { repositories: [] } }),
      ok({ capabilityId: "github.repositories", status: "revoked" }),
    ];
    const fetchImpl = vi.fn(async () => responses.shift()!);
    const client = new PolpoConnectClient({
      baseUrl: "https://api.polpo.test/",
      headers: { authorization: "Bearer project-key" },
      fetch: fetchImpl as typeof fetch,
    });

    await client.listApplicationCapabilities("project/one");
    await client.configureApplicationCapability("project/one", "github.repositories", {
      connectionId: "connection-secret-selection",
      scopes: ["repo"],
      allowedOperations: [{ methods: ["GET"], pathPatterns: ["/user/repos"] }],
    });
    await expect(client.requestApplicationCapability("project/one", "github.repositories", {
      invocation: {
        user: "user-1",
        metadata: { tenantId: "tenant-1" },
        scope: { key: "site-1", version: "3" },
      },
      request: { method: "GET", path: "/user/repos" },
    })).resolves.toMatchObject({ status: 200, body: { repositories: [] } });
    await client.revokeApplicationCapability("project/one", "github.repositories");

    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
      "https://api.polpo.test/v1/projects/project%2Fone/connect/application-capabilities?status=active",
      "https://api.polpo.test/v1/projects/project%2Fone/connect/application-capabilities/github.repositories",
      "https://api.polpo.test/v1/projects/project%2Fone/connect/capabilities/github.repositories/request",
      "https://api.polpo.test/v1/projects/project%2Fone/connect/application-capabilities/github.repositories",
    ]);
    expect(JSON.parse(String(fetchImpl.mock.calls[2]![1]?.body))).not.toHaveProperty("connectionId");
  });

  it("supports embedded setup status, cancellation, and bounded sanitized events", async () => {
    const responses = [
      ok({ id: "setup-token", setupUrl: "https://polpo.sh/connect/setup/setup-token" }),
      ok({ providerId: "github", projectId: "project-1", status: "pending" }),
      ok({ providerId: "github", projectId: "project-1", status: "cancelled" }),
      ok([{ id: "event-1", eventType: "connection.used", status: "success" }]),
    ];
    const fetchImpl = vi.fn(async () => responses.shift()!);
    const client = new PolpoConnectClient({ baseUrl: "https://api.polpo.test", fetch: fetchImpl as typeof fetch });

    await client.createProjectSetupSession("project-1", {
      providerId: "github",
      audience: "end_user",
      subject: { type: "external_user", namespace: "app", id: "user-1" },
      returnUrl: "https://app.example/settings",
      oauthClientMode: "managed",
    });
    await client.getSetupStatus("setup/token");
    await client.cancelSetupSession("setup/token");
    await client.listConnectionEvents("project-1", "connection/one", 25);

    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
      "https://api.polpo.test/v1/projects/project-1/connect/setup-sessions",
      "https://api.polpo.test/v1/connect/setup/setup%2Ftoken/status",
      "https://api.polpo.test/v1/connect/setup/setup%2Ftoken/cancel",
      "https://api.polpo.test/v1/projects/project-1/connect/connections/connection%2Fone/events?limit=25",
    ]);
    expect(() => client.listConnectionEvents("project-1", "connection-1", 0)).toThrow(/between 1 and 200/);
  });

  it("opens and observes embedded setup without placing credentials in the browser", async () => {
    const popup = { closed: false } as Window;
    const open = vi.fn(() => popup);
    expect(openConnectionSetup("https://polpo.sh/connect/setup/token", { open })).toBe(popup);
    expect(open).toHaveBeenCalledWith(
      "https://polpo.sh/connect/setup/token",
      "polpo-connect",
      expect.stringContaining("popup"),
    );
    expect(() => openConnectionSetup("javascript:alert(1)", { open })).toThrow(/HTTP or HTTPS/);
    expect(() => openConnectionSetup("https://polpo.sh/connect/setup/token", { open: () => null }))
      .toThrow(/blocked/);

    const fetchImpl = vi.fn(async () => ok({
      providerId: "github",
      projectId: "project-1",
      status: "completed",
      expiresAt: "2026-08-31T00:10:00.000Z",
    }));
    const client = new PolpoConnectClient({ baseUrl: "https://api.polpo.test", fetch: fetchImpl as typeof fetch });
    await expect(client.waitForSetupCompletion("setup-token", { timeoutMs: 100 }))
      .resolves.toMatchObject({ status: "completed" });
  });

  it("administers customer OAuth Clients without reading their client secret", async () => {
    const clientRecord = {
      id: "oauthclient-1",
      providerId: "github",
      owner: { type: "project", id: "project-1" },
      clientId: "client-id",
      hasSecret: true,
      status: "active",
    };
    const responses = [
      ok([clientRecord]),
      ok(clientRecord),
      ok({ ...clientRecord, status: "revoked", hasSecret: false }),
      ok([{ ...clientRecord, owner: { type: "organization", id: "org-1" } }]),
    ];
    const fetchImpl = vi.fn(async () => responses.shift()!);
    const client = new PolpoConnectClient({ baseUrl: "https://api.polpo.test", fetch: fetchImpl as typeof fetch });

    await client.listProjectOAuthClients("project/one");
    await client.configureProjectOAuthClient("project/one", "github", {
      clientId: "client-id",
      clientSecret: "write-only-secret",
      returnOrigins: ["https://app.example"],
    });
    await client.revokeProjectOAuthClient("project/one", "github");
    await client.listOrganizationOAuthClients("org/one");

    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
      "https://api.polpo.test/v1/projects/project%2Fone/connect/oauth-clients",
      "https://api.polpo.test/v1/projects/project%2Fone/connect/oauth-clients/github",
      "https://api.polpo.test/v1/projects/project%2Fone/connect/oauth-clients/github",
      "https://api.polpo.test/v1/orgs/org%2Fone/connect/oauth-clients",
    ]);
    expect(JSON.parse(String(fetchImpl.mock.calls[1]![1]?.body))).toMatchObject({
      clientSecret: "write-only-secret",
    });
  });
});

function ok(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
