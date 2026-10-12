import { describe, expect, it, vi } from "vitest";
import type { ConnectorDefinition, ResolvedOAuthClient } from "@polpo-ai/connect";
import { createConnectService, MemoryConnectStore, MemoryConnectionSecretStore } from "../index.js";

const definition: ConnectorDefinition = {
  version: 2, id: "contacts", name: "Contacts", source: "custom", protocol: "http_api",
  defaultAuthenticationId: "header_key",
  scopes: [{ id: "read" }],
  authentication: [
    { id: "header_key", type: "api_key", injection: { mode: "header", name: "X-API-Key" }, defaultScopes: ["read"] },
    { id: "query_key", type: "api_key", injection: { mode: "query", name: "api_key" }, defaultScopes: ["read"] },
    { id: "oauth", type: "oauth2", authorizationUrl: "https://auth.example.com/authorize", tokenUrl: "https://auth.example.com/token", defaultScopes: ["read"] },
    { id: "public", type: "none", defaultScopes: ["read"] },
  ],
  http: { origins: ["https://api.example.com"], allowedMethods: ["GET"], allowedPathPatterns: ["/contacts"] },
};

function harness() {
  const store = new MemoryConnectStore();
  const secrets = new MemoryConnectionSecretStore();
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ contacts: [] }));
  const client: ResolvedOAuthClient = {
    id: "customer_client", providerId: "contacts", clientId: "app_emiliano", clientSecret: "test-client-secret",
    owner: { type: "project", id: "project-1" }, redirectUris: ["https://host.example.com/callback"],
  };
  const options = {
    providers: [definition], store, secrets, setupSessions: store, links: store, fetch,
    resolveHostname: async () => ["8.8.8.8"],
    allowedReturnUrlOrigins: ["https://app.example.com"],
    oauthClients: {
      resolve: vi.fn(async () => client),
      resolveById: vi.fn(async () => client),
    },
  };
  return { service: createConnectService(options), options, store, secrets, fetch };
}

