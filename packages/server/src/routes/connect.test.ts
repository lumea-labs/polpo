import { describe, expect, it, vi } from "vitest";
import type { ConnectorProviderDefinition } from "@polpo-ai/connect";
import { MemoryConnectStore, MemoryConnectionSecretStore, MemoryConnectorDefinitionStore, createConnectService } from "@polpo-ai/connect-server";
import { connectRoutes } from "./connect.js";

const apiKeyProvider: ConnectorProviderDefinition = {
  id: "custom_api",
  name: "Custom API",
  auth: { type: "api_key", defaultScopes: ["use"] },
  scopes: [{ id: "use" }],
  http: {
    origins: ["https://api.example"],
    allowedMethods: ["GET", "POST"],
    allowedPathPatterns: ["/v1/items", "/v1/items/*"],
    auth: { mode: "header", name: "x-api-key" },
  },
};

const oauthProvider: ConnectorProviderDefinition = {
  id: "test_oauth",
  name: "Test OAuth",
  auth: {
    type: "oauth2",
    authorizationUrl: "https://auth.example/authorize",
    tokenUrl: "https://auth.example/token",
    clientId: "client_id",
    clientSecret: "client_secret",
    defaultScopes: ["read"],
  },
  scopes: [{ id: "read" }, { id: "write" }],
};

