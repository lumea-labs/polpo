import { describe, expect, it, vi } from "vitest";
import { ConnectError, type ConnectorProviderDefinition, type ConnectionRecord } from "@polpo-ai/connect";
import { createConnectService, MemoryConnectStore, MemoryConnectionSecretStore,
  type CreateConnectServiceOptions } from "../index.js";

const callback = "https://host.example/callback";
const provider: ConnectorProviderDefinition = {
  id: "account", name: "Account", auth: { type: "oauth2", clientId: "test-client",
    authorizationUrl: "https://auth.example/authorize", tokenUrl: "https://auth.example/token", defaultScopes: ["read"] },
  scopes: [{ id: "read" }], http: { origins: ["https://api.example"], auth: { mode: "bearer" } },
};
const mcp: ConnectorProviderDefinition = { id: "mcp_url", name: "MCP", auth: { type: "mcp" }, allowCustomScopes: true };
function harness() {
  let denied = false;
  const authorizeOAuth = vi.fn(async (_input: unknown) => {
    if (denied) throw new ConnectError("policy_denied", "OAuth disabled by host");
  });
  const store = new MemoryConnectStore();
  const secrets = new MemoryConnectionSecretStore();
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({
    access_token: "private-access", refresh_token: "private-refresh", scope: "read", expires_in: 3600,
  }));
  const client = { id: "own-app", providerId: provider.id, clientId: "test-client", redirectUris: [callback],
    owner: { type: "project" as const, id: "project" } };
  const options: CreateConnectServiceOptions = { providers: [provider, mcp], store, secrets, links: store, setupSessions: store, fetch,
    oauthClients: { resolve: async () => client, resolveById: async () => client },
    allowedReturnUrlOrigins: ["https://app.example"], resolveHostname: async () => ["8.8.8.8"], authorizeOAuth };
  const service = createConnectService(options);
  const start = () => service.startOAuth({ providerId: provider.id, projectId: "project", orgId: "org", redirectUri: callback });
  const setup = () => service.createSetupSession({ providerId: provider.id, projectId: "project", orgId: "org",
    audience: "end_user", subject: { type: "external_user", namespace: "app", id: "person" },
    returnUrl: "https://app.example/connected", oauthClientMode: "customer" });
  return { service, store, secrets, fetch, start, setup, authorizeOAuth, client, deny: () => { denied = true; } };
}

