import { beforeEach, describe, expect, it, vi } from "vitest";
const discover = vi.fn(), register = vi.fn(), start = vi.fn(), exchange = vi.fn();
vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => ({
  discoverOAuthServerInfo: (...args: unknown[]) => discover(...args), registerClient: (...args: unknown[]) => register(...args),
  startAuthorization: (...args: unknown[]) => start(...args), exchangeAuthorization: (...args: unknown[]) => exchange(...args),
}));
import type { ConnectorProviderDefinition, ResolvedMcpOAuthClient } from "@polpo-ai/connect";
import { createConnectService, MemoryConnectStore, MemoryConnectionSecretStore } from "../index.js";

const provider: ConnectorProviderDefinition = { id: "mcp_url", name: "MCP", auth: { type: "mcp", auth: "oauth2", defaultScopes: ["read"] }, scopes: [{ id: "read" }] };
function harness(mode: "managed" | "customer" | "instance" = "managed", registration: ResolvedMcpOAuthClient["registration"]["mode"] = "dynamic") {
  const store = new MemoryConnectStore(), secrets = new MemoryConnectionSecretStore();
  let client: ResolvedMcpOAuthClient | null = { id: "mcp-config", providerId: provider.id,
    owner: mode === "managed" ? { type: "platform", id: "host" } : mode === "customer" ? { type: "project", id: "project" } : { type: "instance", id: "host" },
    resourceUrl: "https://mcp.example/mcp", transport: "http", redirectUri: "https://host.example/callback",
    registration: registration === "dynamic" ? { mode: registration, clientName: "Example app" }
      : registration === "metadata_document" ? { mode: registration, clientMetadataUrl: "https://app.example/oauth/client.json" }
      : { mode: registration, client: { client_id: "registered", client_secret: "private-secret" } } };
  const resolver = { resolve: vi.fn(async () => client!), resolveById: vi.fn(async () => client) };
  const createService = () => createConnectService({ providers: [provider], store, secrets, setupSessions: store, links: store,
    mcpOAuthClients: resolver, allowedReturnUrlOrigins: ["https://app.example"], resolveHostname: async () => ["8.8.8.8"] });
  const service = createService();
  const setup = () => service.createSetupSession({ providerId: provider.id, projectId: "project", orgId: "org", audience: "end_user",
    subject: { type: "external_user", namespace: "application", id: "gioia" }, binding: { scopeEpoch: "epoch" },
    returnUrl: "https://app.example/connected", oauthClientMode: mode, configurationId: "mcp-config" });
  return { store, secrets, resolver, service, createService, setup, getClient: () => client!, setClient: (value: ResolvedMcpOAuthClient | null) => { client = value; } };
}

beforeEach(() => {
  vi.clearAllMocks();
  discover.mockResolvedValue({ authorizationServerUrl: "https://auth.example/", authorizationServerMetadata: {
    authorization_endpoint: "https://auth.example/authorize", token_endpoint: "https://auth.example/token", registration_endpoint: "https://auth.example/register",
    code_challenge_methods_supported: ["S256"], client_id_metadata_document_supported: true }, resourceMetadata: { resource: "https://mcp.example/mcp" } });
  register.mockResolvedValue({ client_id: "dynamic-client" });
  start.mockResolvedValue({ authorizationUrl: new URL("https://auth.example/authorize"), codeVerifier: "private-verifier" });
  exchange.mockResolvedValue({ access_token: "private-access", refresh_token: "private-refresh", scope: "read" });
});