describe("connectRoutes", () => {
  it("creates an embedded MCP setup with the selected reusable client and trusted owner", async () => {
    const store = new MemoryConnectStore();
    const client = { id: "mcp-config", providerId: "mcp_url", owner: { type: "instance" as const, id: "host" },
      resourceUrl: "https://mcp.example/mcp", transport: "http" as const, redirectUri: "https://host.example/callback",
      registration: { mode: "pre_registered" as const, client: { client_id: "client", client_secret: "private-config-secret" } } };
    const resolver = { resolve: vi.fn(async () => client), resolveById: vi.fn(async () => client) };
    const service = createConnectService({ providers: [{ id: "mcp_url", name: "MCP", auth: { type: "mcp", auth: "oauth2" }, scopes: [] }],
      store, setupSessions: store, links: store, secrets: new MemoryConnectionSecretStore(),
      mcpOAuthClients: resolver, allowedReturnUrlOrigins: ["https://app.example"] });
    const app = connectRoutes(() => ({ connectService: service }));
    const subject = { type: "external_user", namespace: "app", id: "gioia" };
    const response = await app.request("/setup-sessions", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId: "mcp_url", projectId: "project", audience: "end_user", subject,
        returnUrl: "https://app.example/connected", oauthClientMode: "instance", configurationId: "mcp-config" }) });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({ data: { flowKind: "mcp", oauthClientId: "mcp-config", subject } });
    expect(resolver.resolve).toHaveBeenCalledWith(expect.objectContaining({ configurationId: "mcp-config", projectId: "project", mode: "instance" }));
    expect(JSON.stringify(body)).not.toContain("private-config-secret");
  });

  it("dispatches the authenticated callback by its stored flow, including MCP", async () => {
    const { service, store } = createHarness();
    await store.saveOAuthState({ state: "mcp-state", providerId: "mcp_url", flowKind: "mcp", requestedScopes: [],
      redirectUri: "https://host.example/callback", createdAt: new Date().toISOString(), expiresAt: "2099-01-01T00:00:00.000Z" });
    const completeMcp = vi.spyOn(service, "completeMcpOAuth").mockResolvedValue({ id: "mcp-connection", authType: "mcp" } as never);
    const completeApi = vi.spyOn(service, "completeOAuth");
    const app = connectRoutes(() => ({ connectService: service }));
    const response = await app.request("/oauth/callback", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "mcp-state", code: "code" }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { id: "mcp-connection", authType: "mcp" } });
    expect(completeMcp).toHaveBeenCalledWith({ state: "mcp-state", code: "code" });
    expect(completeApi).not.toHaveBeenCalled();
  });

  it("returns a structured denial for unsafe generic MCP auth headers instead of HTTP 500", async () => {
    const service = createConnectService({ providers: [{ id: "mcp_url", name: "MCP", auth: { type: "mcp", auth: "bearer" }, scopes: [] }],
      store: new MemoryConnectStore(), secrets: new MemoryConnectionSecretStore() });
    const app = connectRoutes(() => ({ connectService: service }));
    const response = await app.request("/connections/mcp", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://mcp.example", auth: "header", headerName: "Cookie", apiKey: "private" }) });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ ok: false, code: "connection_operation_denied" });
  });
  it("preserves trusted audience and binding through the API-key route", async () => {
    const app = connectRoutes(() => ({ connectService: createHarness().service }));
    const owner = { type: "external_user", namespace: "app", id: "viewer" };
    const response = await app.request("/connections/api-key", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId: "custom_api", apiKey: "private", audience: "end_user", subject: owner, binding: { scopeEpoch: "one" } }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { audience: "end_user", owner, binding: { principal: owner, scopeEpoch: "one" } } });
  });

  it("creates a custom MCP through the SDK's advertised OSS route with its selected authentication and identity", async () => {
    const service = createConnectService({ providers: [{ version: 2, id: "notes", name: "Notes", source: "custom", protocol: "mcp",
      defaultAuthenticationId: "public", authentication: [{ id: "public", type: "none" }] }],
      store: new MemoryConnectStore(), secrets: new MemoryConnectionSecretStore() });
    const app = connectRoutes(() => ({ connectService: service }));
    const response = await app.request("/connections/mcp", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId: "notes", authenticationId: "public", url: "https://mcp.example/mcp", audience: "personal", subject: { type: "user", id: "builder" } }) });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ data: { providerId: "notes", authenticationId: "public", audience: "personal",
      binding: { principal: { type: "user", id: "builder" } }, metadata: { auth: "none" } } });
  });

  it("exposes OSS MCP inspect and OAuth start, keeping the callback and trusted context explicit", async () => {
    const { service } = createHarness();
    const inspect = vi.spyOn(service, "inspectMcpOAuth").mockResolvedValue({} as never);
    const start = vi.spyOn(service, "startMcpOAuth").mockResolvedValue({ authorizationUrl: "https://provider.example", state: "state", expiresAt: "2099" });
    const app = connectRoutes(() => ({ connectService: service }));
    const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await post("/mcp/inspect", { url: "https://mcp.example/mcp", transport: "sse" })).status).toBe(200);
    const input = { providerId: "notes", authenticationId: "oauth", url: "https://mcp.example/mcp", mode: "dynamic",
      redirectUri: "https://host.example/v1/connect/oauth/callback", audience: "personal", subject: { type: "user", id: "builder" } };
    expect((await post("/mcp/oauth/start", input)).status).toBe(200);
    expect(inspect).toHaveBeenCalledWith({ url: "https://mcp.example/mcp", transport: "sse" });
    expect(start).toHaveBeenCalledWith(input);
    expect((await post("/mcp/oauth/start", { ...input, redirectUri: undefined })).status).toBe(400);
    expect(start).toHaveBeenCalledOnce();
  });
  it("exposes local setup readiness separately from live verification", async () => {
    const app = connectRoutes(() => ({ connectService: createHarness().service }));
    const response = await app.request("/setup-readiness", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId: "custom_api" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { check: "configuration", outcome: "passed", code: "credentials_required" } });
  });

  it("registers a custom API through HTTP and blocks it after disabling the definition", async () => {
    const service = createConnectService({ providers: [], store: new MemoryConnectStore(), secrets: new MemoryConnectionSecretStore(), definitions: new MemoryConnectorDefinitionStore() });
    const app = connectRoutes(() => ({ connectService: service }));
    const response = await app.request("/connectors", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 2, id: "weather", name: "Weather", source: "catalog", protocol: "http_api",
        defaultAuthenticationId: "public", authentication: [{ id: "public", type: "none" }], http: { origins: ["https://api.example.com"] } }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ data: { definition: { source: "custom" } } });
    expect(await (await app.request("/catalog")).json()).toMatchObject({ data: [{ id: "weather" }] });
    expect((await app.request("/connectors/weather/disable", { method: "POST" })).status).toBe(200);
    expect(await (await app.request("/catalog")).json()).toMatchObject({ data: [] });
  });

  it("exposes an honest verification result without serializing credentials", async () => {
    const { service } = createHarness();
    const connection = await service.createApiKeyConnection({ providerId: "custom_api", apiKey: "private-test-key" });
    const app = connectRoutes(() => ({ connectService: service }));
    const response = await app.request(`/connections/${connection.id}/verify`, { method: "POST" });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, data: { outcome: "unsupported", code: "probe_not_configured" } });
    expect(JSON.stringify(body)).not.toContain("private-test-key");
    expect((await app.request("/connections/missing/verify", { method: "POST" })).status).toBe(404);
  });

  it("does not expose OAuth app credentials in the provider catalog", async () => {
    const app = connectRoutes(() => ({ connectService: createHarness().service }));
    const response = await app.request("/providers");
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain("client_secret");
    expect(body).not.toContain('"clientSecret"');
  });

  it("exposes the normalized catalog and public HTTP setup without discarding authentication selection", async () => {
    const service = createConnectService({
      providers: [{
        version: 2, id: "public_api", name: "Public API", source: "custom", protocol: "http_api",
        defaultAuthenticationId: "public", authentication: [{ id: "public", type: "none" }],
        http: { origins: ["https://api.example.com"] },
      }],
      store: new MemoryConnectStore(), secrets: new MemoryConnectionSecretStore(),
    });
    const app = connectRoutes(() => ({ connectService: service }));
    const catalog = await app.request("/catalog");
    expect(catalog.status).toBe(200);
    expect(await catalog.json()).toMatchObject({ data: [{ protocol: "http_api", authentication: [{ type: "none" }] }] });
    const created = await app.request("/connections/public", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId: "public_api", authenticationId: "public" }),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ data: { authType: "none", authenticationId: "public" } });
    const invalid = await app.request("/connections/public", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId: "public_api", authenticationId: "unknown" }),
    });
    expect(invalid.status).toBe(400);
  });

  it("returns 501 when connect service is not wired", async () => {
    const app = connectRoutes(() => ({}));
    const res = await app.request("/providers");
    const body = await res.json();

    expect(res.status).toBe(501);
    expect(body).toMatchObject({ ok: false, code: "CONNECT_SERVICE_UNAVAILABLE" });
  });

  it("creates API-key connections without returning secret values and can issue runtime tokens", async () => {
    const harness = createHarness();
    const app = connectRoutes(() => ({ connectService: harness.service }));
    const createRes = await app.request("/connections/api-key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        providerId: "custom_api",
        apiKey: "sk_test_123",
        scopes: ["use"],
        subject: { type: "agent", id: "support" },
      }),
    });
    const created = await createRes.json();

    expect(createRes.status).toBe(200);
    expect(created.data).toMatchObject({ providerId: "custom_api", status: "active" });
    expect(JSON.stringify(created)).not.toContain("sk_test_123");

    const tokenRes = await app.request(`/connections/${created.data.id}/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scopes: ["use"], subject: { type: "agent", id: "support" } }),
    });
    const token = await tokenRes.json();

    expect(tokenRes.status).toBe(200);
    expect(token.data).toMatchObject({
      accessToken: "sk_test_123",
      tokenType: "ApiKey",
      providerId: "custom_api",
    });
  });

  it("maps connect errors to structured HTTP errors", async () => {
    const app = connectRoutes(() => ({ connectService: createHarness().service }));
    const res = await app.request("/connections/api-key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId: "custom_api", apiKey: "sk", scopes: ["admin"] }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toMatchObject({ ok: false, code: "invalid_scope" });
  });

  it("supports OAuth start and callback through the HTTP contract", async () => {
    const harness = createHarness({
      fetchImpl: queueFetch([
        jsonResponse(200, {
          access_token: "oauth_access",
          refresh_token: "oauth_refresh",
          expires_in: 3600,
          scope: "read write",
        }),
      ]),
    });
    const app = connectRoutes(() => ({ connectService: harness.service }));
    const startRes = await app.request("/oauth/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        providerId: "test_oauth",
        scopes: ["read", "write"],
        redirectUri: "https://app.example/callback",
      }),
    });
    const started = await startRes.json();

    expect(startRes.status).toBe(200);
    expect(started.data.authorizationUrl).toContain("https://auth.example/authorize");
    expect(started.data.state).toBeTruthy();

    const callbackRes = await app.request("/oauth/callback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: started.data.state, code: "code_123" }),
    });
    const callback = await callbackRes.json();

    expect(callbackRes.status).toBe(200);
    expect(callback.data).toMatchObject({
      providerId: "test_oauth",
      status: "active",
      grantedScopes: ["read", "write"],
    });
    expect(harness.fetchImpl.calls[0]!.bodyString).toContain("grant_type=authorization_code");
  });

  it("filters listed connections by provider, status, and owner", async () => {
    const harness = createHarness();
    const app = connectRoutes(() => ({ connectService: harness.service }));
    await harness.service.createApiKeyConnection({
      providerId: "custom_api",
      apiKey: "sk_1",
      scopes: ["use"],
      subject: { type: "agent", id: "support" },
    });
    await harness.service.createApiKeyConnection({
      providerId: "custom_api",
      apiKey: "sk_2",
      scopes: ["use"],
      subject: { type: "agent", id: "sales" },
    });

    const res = await app.request("/connections?providerId=custom_api&status=active&ownerType=agent&ownerId=support");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].owner).toEqual({ type: "agent", id: "support" });
  });

  it("creates and consumes a trusted OAuth setup session exactly once", async () => {
    const harness = createHarness({
      fetchImpl: queueFetch([
        jsonResponse(200, {
          access_token: "oauth_access",
          refresh_token: "oauth_refresh",
          expires_in: 3600,
          scope: "read",
        }),
      ]),
      withOAuthClient: true,
    });
    const app = connectRoutes(() => ({ connectService: harness.service }));
    const setupRes = await app.request("/setup-sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        providerId: "test_oauth",
        projectId: "project-1",
        audience: "end_user",
        subject: { type: "external_user", namespace: "app", id: "user-1" },
        binding: {
          principal: { type: "external_user", namespace: "app", id: "user-1" },
          tenant: { namespace: "app", id: "tenant-1" },
        },
        scopes: ["read"],
        returnUrl: "https://app.example/settings/connections",
        oauthClientMode: "managed",
      }),
    });
    const setup = await setupRes.json();

    expect(setupRes.status).toBe(201);
    expect(setup.data).toMatchObject({
      projectId: "project-1",
      audience: "end_user",
      subject: { type: "external_user", namespace: "app", id: "user-1" },
      binding: { principal: { type: "external_user", namespace: "app", id: "user-1" } },
    });
    expect(setup.data).not.toHaveProperty("oauthClientSecret");

    const observed = await app.request(`/setup/${setup.data.id}/status`);
    expect(observed.status).toBe(200);
    const publicStatus = await observed.json();
    expect(publicStatus.data).toMatchObject({ status: "pending", scopes: ["read"] });
    expect(publicStatus.data).not.toHaveProperty("subject");
    expect(publicStatus.data).not.toHaveProperty("binding");

    const startRes = await app.request(`/setup-sessions/${setup.data.id}/start`, { method: "POST" });
    const started = await startRes.json();
    expect(startRes.status).toBe(200);
    expect(started.data.authorizationUrl).toContain("client_id=managed-client");

    const replayRes = await app.request(`/setup-sessions/${setup.data.id}/start`, { method: "POST" });
    expect(replayRes.status).toBe(409);
    await expect(replayRes.json()).resolves.toMatchObject({ ok: false, code: "setup_consumed" });

    const cancelStarted = await app.request(`/setup/${setup.data.id}/cancel`, { method: "POST" });
    expect(cancelStarted.status).toBe(410);
    const callback = await app.request("/oauth/callback", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: started.data.state, code: "code" }) });
    expect(callback.status).toBe(200);
    const completed = await (await app.request(`/setup/${setup.data.id}/status`)).json();
    expect(completed.data).toMatchObject({ status: "completed", resultingConnectionId: (await callback.json()).data.id });
  });

  it("observes missing setup and cancels a pending setup through SDK-compatible routes", async () => {
    const harness = createHarness({ withOAuthClient: true });
    const app = connectRoutes(() => ({ connectService: harness.service }));
    expect((await app.request("/setup/missing/status")).status).toBe(404);
    expect((await app.request("/setup/missing/cancel", { method: "POST" })).status).toBe(404);
    const setup = await harness.service.createSetupSession({ providerId: "test_oauth", projectId: "project-1", audience: "end_user",
      subject: { type: "external_user", namespace: "app", id: "user-1" }, scopes: ["read"],
      returnUrl: "https://app.example/settings", oauthClientMode: "managed" });
    const cancelled = await app.request(`/setup/${setup.id}/cancel`, { method: "POST" });
    expect(cancelled.status).toBe(200);
    expect((await cancelled.json()).data.status).toBe("cancelled");
    expect((await app.request(`/setup-sessions/${setup.id}/start`, { method: "POST" })).status).toBe(409);
  });

  it("executes a policy-bound gateway request without exposing credentials", async () => {
    const harness = createHarness({
      fetchImpl: queueFetch([
        jsonResponse(200, { id: "item-1" }, { "x-request-id": "provider-request-1" }),
      ]),
    });
    const connection = await harness.service.createApiKeyConnection({
      providerId: "custom_api",
      apiKey: "sk_gateway_secret",
      scopes: ["use"],
    });
    const app = connectRoutes(() => ({ connectService: harness.service }));

    const res = await app.request(`/connections/${connection.id}/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scopes: ["use"],
        request: { method: "GET", path: "/v1/items" },
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({
      status: 200,
      headers: { "content-type": "application/json", "x-request-id": "provider-request-1" },
      body: { id: "item-1" },
      requestId: "provider-request-1",
    });
    expect(JSON.stringify(body)).not.toContain("sk_gateway_secret");
    expect(harness.fetchImpl.calls[0]!.init.headers).toEqual(expect.any(Headers));
    expect((harness.fetchImpl.calls[0]!.init.headers as Headers).get("x-api-key")).toBe("sk_gateway_secret");
  });
});