describe("OAuth host authorization", () => {
  it.each(["api", "mcp"])("denies %s authorization before provider requests or stored state/secrets", async protocol => {
    const h = harness();
    h.deny();
    const save = vi.spyOn(h.store, "saveOAuthState");
    const secret = vi.spyOn(h.secrets, "setSecret");
    const work = protocol === "api" ? h.start() : h.service.startMcpOAuth({ url: "https://mcp.example/mcp",
      projectId: "project", orgId: "org", redirectUri: callback, mode: "dynamic" });
    await expect(work).rejects.toMatchObject({ code: "policy_denied" });
    expect(h.authorizeOAuth).toHaveBeenCalledWith(expect.objectContaining({ operation: "authorize", protocol,
      projectId: "project", orgId: "org" }));
    expect(h.fetch).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(secret).not.toHaveBeenCalled();
  });

  it("does not create or consume a setup when the host disables OAuth", async () => {
    const h = harness();
    const setup = await h.setup();
    h.deny();
    const save = vi.spyOn(h.store, "saveConnectionSetupSession");
    await expect(h.setup()).rejects.toMatchObject({ code: "policy_denied" });
    await expect(h.service.startOAuthSetup({ setupSessionId: setup.id })).rejects.toMatchObject({ code: "policy_denied" });
    expect(save).not.toHaveBeenCalled();
    expect((await h.store.getConnectionSetupSession(setup.id))?.consumedAt).toBeUndefined();
  });

  it("rechecks callback policy from persisted state and does not exchange the code when disabled", async () => {
    const h = harness();
    const start = await h.start();
    h.deny();
    await expect(h.service.completeOAuthCallback({ state: start.state, code: "private-code" }))
      .rejects.toMatchObject({ code: "policy_denied" });
    expect(h.authorizeOAuth).toHaveBeenLastCalledWith(expect.objectContaining({ operation: "callback", protocol: "api",
      projectId: "project", orgId: "org", providerId: provider.id }));
    expect(h.fetch).not.toHaveBeenCalled();
    expect(await h.store.listConnections()).toEqual([]);
    expect(JSON.stringify(h.authorizeOAuth.mock.calls)).not.toMatch(/private-code|private-access|private-refresh/);
  });

  it("cannot activate a Connection if the host disables OAuth while exchanging the code", async () => {
    const h = harness();
    const start = await h.start();
    h.fetch.mockImplementation(async () => { h.deny(); return Response.json({ access_token: "private-access", scope: "read" }); });
    const write = vi.spyOn(h.secrets, "setSecret");
    await expect(h.service.completeOAuth({ state: start.state, code: "code" })).rejects.toMatchObject({ code: "policy_denied" });
    expect(await h.store.listConnections()).toEqual([]);
    expect(write).not.toHaveBeenCalled();
  });

  it("does not send the newly exchanged token to UserInfo after host disablement", async () => {
    const h = harness();
    if (provider.auth.type !== "oauth2") throw new Error("OAuth fixture required");
    const service = createConnectService({ providers: [{ ...provider, auth: { ...provider.auth,
      identity: { method: "userinfo", issuer: "https://auth.example", url: "https://auth.example/userinfo", requiredScopes: ["read"] } } }],
      store: h.store, secrets: h.secrets, fetch: h.fetch, authorizeOAuth: h.authorizeOAuth,
      resolveHostname: async () => ["8.8.8.8"] });
    const start = await service.startOAuth({ providerId: provider.id, redirectUri: callback });
    h.fetch.mockImplementation(async () => { h.deny(); return Response.json({ access_token: "private-access", scope: "read" }); });
    await expect(service.completeOAuth({ state: start.state, code: "code" })).rejects.toMatchObject({ code: "policy_denied" });
    expect(h.fetch).toHaveBeenCalledOnce();
    expect(await h.store.listConnections()).toEqual([]);
  });

  it.each(["credential", "token", "request", "refresh"])("denies %s without exposing or refreshing an existing credential", async operation => {
    const h = harness();
    const connection = await h.service.completeOAuth({ state: (await h.start()).state, code: "code" });
    h.fetch.mockClear();
    h.deny();
    const read = vi.spyOn(h.secrets, "getSecret");
    const input = { connectionId: connection.id };
    const work = operation === "token" ? h.service.getToken(input) : operation === "request"
      ? h.service.request({ ...input, request: { method: "GET", path: "/records" } })
      : h.service.resolveCredential({ ...input, forceRefresh: operation === "refresh" });
    await expect(work).rejects.toMatchObject({ code: "policy_denied" });
    expect(h.fetch).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    // Revocation must remain possible during an OAuth shutdown.
    await h.service.revokeConnection(input);
    expect((await h.store.getConnection(connection.id))?.status).toBe("revoked");
  });

  it("rechecks refresh authorization after waiting for a coordinator", async () => {
    const h = harness();
    const connection = await h.service.completeOAuth({ state: (await h.start()).state, code: "code" });
    const service = createConnectService({ providers: [provider], store: h.store, secrets: h.secrets,
      fetch: h.fetch, resolveHostname: async () => ["8.8.8.8"], authorizeOAuth: h.authorizeOAuth,
      oauthClients: { resolve: async () => h.client, resolveById: async () => h.client },
      refreshCoordinator: { runExclusive: async (_key, work) => { h.deny(); return work(); } } });
    h.fetch.mockClear();
    await expect(service.resolveCredential({ connectionId: connection.id, forceRefresh: true })).rejects.toMatchObject({ code: "policy_denied" });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("does not release a credential after host denial during refresh", async () => {
    const h = harness();
    const connection = await h.service.completeOAuth({ state: (await h.start()).state, code: "code" });
    h.fetch.mockImplementation(async () => { h.deny(); return Response.json({ access_token: "rotated-access", scope: "read" }); });
    await expect(h.service.resolveCredential({ connectionId: connection.id, forceRefresh: true }))
      .rejects.toMatchObject({ code: "policy_denied" });
    expect(await h.secrets.getSecret(connection.secretRef!)).toMatchObject({ tokens: { accessToken: "rotated-access" } });
  });

  it("cleans up a staged callback secret if the gate closes before activation", async () => {
    const h = harness();
    const start = await h.start();
    const save = h.secrets.setSecret.bind(h.secrets);
    const write = vi.spyOn(h.secrets, "setSecret").mockImplementation(async (...args) => { await save(...args); h.deny(); });
    await expect(h.service.completeOAuth({ state: start.state, code: "code" })).rejects.toMatchObject({ code: "policy_denied" });
    expect(write).toHaveBeenCalledOnce();
    expect(await h.secrets.getSecret(write.mock.calls[0][0])).toBeNull();
    expect(await h.store.listConnections()).toEqual([]);
  });

  it("does not subject static API keys or public access to the OAuth host gate", async () => {
    const h = harness();
    h.deny();
    const service = createConnectService({ store: h.store, secrets: h.secrets, authorizeOAuth: h.authorizeOAuth,
      providers: [
        { id: "key", name: "Key", auth: { type: "api_key" } },
        { id: "public", name: "Public", auth: { type: "none" }, http: { origins: ["https://public.example"], auth: { mode: "none" } } },
      ] });
    const key = await service.createApiKeyConnection({ providerId: "key", apiKey: "static-fixture" });
    const anonymous = await service.createPublicConnection({ providerId: "public" });
    await expect(service.resolveCredential({ connectionId: key.id })).resolves.toMatchObject({ kind: "api_key", value: "static-fixture" });
    await expect(service.resolveCredential({ connectionId: anonymous.id })).resolves.toMatchObject({ kind: "none" });
    expect(h.authorizeOAuth).not.toHaveBeenCalled();
  });

  it("checks MCP OAuth before reading its encrypted material but leaves bearer MCP usable", async () => {
    const h = harness();
    const timestamp = new Date().toISOString();
    const base: ConnectionRecord = { id: "mcp-connection", providerId: "mcp_url", projectId: "project", orgId: "org",
      authType: "mcp", status: "active", grantedScopes: [], secretRef: "mcp-secret", createdAt: timestamp, updatedAt: timestamp,
      metadata: { url: "https://mcp.example/mcp", auth: "oauth2" } };
    await h.store.upsertConnection(base);
    h.deny();
    const read = vi.spyOn(h.secrets, "getSecret");
    await expect(h.service.resolveCredential({ connectionId: base.id })).rejects.toMatchObject({ code: "policy_denied" });
    expect(read).not.toHaveBeenCalled();
    expect(h.authorizeOAuth).toHaveBeenLastCalledWith(expect.objectContaining({ protocol: "mcp", operation: "credential" }));
    await h.store.upsertConnection({ ...base, metadata: { ...base.metadata, auth: "bearer" } });
    await h.secrets.setSecret(base.secretRef!, { kind: "mcp", apiKey: "bearer-fixture" });
    await expect(h.service.resolveCredential({ connectionId: base.id })).resolves.toMatchObject({ accessToken: "bearer-fixture" });
  });
});