describe("embedded MCP OAuth setup", () => {
  it("rejects an incomplete embedded host before persisting or consuming setup", async () => {
    const h = harness();
    Object.assign(h.store, { failMcpOAuthSetup: undefined });
    const save = vi.spyOn(h.store, "saveConnectionSetupSession");
    await expect(h.setup()).rejects.toMatchObject({ code: "setup_invalid" });
    expect(save).not.toHaveBeenCalled();
  });

  it.each(["url", "transport", "oauthClientMode", "redirectUri"])("rejects state/configuration mismatch for %s before exchanging tokens", async field => {
    const h = harness(), setup = await h.setup();
    const started = await h.service.startOAuthSetup({ setupSessionId: setup.id });
    const state = (await h.store.getOAuthState(started.state))!;
    await h.store.saveOAuthState({ ...state, ...(field === "redirectUri" ? { redirectUri: "https://other.example/callback" }
      : { metadata: { ...state.metadata, [field]: field === "url" ? "https://other.example/mcp" : field === "transport" ? "sse" : "pre_registered" } }) });
    await expect(h.service.completeMcpOAuth({ state: started.state, code: "once" })).rejects.toMatchObject({ code: "setup_invalid" });
    expect(exchange).not.toHaveBeenCalled();
    expect(await h.store.listConnections()).toEqual([]);
  });

  it.each(["managed", "customer", "instance"] as const)("uses one lifecycle for %s ownership across all registration methods", async mode => {
    for (const registration of ["dynamic", "metadata_document", "pre_registered"] as const) {
      const h = harness(mode, registration), setup = await h.setup();
      expect(setup).toMatchObject({ flowKind: "mcp", oauthClientId: "mcp-config" });
      expect(h.resolver.resolve).toHaveBeenCalledWith(expect.objectContaining({ configurationId: "mcp-config", mode, projectId: "project" }));
      expect(JSON.stringify(setup)).not.toContain("private-secret");
      const started = await h.service.startOAuthSetup({ setupSessionId: setup.id });
      const state = (await h.store.getOAuthState(started.state))!;
      expect(state).toMatchObject({ flowKind: "mcp", setupSessionRef: setup.id, returnUrl: setup.returnUrl,
        oauthClientId: setup.oauthClientId, oauthClientFingerprint: setup.oauthClientFingerprint });
      const result = await h.service.completeOAuthCallback({ state: started.state, code: "code" });
      expect(result.returnUrl).toBe(setup.returnUrl);
      expect(result.connection).toMatchObject({ authType: "mcp", status: "active", audience: "end_user", owner: setup.subject,
        binding: setup.binding, oauthClientId: "mcp-config", oauthClientFingerprint: setup.oauthClientFingerprint });
      expect(result.connection.projectId).toBeUndefined();
      expect(await h.store.listConnectionLinks()).toMatchObject([{ connectionId: result.connection.id, projectId: "project", status: "active" }]);
      expect(await h.service.getSetupStatus(setup.id)).toMatchObject({ status: "completed", resultingConnectionId: result.connection.id });
      await expect(h.createService().completeMcpOAuth({ state: started.state, code: "spent" })).resolves.toEqual(result.connection);
    }
  });

  it("rejects changed configuration before consent and does not trust direct-start setup fields", async () => {
    const h = harness(), setup = await h.setup();
    h.setClient({ ...h.getClient(), resourceUrl: "https://other.example/mcp" });
    await expect(h.service.startOAuthSetup({ setupSessionId: setup.id })).rejects.toMatchObject({ code: "setup_invalid" });
    expect(discover).not.toHaveBeenCalled();
    expect(await h.service.getSetupStatus(setup.id)).toMatchObject({ status: "error" });
    const started = await h.service.startMcpOAuth({ url: "https://mcp.example/mcp", redirectUri: "https://host.example/callback", mode: "dynamic",
      ...{ setupSessionRef: setup.id, oauthClientId: "mcp-config", authorizationExpiresAt: "2099-01-01" }, metadata: { setupSessionRef: setup.id } });
    expect(await h.store.getOAuthState(started.state)).toMatchObject({ flowKind: "mcp" });
    expect((await h.store.getOAuthState(started.state))?.setupSessionRef).toBeUndefined();
  });

  it.each(["before_exchange", "during_exchange"])("rejects revoked configuration %s without activating, and retains spent-code tokens", async point => {
    const h = harness(), setup = await h.setup(), client = h.getClient();
    const started = await h.service.startOAuthSetup({ setupSessionId: setup.id });
    if (point === "before_exchange") h.setClient(null);
    else exchange.mockImplementationOnce(async () => { h.setClient(null); return { access_token: "staged", scope: "read" }; });
    await expect(h.service.completeMcpOAuth({ state: started.state, code: "once" })).rejects.toMatchObject({ code: "setup_invalid" });
    expect(await h.store.listConnections()).toEqual([]);
    expect(await h.store.listConnectionLinks()).toEqual([]);
    h.setClient(client);
    await expect(h.service.completeMcpOAuth({ state: started.state, code: "once" })).resolves.toMatchObject({ status: "active" });
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it("uses current preregistered secrets after rotation without changing client identity", async () => {
    const h = harness("customer", "pre_registered"), setup = await h.setup();
    const started = await h.service.startOAuthSetup({ setupSessionId: setup.id });
    h.setClient({ ...h.getClient(), registration: { mode: "pre_registered", client: { client_id: "registered", client_secret: "rotated-private" } } });
    await h.service.completeMcpOAuth({ state: started.state, code: "once" });
    expect(JSON.stringify(exchange.mock.calls)).toContain("rotated-private");
    expect(JSON.stringify(exchange.mock.calls)).not.toContain("private-secret");
  });

  it("denies credential delivery after its reusable configuration is revoked", async () => {
    const h = harness(), setup = await h.setup();
    const started = await h.service.startOAuthSetup({ setupSessionId: setup.id });
    const connection = await h.service.completeMcpOAuth({ state: started.state, code: "once" });
    await expect(h.service.resolveCredential({ connectionId: connection.id })).resolves.toMatchObject({ kind: "mcp" });
    h.setClient(null);
    await expect(h.service.resolveCredential({ connectionId: connection.id })).rejects.toMatchObject({ code: "setup_invalid" });
  });

  it("recovers all four committed records after an acknowledgement is lost", async () => {
    const h = harness(), setup = await h.setup();
    const started = await h.service.startOAuthSetup({ setupSessionId: setup.id });
    const commit = h.store.commitMcpOAuthSetup.bind(h.store);
    vi.spyOn(h.store, "commitMcpOAuthSetup").mockImplementationOnce(async input => { await commit(input); throw new Error("lost ack"); });
    await expect(h.service.completeMcpOAuth({ state: started.state, code: "once" })).rejects.toThrow("lost ack");
    const result = await h.createService().completeMcpOAuth({ state: started.state, code: "once" });
    expect(exchange).toHaveBeenCalledTimes(1);
    expect(await h.store.listConnectionLinks()).toHaveLength(1);
    expect(await h.service.getSetupStatus(setup.id)).toMatchObject({ status: "completed", resultingConnectionId: result.id });
    const [link] = await h.store.listConnectionLinks();
    await h.store.updateConnectionLink(link.id, { status: "revoked" });
    await expect(h.service.completeMcpOAuth({ state: started.state, code: "once" })).rejects.toMatchObject({ code: "setup_invalid" });
  });

  it("denial finishes the setup without an account or project link", async () => {
    const h = harness(), setup = await h.setup();
    const started = await h.service.startOAuthSetup({ setupSessionId: setup.id });
    await expect(h.service.completeMcpOAuth({ state: started.state, error: "access_denied" })).rejects.toMatchObject({ code: "oauth_error" });
    expect(await h.service.getSetupStatus(setup.id)).toMatchObject({ status: "error" });
    expect(await h.store.listConnections()).toEqual([]);
    expect(await h.store.listConnectionLinks()).toEqual([]);
  });

  it("a delayed denial cannot fail setup after a new callback has claimed it", async () => {
    const h = harness(), setup = await h.setup();
    const started = await h.service.startOAuthSetup({ setupSessionId: setup.id });
    const fail = h.store.failMcpOAuthSetup.bind(h.store);
    vi.spyOn(h.store, "failMcpOAuthSetup").mockImplementationOnce(async input => {
      const state = (await h.store.getOAuthState(started.state))!;
      await h.store.saveOAuthState({ ...state, claimToken: "new-worker", claimExpiresAt: new Date(Date.now() + 60_000).toISOString() });
      return fail(input);
    });
    await expect(h.service.completeMcpOAuth({ state: started.state, error: "access_denied" })).rejects.toMatchObject({ code: "oauth_callback_in_progress" });
    expect(await h.service.getSetupStatus(setup.id)).toMatchObject({ status: "started" });
    expect(await h.store.getOAuthState(started.state)).toMatchObject({ status: "processing", claimToken: "new-worker" });
    await h.store.releaseOAuthState(started.state, "new-worker", "retry");
    await expect(h.service.completeMcpOAuth({ state: started.state, code: "once" })).resolves.toMatchObject({ status: "active" });
  });
});