function createHarness(input: { fetchImpl?: MockFetch; withOAuthClient?: boolean } = {}) {
  const store = new MemoryConnectStore();
  const secrets = new MemoryConnectionSecretStore();
  const fetchImpl = input.fetchImpl ?? queueFetch([]);
  const service = createConnectService({
    providers: [apiKeyProvider, oauthProvider],
    store,
    secrets,
    fetch: fetchImpl,
    now: () => new Date(Date.UTC(2026, 0, 1, 10, 0, 0)),
    resolveHostname: async () => ["93.184.216.34"],
    ...(input.withOAuthClient ? {
      oauthClients: {
        async resolve() {
          return {
            id: "oauth-client-1",
            providerId: "test_oauth",
            clientId: "managed-client",
            clientSecret: "managed-secret",
            redirectUris: ["https://api.polpo.example/v1/connect/oauth/callback"],
            owner: { type: "instance" as const, id: "managed" },
          };
        },
        async resolveById() {
          return {
            id: "oauth-client-1",
            providerId: "test_oauth",
            clientId: "managed-client",
            clientSecret: "managed-secret",
            redirectUris: ["https://api.polpo.example/v1/connect/oauth/callback"],
            owner: { type: "instance" as const, id: "managed" },
          };
        },
      },
      setupSessions: store,
      links: store,
      allowedReturnUrlOrigins: ["https://app.example"],
    } : {}),
  });
  return { service, store, secrets, fetchImpl };
}

interface MockFetchCall {
  url: string;
  init: RequestInit;
  bodyString: string;
}

type MockFetch = ReturnType<typeof queueFetch>;

function queueFetch(responses: Response[]) {
  const calls: MockFetchCall[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init, bodyString: String(init.body ?? "") });
    const next = responses.shift();
    if (!next) throw new Error("Unexpected fetch call");
    return next;
  });
  return Object.assign(fetchImpl, { calls });
}

function jsonResponse(status: number, payload: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
