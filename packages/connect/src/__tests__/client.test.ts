import { describe, expect, it, vi } from "vitest";

import { openConnectionSetup, PolpoConnectClient } from "../client/index.js";

describe("PolpoConnectClient", () => {
  it.each(["project", "organization"] as const)("manages MCP OAuth configurations in the %s control plane without exposing owner/callback inputs", async type => {
    const fetchImpl = vi.fn<typeof fetch>(async () => ok({ id: "configuration", revision: "revision" }));
    const client = new PolpoConnectClient({ baseUrl: "https://host.example", fetch: fetchImpl });
    const owner = { type, id: "owner/one" }, input = { providerId: "mcp_url", resourceUrl: "https://mcp.example/mcp", transport: "http" as const,
      registration: { mode: "pre_registered" as const, client: { client_id: "client", client_secret: "private" } } };
    await client.listMcpOAuthConfigurations(owner);
    await client.createMcpOAuthConfiguration(owner, input);
    await client.updateMcpOAuthConfiguration(owner, "config/one", { ...input, expectedRevision: "v1" });
    await client.revokeMcpOAuthConfiguration(owner, "config/one", "v2");
    const path = `https://host.example/v1/${type === "project" ? "projects" : "orgs"}/owner%2Fone/connect/mcp-oauth-configurations`;
    expect(fetchImpl.mock.calls.map(([url, request]) => [url, request?.method])).toEqual([
      [path, "GET"], [path, "POST"], [`${path}/config%2Fone`, "PUT"], [`${path}/config%2Fone?expectedRevision=v2`, "DELETE"],
    ]);
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body))).toEqual(input);
    expect(JSON.parse(String(fetchImpl.mock.calls[2][1]?.body))).toMatchObject({ expectedRevision: "v1" });
  });

  it("uses project-scoped catalog, definition and setup-readiness routes with configured authentication", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => ok({}));
    const client = new PolpoConnectClient({ baseUrl: "https://host.example", headers: { Authorization: "Bearer fixture-platform-key" }, fetch: fetchImpl });
    const definition = { version: 2 as const, id: "notes", name: "Notes", source: "custom" as const, protocol: "http_api" as const,
      defaultAuthenticationId: "public", authentication: [{ id: "public", type: "none" as const }], http: { origins: ["https://api.example"] } };
    await client.listProjectCatalog("project/one");
    await client.registerProjectConnectorDefinition("project/one", definition);
    await client.disableProjectConnectorDefinition("project/one", "notes/two");
    await client.getProjectSetupReadiness("project/one", { providerId: "notes", authenticationId: "public", oauthClientMode: "customer" });
    expect(fetchImpl.mock.calls.map(call => call[0])).toEqual([
      "https://host.example/v1/projects/project%2Fone/connect/catalog",
      "https://host.example/v1/projects/project%2Fone/connect/connectors",
      "https://host.example/v1/projects/project%2Fone/connect/connectors/notes%2Ftwo/disable",
      "https://host.example/v1/projects/project%2Fone/connect/setup-readiness",
    ]);
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body))).toEqual(definition);
    expect(JSON.parse(String(fetchImpl.mock.calls[3][1]?.body))).toEqual({ providerId: "notes", authenticationId: "public", oauthClientMode: "customer" });
    for (const [, init] of fetchImpl.mock.calls) expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-platform-key");
  });

  it("preserves creation identity through static project endpoints and MCP OAuth on both hosts", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => ok({ id: "connection" }));
    const client = new PolpoConnectClient({ baseUrl: "https://host.example", fetch: fetchImpl });
    const context = { audience: "end_user" as const, subject: { type: "external_user" as const, namespace: "app", id: "viewer" }, binding: { scopeEpoch: "one" } };
    await client.createProjectApiKeyConnection("project/one", { providerId: "custom", apiKey: "private", ...context });
    await client.createProjectPublicConnection("project/one", { providerId: "public", ...context });
    await client.createProjectMcpConnection("project/one", { providerId: "notes", authenticationId: "public", url: "https://mcp.example", ...context });
    await client.startProjectMcpOAuth("project/one", { url: "https://mcp.example", mode: "dynamic", ...context });
    await client.startMcpOAuth({ url: "https://mcp.example", mode: "dynamic", redirectUri: "https://host.example/callback", ...context });
    expect(fetchImpl.mock.calls.map(call => call[0])).toEqual([
      "https://host.example/v1/projects/project%2Fone/connect/connections/api-key",
      "https://host.example/v1/projects/project%2Fone/connect/connections/public",
      "https://host.example/v1/projects/project%2Fone/connect/connections/mcp",
      "https://host.example/v1/projects/project%2Fone/connect/mcp/oauth/start",
      "https://host.example/v1/connect/mcp/oauth/start",
    ]);
    for (const [, init] of fetchImpl.mock.calls) expect(JSON.parse(String(init?.body))).toMatchObject(context);
    await client.inspectMcpOAuth({ url: "https://mcp.example" });
    expect(fetchImpl.mock.calls.at(-1)?.[0]).toBe("https://host.example/v1/connect/mcp/inspect");
  });
  it("lists and revokes an external user's exact Connection without losing namespace or path boundaries", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => ok([]));
    const client = new PolpoConnectClient({ baseUrl: "https://api.polpo.test", fetch: fetchImpl });
    const owner = { namespace: "customer/app & team", id: "user/one" };
    await client.listProjectEndUserConnections("project/one", owner);
    await client.revokeProjectEndUserConnection("project/one", owner, "connection/two");
    expect(fetchImpl.mock.calls.map(call => [call[0], call[1]?.method])).toEqual([
      ["https://api.polpo.test/v1/projects/project%2Fone/connect/end-users/user%2Fone/connections?namespace=customer%2Fapp+%26+team", "GET"],
      ["https://api.polpo.test/v1/projects/project%2Fone/connect/end-users/user%2Fone/connections/connection%2Ftwo/revoke?namespace=customer%2Fapp+%26+team", "POST"],
    ]);
  });

  it("preserves OAuth authentication-method selection for project and organization app administration", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => ok({ id: "client", authenticationId: "business/oauth" }));
    const client = new PolpoConnectClient({ baseUrl: "https://api.polpo.test", fetch: fetchImpl });
    await client.configureProjectOAuthClient("project/one", "custom", { authenticationId: "business", clientId: "own-client", clientSecret: "own-secret" });
    await client.revokeProjectOAuthClient("project/one", "custom", "business/oauth");
    await client.revokeOrganizationOAuthClient("org/one", "custom", "business/oauth");
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toMatchObject({ authenticationId: "business" });
    expect(fetchImpl.mock.calls.slice(1).map(call => call[0])).toEqual([
      "https://api.polpo.test/v1/projects/project%2Fone/connect/oauth-clients/custom?authenticationId=business%2Foauth",
      "https://api.polpo.test/v1/orgs/org%2Fone/connect/oauth-clients/custom?authenticationId=business%2Foauth",
    ]);
  });
  it("manages project setup destinations independently from OAuth app credentials", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => ok({ returnOrigins: ["https://app.example"] }));
    const client = new PolpoConnectClient({ baseUrl: "https://api.polpo.test", fetch: fetchImpl });
    await expect(client.getProjectSetupConfiguration("project/one")).resolves.toEqual({ returnOrigins: ["https://app.example"] });
    await client.configureProjectSetup("project/one", { returnOrigins: ["https://app.example"] });
    expect(fetchImpl.mock.calls.map(call => [call[0], call[1]?.method])).toEqual([
      ["https://api.polpo.test/v1/projects/project%2Fone/connect/setup-configuration", "GET"],
      ["https://api.polpo.test/v1/projects/project%2Fone/connect/setup-configuration", "PUT"],
    ]);
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body))).toEqual({ returnOrigins: ["https://app.example"] });
  });
  it("passes the selected OAuth method and ownership into setup readiness", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => ok({ check: "configuration", outcome: "passed", code: "consent_required" }));
    const client = new PolpoConnectClient({ baseUrl: "https://host.example/api", fetch: fetchImpl });
    const input = { providerId: "contacts", authenticationId: "oauth", oauthClientMode: "customer" as const, redirectUri: "https://host.example/callback" };
    expect(await client.getSetupReadiness(input)).toMatchObject({ check: "configuration", code: "consent_required" });
    expect(fetchImpl.mock.calls[0][0]).toBe("https://host.example/api/v1/connect/setup-readiness");
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual(input);
  });

  it("returns the actual verification outcome from the OSS or project endpoint", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => ok({ outcome: "unsupported", code: "probe_not_configured" }));
    const client = new PolpoConnectClient({ baseUrl: "https://api.polpo.test", fetch: fetchImpl });
    await expect(client.verifyConnection("connection/one")).resolves.toMatchObject({ outcome: "unsupported" });
    await expect(client.verifyProjectConnection("project/one", "connection/one")).resolves.toMatchObject({ outcome: "unsupported" });
    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
      "https://api.polpo.test/v1/connect/connections/connection%2Fone/verify",
      "https://api.polpo.test/v1/projects/project%2Fone/connect/connections/connection%2Fone/verify",
    ]);
  });

  it("starts project setup through the Cloud public route without changing the OSS route", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => ok({ authorizationUrl: "https://accounts.example.com/authorize" }));
    const client = new PolpoConnectClient({ baseUrl: "https://api.polpo.test", fetch: fetchImpl as typeof fetch });
    await client.startProjectOAuthSetup("setup/token");
    await client.startOAuthSetup("setup/token");
    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
      "https://api.polpo.test/v1/connect/setup/setup%2Ftoken/oauth/start",
      "https://api.polpo.test/v1/connect/setup-sessions/setup%2Ftoken/start",
    ]);
  });

  it("exposes public API Connections and normalized catalog without credential parameters", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => ok({ id: "public-connection" }));
    const client = new PolpoConnectClient({ baseUrl: "https://api.polpo.test", fetch: fetchImpl as typeof fetch });
    await client.createPublicConnection({ providerId: "weather", authenticationId: "public" });
    await client.listCatalog();
    expect(fetchImpl.mock.calls[0][0]).toBe("https://api.polpo.test/v1/connect/connections/public");
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({ providerId: "weather", authenticationId: "public" });
    expect(fetchImpl.mock.calls[1][0]).toBe("https://api.polpo.test/v1/connect/catalog");
  });

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
    const fetchImpl = vi.fn<typeof fetch>(async () => responses.shift()!);
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

  it("forwards an MCP configuration selector on both OSS and managed setup routes", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => ok({ id: "setup" }));
    const client = new PolpoConnectClient({ baseUrl: "https://api.polpo.test", fetch: fetchImpl as typeof fetch });
    const input = { providerId: "mcp_url", configurationId: "mcp-config", projectId: "project", audience: "end_user" as const,
      subject: { type: "external_user" as const, namespace: "app", id: "gioia" }, returnUrl: "https://app.example/connected",
      oauthClientMode: "customer" as const };
    await client.createSetupSession(input);
    await client.createProjectSetupSession("project", input);
    expect(fetchImpl.mock.calls.map(call => call[0])).toEqual([
      "https://api.polpo.test/v1/connect/setup-sessions", "https://api.polpo.test/v1/projects/project/connect/setup-sessions",
    ]);
    for (const call of fetchImpl.mock.calls) expect(JSON.parse(String(call[1]?.body))).toMatchObject(input);
  });

  it("keeps compatibility with endpoints that return raw JSON", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify([{ id: "github" }]), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const client = new PolpoConnectClient({ baseUrl: "https://api.polpo.test", fetch: fetchImpl as typeof fetch });
    await expect(client.listProviders()).resolves.toEqual([{ id: "github" }]);
  });

  it("surfaces the deliberate MCP reconnect denial while verification uses discovery", async () => {
    const responses = [
      new Response(JSON.stringify({ ok: false, code: "setup_invalid", error: "Create a new MCP Connection and assign it explicitly" }), { status: 409 }),
      ok({ tools: [{ name: "search" }, { name: "read" }] }),
    ];
    const fetchImpl = vi.fn<typeof fetch>(async () => responses.shift()!);
    const client = new PolpoConnectClient({
      baseUrl: "https://api.polpo.test",
      fetch: fetchImpl as typeof fetch,
    });

    await expect(client.reconnectProjectMcpConnection("project/one", "connection/one"))
      .rejects.toThrow("Create a new MCP Connection and assign it explicitly");
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
    const fetchImpl = vi.fn<typeof fetch>(async () => responses.shift()!);
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
    const fetchImpl = vi.fn<typeof fetch>(async () => responses.shift()!);
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

    const fetchImpl = vi.fn<typeof fetch>(async () => ok({
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
    const fetchImpl = vi.fn<typeof fetch>(async () => responses.shift()!);
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