describe("Connector authentication selection at runtime", () => {
  it("cancels before provider access and bounds a stalled response body", async () => {
    const { options, fetch } = harness();
    const service = createConnectService({ ...options, providers: [{ ...definition,
      http: { ...definition.http, timeoutMs: 10 },
    }] });
    const connection = await service.createApiKeyConnection({ providerId: "contacts", apiKey: "test-key" });
    const request = { connectionId: connection.id, request: { method: "GET", path: "/contacts" } };
    await expect(service.request({ ...request, signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "http_error" });
    expect(fetch).not.toHaveBeenCalled();
    const cancel = vi.fn();
    fetch.mockResolvedValueOnce(new Response(new ReadableStream({ cancel })));
    await expect(service.request(request)).rejects.toMatchObject({ code: "http_error" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("pins the registered OAuth application across setup and callback", async () => {
    for (const replacementAt of ["setup", "callback"] as const) {
      const { service, options, fetch } = harness();
      const setup = await service.createSetupSession({
        providerId: "contacts", authenticationId: "oauth", projectId: "project-1", audience: "shared",
        subject: { type: "project", id: "project-1" }, returnUrl: "https://app.example.com/connected",
      });
      const client = await options.oauthClients.resolve();
      if (replacementAt === "setup") {
        client.clientId = "another-registered-app";
        await expect(service.startOAuthSetup({ setupSessionId: setup.id })).rejects.toMatchObject({ code: "setup_invalid" });
      } else {
        const start = await service.startOAuthSetup({ setupSessionId: setup.id });
        client.clientId = "another-registered-app";
        await expect(service.completeOAuth({ state: start.state, code: "test-code" })).rejects.toMatchObject({ code: "setup_invalid" });
      }
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it("permits secret rotation for the same registered app but requires reconnect for a different app", async () => {
    const { service, options, fetch } = harness();
    const start = await service.startOAuth({ providerId: "contacts", authenticationId: "oauth", redirectUri: "https://host.example.com/callback" });
    const client = await options.oauthClients.resolve();
    client.clientSecret = "rotated-client-secret";
    fetch.mockResolvedValueOnce(Response.json({ access_token: "test-token", scope: "read" }));
    const connection = await service.completeOAuth({ state: start.state, code: "test-code" });
    expect(String(fetch.mock.calls[0][1]?.body)).toContain("client_secret=rotated-client-secret");
    client.clientId = "replacement-app";
    await expect(service.request({ connectionId: connection.id, scopes: ["read"], request: { method: "GET", path: "/contacts" } }))
      .rejects.toMatchObject({ code: "setup_invalid" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("denies scopes removed by refresh before making the provider operation", async () => {
    const { service, fetch } = harness();
    const start = await service.startOAuth({ providerId: "contacts", authenticationId: "oauth", redirectUri: "https://host.example.com/callback" });
    fetch.mockResolvedValueOnce(Response.json({ access_token: "first", refresh_token: "refresh", scope: "read", expires_in: 0 }));
    const connection = await service.completeOAuth({ state: start.state, code: "test-code" });
    fetch.mockResolvedValueOnce(Response.json({ access_token: "second", scope: "", expires_in: 3600 }));
    await expect(service.request({ connectionId: connection.id, scopes: ["read"], request: { method: "GET", path: "/contacts" } }))
      .rejects.toMatchObject({ code: "invalid_scope" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("enforces declared action scopes even when the caller omits them", async () => {
    const { options, fetch } = harness();
    const service = createConnectService({ ...options, providers: [{ ...definition, actions: [{ id: "list_contacts", scopes: ["read"] }] }] });
    const connection = await service.createApiKeyConnection({ providerId: "contacts", apiKey: "test-key", scopes: [] });
    await expect(service.request({ connectionId: connection.id, actionId: "list_contacts", request: { method: "GET", path: "/contacts" } }))
      .rejects.toMatchObject({ code: "invalid_scope" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("persists the selected key injection and uses it after the default changes", async () => {
    const { service, options, fetch } = harness();
    const connection = await service.createApiKeyConnection({
      providerId: "contacts", authenticationId: "query_key", apiKey: "test-account-key",
    });
    expect(connection.authenticationId).toBe("query_key");
    const restarted = createConnectService({ ...options, providers: [{ ...definition, defaultAuthenticationId: "public" }] });
    await restarted.request({ connectionId: connection.id, scopes: ["read"], request: { method: "GET", path: "/contacts" } });
    const [url, request] = fetch.mock.calls[0];
    expect(String(url)).toBe("https://api.example.com/contacts?api_key=test-account-key");
    expect(new Headers(request?.headers).has("x-api-key")).toBe(false);
  });

  it("starts and completes OAuth on a Connector whose default authentication is an API key", async () => {
    const { service, fetch } = harness();
    const setup = await service.createSetupSession({
      providerId: "contacts", authenticationId: "oauth", projectId: "project-1", audience: "end_user",
      subject: { type: "external_user", namespace: "emiliano-app", id: "gioia" },
      returnUrl: "https://app.example.com/connected", oauthClientMode: "customer",
    });
    const start = await service.startOAuthSetup({ setupSessionId: setup.id });
    expect(new URL(start.authorizationUrl).searchParams.get("client_id")).toBe("app_emiliano");
    fetch.mockResolvedValueOnce(Response.json({ access_token: "test-oauth-token", token_type: "Bearer", scope: "read" }));
    const connection = await service.completeOAuth({ state: start.state, code: "test-code" });
    expect(connection).toMatchObject({ authenticationId: "oauth", oauthClientId: "customer_client", audience: "end_user" });
    await service.request({ connectionId: connection.id, scopes: ["read"], request: { method: "GET", path: "/contacts" } });
    expect(new Headers(fetch.mock.calls[1][1]?.headers).get("authorization")).toBe("Bearer test-oauth-token");
  });

  it("can execute a public HTTP integration without storing or injecting a credential", async () => {
    const { service, fetch, secrets } = harness();
    const secretWrite = vi.spyOn(secrets, "setSecret");
    const connection = await service.createPublicConnection({ providerId: "contacts", authenticationId: "public" });
    expect(connection).toMatchObject({ authType: "none", authenticationId: "public" });
    expect(connection.secretRef).toBeUndefined();
    await service.request({ connectionId: connection.id, scopes: ["read"], request: { method: "GET", path: "/contacts" } });
    expect(secretWrite).not.toHaveBeenCalled();
    expect(new Headers(fetch.mock.calls[0][1]?.headers).has("authorization")).toBe(false);
    await expect(service.getToken({ connectionId: connection.id })).rejects.toMatchObject({ code: "token_not_available" });
  });

  it("denies unsupported or changed authentication rather than substituting another method", async () => {
    const { service, options, fetch } = harness();
    await expect(service.createApiKeyConnection({ providerId: "contacts", authenticationId: "oauth", apiKey: "test" }))
      .rejects.toMatchObject({ code: "unsupported_auth" });
    const connection = await service.createApiKeyConnection({ providerId: "contacts", authenticationId: "query_key", apiKey: "test" });
    const restarted = createConnectService({ ...options, providers: [{
      ...definition, authentication: definition.authentication.filter((method) => method.id !== "query_key"),
    }] });
    await expect(restarted.request({ connectionId: connection.id, request: { method: "GET", path: "/contacts" } }))
      .rejects.toMatchObject({ code: "unsupported_auth" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a credential kind mismatch without sending the stored secret", async () => {
    const { service, store, fetch } = harness();
    const connection = await service.createApiKeyConnection({ providerId: "contacts", apiKey: "test-account-key" });
    await store.updateConnection(connection.id, { authenticationId: "public" });
    await expect(service.request({ connectionId: connection.id, request: { method: "GET", path: "/contacts" } }))
      .rejects.toMatchObject({ code: "unsupported_auth" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps MCP method selection and header configuration authoritative", async () => {
    const { options } = harness();
    const service = createConnectService({ ...options, providers: [{
      version: 2, id: "company_mcp", name: "Company MCP", source: "custom", protocol: "mcp",
      defaultAuthenticationId: "header", authentication: [
        { id: "header", type: "api_key", injection: { mode: "header", name: "X-Company-Key" } },
        { id: "public", type: "none" },
        { id: "oauth", type: "oauth2", discovery: true },
      ],
    }] });
    const connection = await service.createMcpConnection({
      providerId: "company_mcp", authenticationId: "header", url: "https://mcp.example.com/mcp", apiKey: "test-key",
      headerName: "Other-Header",
      metadata: { headerName: "Host" },
    });
    expect(connection).toMatchObject({ authenticationId: "header", metadata: { auth: "header", headerName: "X-Company-Key" } });
    expect(await service.resolveCredential({ connectionId: connection.id })).toMatchObject({
      kind: "mcp", accessToken: "test-key", metadata: { headerName: "X-Company-Key" },
    });
    await expect(service.createMcpConnection({
      providerId: "company_mcp", authenticationId: "oauth", auth: "none", url: "https://mcp.example.com/mcp",
    })).rejects.toMatchObject({ code: "unsupported_auth" });
    await expect(service.createMcpConnection({
      providerId: "company_mcp", authenticationId: "header", auth: "none", url: "https://mcp.example.com/mcp",
    })).rejects.toMatchObject({ code: "unsupported_auth" });
  });
});
