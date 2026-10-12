import { beforeEach, describe, expect, it, vi } from "vitest";

const discoverMock = vi.fn();
const registerMock = vi.fn();
const startMock = vi.fn();
const exchangeMock = vi.fn();
const refreshMock = vi.fn();
vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => ({
  discoverOAuthServerInfo: (...args: unknown[]) => discoverMock(...args),
  registerClient: (...args: unknown[]) => registerMock(...args),
  startAuthorization: (...args: unknown[]) => startMock(...args),
  exchangeAuthorization: (...args: unknown[]) => exchangeMock(...args),
  refreshAuthorization: (...args: unknown[]) => refreshMock(...args),
}));

import { ConnectError, type ConnectorProviderDefinition } from "@polpo-ai/connect";
import {
  MemoryConnectStore,
  MemoryConnectionSecretStore,
  createConnectService,
  type CreateConnectServiceOptions,
} from "../index.js";

const provider: ConnectorProviderDefinition = {
  id: "mcp_url",
  name: "MCP URL",
  auth: { type: "mcp", auth: "oauth2", defaultScopes: ["tools:read"] },
  scopes: [{ id: "tools:read" }, { id: "tools:call" }],
};

describe("ConnectService MCP OAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    discoverMock.mockResolvedValue({
      authorizationServerUrl: "https://auth.example/",
      authorizationServerMetadata: {
        authorization_endpoint: "https://auth.example/authorize",
        token_endpoint: "https://auth.example/token",
        registration_endpoint: "https://auth.example/register",
        code_challenge_methods_supported: ["S256"],
      },
      resourceMetadata: { resource: "https://mcp.example/mcp" },
    });
    registerMock.mockResolvedValue({ client_id: "client-1" });
    startMock.mockResolvedValue({ authorizationUrl: new URL("https://auth.example/authorize"), codeVerifier: "verifier" });
    exchangeMock.mockResolvedValue({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 1, scope: "tools:read" });
    refreshMock.mockResolvedValue({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600, scope: "tools:read" });
  });

  it("fences a second replica's refresh even when its coordinator has no shared lease", async () => {
    const f = harness();
    const connection = await connect(f.service);
    const second = harness(undefined, { store: f.store, secrets: f.secrets }).service;
    let entered!: () => void;
    let release!: (value: unknown) => void;
    const dispatched = new Promise<void>(resolve => { entered = resolve; });
    refreshMock.mockImplementationOnce(async () => {
      entered(); return new Promise(resolve => { release = resolve; });
    });
    const first = f.service.getToken({ connectionId: connection.id, forceRefresh: true });
    await dispatched;
    try {
      await expect(second.getToken({ connectionId: connection.id, forceRefresh: true }))
        .rejects.toMatchObject({ code: "refresh_unavailable" });
      expect(refreshMock).toHaveBeenCalledOnce();
    } finally {
      release({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600, scope: "tools:read" });
      await first;
    }
    await expect(second.getToken({ connectionId: connection.id })).resolves.toMatchObject({ accessToken: "access-2" });
    expect(refreshMock).toHaveBeenCalledOnce();
  });

  it("does not reuse an uncertain MCP refresh token, even while the old access token has not expired", async () => {
    const f = harness();
    const connection = await connect(f.service);
    refreshMock.mockRejectedValueOnce(new Error("response lost after token rotation"));
    await expect(f.service.getToken({ connectionId: connection.id, forceRefresh: true })).rejects.toThrow();
    const second = harness(undefined, { store: f.store, secrets: f.secrets }).service;
    await expect(second.getToken({ connectionId: connection.id })).rejects.toMatchObject({ code: "refresh_unavailable" });
    expect(refreshMock).toHaveBeenCalledOnce();
  });

  it("can retry after a host denial between the durable intent and MCP provider dispatch", async () => {
    let denied = false;
    const { service, secrets } = harness(undefined, { authorizeOAuth: async () => { if (denied) throw new ConnectError("policy_denied", "disabled"); } });
    const connection = await connect(service);
    const save = secrets.compareAndSet.bind(secrets);
    vi.spyOn(secrets, "compareAndSet").mockImplementationOnce(async (...args) => {
      const result = await save(...args); denied = true; return result;
    });
    await expect(service.getToken({ connectionId: connection.id, forceRefresh: true })).rejects.toMatchObject({ code: "policy_denied" });
    expect(refreshMock).not.toHaveBeenCalled();
    denied = false;
    await expect(service.getToken({ connectionId: connection.id, forceRefresh: true })).resolves.toMatchObject({ accessToken: "access-2" });
    expect(refreshMock).toHaveBeenCalledOnce();
  });

  it.each(["read_failure", "scope_restricted"])("persists rotated MCP tokens before a post-refresh %s", async failure => {
    const { service, store, secrets } = harness();
    const connection = await connect(service);
    refreshMock.mockImplementationOnce(async () => {
      if (failure === "read_failure") vi.spyOn(store, "getConnection").mockRejectedValueOnce(new Error("temporary read failure"));
      else await store.updateConnection(connection.id, { grantedScopes: [] });
      return { access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600, scope: "tools:read" };
    });
    const request = { connectionId: connection.id, scopes: ["tools:read"] };
    await expect(service.getToken({ ...request, forceRefresh: true })).rejects.toThrow();
    expect(await secrets.getSecret(connection.secretRef!)).toMatchObject({ mcpOAuth: { tokens: { refreshToken: "refresh-2" } },
      metadata: { "polpo:oauth-refresh:v1": { status: "completed" } } });
    if (failure === "scope_restricted") {
      await expect(service.getToken(request)).rejects.toThrow();
      await store.updateConnection(connection.id, { grantedScopes: ["tools:read"] });
    }
    await expect(service.getToken(request)).resolves.toMatchObject({ accessToken: "access-2" });
    expect(refreshMock).toHaveBeenCalledOnce();
  });

  it("bounds discovery bodies before the MCP SDK parses them", async () => {
    const cancel = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(256 * 1024 + 1)); }, cancel,
    })));
    discoverMock.mockImplementationOnce(async (_url, options) => {
      await options.fetchFn("https://auth.example/.well-known/oauth-authorization-server");
      throw new Error("must not reach parser");
    });
    const service = createConnectService({ providers: [provider], store: new MemoryConnectStore(), secrets: new MemoryConnectionSecretStore(),
      fetch, resolveHostname: async () => ["8.8.8.8"],
    });
    await expect(service.inspectMcpOAuth({ url: "https://mcp.example/mcp" }))
      .rejects.toMatchObject({ code: "http_error", details: { category: "response_too_large" } });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("persists transient OAuth material encrypted and completes one idempotent connection", async () => {
    const { service, store, secrets } = harness();
    const started = await service.startMcpOAuth({
      url: "https://mcp.example/mcp",
      redirectUri: "https://polpo.example/v1/connect/oauth/callback",
      mode: "dynamic",
      projectId: "project-1",
      name: "Example MCP",
    });
    const state = await store.getOAuthState(started.state);
    expect(state).toMatchObject({ flowKind: "mcp", status: "pending", requestedScopes: ["tools:read"] });
    expect(state?.metadata).not.toHaveProperty("client_secret");
    expect(await secrets.getSecret(state!.temporarySecretRef!)).toMatchObject({
      kind: "mcp",
      mcpOAuth: { client: { client_id: "client-1" }, codeVerifier: "verifier" },
    });

    const connection = await service.completeMcpOAuth({ state: started.state, code: "code-1" });
    expect(connection).toMatchObject({ status: "active", projectId: "project-1", metadata: { auth: "oauth2" } });
    expect(connection.metadata).not.toHaveProperty("pendingConnectionId");
    await expect(service.completeMcpOAuth({ state: started.state, code: "same-code" })).resolves.toEqual(connection);
    expect(exchangeMock).toHaveBeenCalledTimes(1);
  });

  it("releases a failed callback claim so a retry can succeed", async () => {
    const { service, store } = harness();
    const started = await service.startMcpOAuth({
      url: "https://mcp.example/mcp",
      redirectUri: "https://polpo.example/v1/connect/oauth/callback",
      mode: "dynamic",
    });
    exchangeMock.mockRejectedValueOnce(new Error("temporary token failure"));
    await expect(service.completeMcpOAuth({ state: started.state, code: "code-1" })).rejects.toMatchObject({ code: "token_exchange_failed" });
    await expect(store.getOAuthState(started.state)).resolves.toMatchObject({ status: "pending", attempts: 1, lastErrorCode: "token_exchange_failed" });
    await expect(service.completeMcpOAuth({ state: started.state, code: "code-1" })).resolves.toMatchObject({ status: "active" });
  });

  it("recovers a committed MCP authorization state after a lost acknowledgement", async () => {
    const { service, store, secrets } = harness();
    const persist = store.saveOAuthState.bind(store);
    vi.spyOn(store, "saveOAuthState").mockImplementationOnce(async record => {
      await persist(record); throw new Error("acknowledgement lost");
    });
    const started = await service.startMcpOAuth({ url: "https://mcp.example/mcp", redirectUri: "https://polpo.example/callback", mode: "dynamic" });
    const state = (await store.getOAuthState(started.state))!;
    expect(await secrets.getSecret(state.temporarySecretRef!)).not.toBeNull();
    await expect(service.completeMcpOAuth({ state: started.state, code: "code" })).resolves.toMatchObject({ status: "active" });
  });

  it.each(["missing", "read_failed"] as const)("retains pending MCP OAuth material when state persistence is uncertain: %s", async (failure) => {
    const { service, store, secrets } = harness();
    const save = vi.spyOn(secrets, "setSecret");
    vi.spyOn(store, "saveOAuthState").mockRejectedValueOnce(new Error("acknowledgement lost"));
    if (failure === "read_failed") vi.spyOn(store, "getOAuthState").mockRejectedValueOnce(new Error("read unavailable"));
    await expect(service.startMcpOAuth({ url: "https://mcp.example/mcp", redirectUri: "https://polpo.example/callback", mode: "dynamic" })).rejects.toThrow("acknowledgement lost");
    expect(await secrets.getSecret(save.mock.calls[0][0])).not.toBeNull();
  });

  it("preserves end-user identity across MCP consent without trusting caller discovery metadata", async () => {
    const { service, store } = harness();
    const subject = { type: "external_user" as const, namespace: "application", id: "viewer" };
    const started = await service.startMcpOAuth({ url: "https://mcp.example/mcp", mode: "dynamic",
      redirectUri: "https://polpo.example/callback", audience: "end_user", subject,
      binding: { scopeEpoch: "epoch-1" }, metadata: { serverName: "notes", discoveredTools: [{ name: "forged" }], lastDiscoveredAt: "2099" } });
    expect(await store.getOAuthState(started.state)).toMatchObject({ audience: "end_user", subject,
      binding: { principal: subject, scopeEpoch: "epoch-1" } });
    const connection = await service.completeMcpOAuth({ state: started.state, code: "code" });
    expect(connection).toMatchObject({ audience: "end_user", owner: subject,
      binding: { principal: subject, scopeEpoch: "epoch-1" } });
    expect(connection.metadata).not.toHaveProperty("discoveredTools");
    expect(connection.metadata).not.toHaveProperty("lastDiscoveredAt");
  });

  it("rejects conflicting MCP OAuth identity before discovery or registration", async () => {
    const { service } = harness();
    await expect(service.startMcpOAuth({ url: "https://mcp.example/mcp", mode: "dynamic",
      redirectUri: "https://polpo.example/callback", audience: "personal", subject: { type: "project", id: "project" },
    })).rejects.toMatchObject({ code: "setup_invalid" });
    expect(discoverMock).not.toHaveBeenCalled();
    expect(registerMock).not.toHaveBeenCalled();
  });

  it("reuses exchanged tokens when saving the Connection fails after a one-time code was spent", async () => {
    const { service, store } = harness();
    const started = await service.startMcpOAuth({ url: "https://mcp.example/mcp", redirectUri: "https://polpo.example/callback", mode: "dynamic" });
    vi.spyOn(store, "commitMcpOAuthConnection").mockRejectedValueOnce(new Error("database unavailable"));
    await expect(service.completeMcpOAuth({ state: started.state, code: "one-time-code" })).rejects.toThrow("database unavailable");
    await expect(service.completeMcpOAuth({ state: started.state, code: "one-time-code" })).resolves.toMatchObject({ status: "active" });
    expect(exchangeMock).toHaveBeenCalledOnce();
  });

  it.each(["expired", "replaced"] as const)("cannot activate after its callback claim is %s", async (kind) => {
    let clock = new Date("2026-08-31T12:00:00.000Z");
    const { service, store, secrets } = harness(() => clock, { mcpOAuthCallbackClaimTtlMs: 1000 });
    const started = await service.startMcpOAuth({ url: "https://mcp.example/mcp", redirectUri: "https://polpo.example/callback", mode: "dynamic" });
    const write = secrets.setSecret.bind(secrets);
    vi.spyOn(secrets, "setSecret").mockImplementationOnce(async (...args) => {
      await write(...args);
      clock = new Date(clock.getTime() + 2000);
      if (kind === "replaced") await store.claimOAuthState(started.state, "replacement", new Date(clock.getTime() + 1000).toISOString(), clock.toISOString());
    });
    await expect(service.completeMcpOAuth({ state: started.state, code: "once" })).rejects.toMatchObject({ code: "oauth_callback_in_progress" });
    expect(await store.listConnections()).toEqual([]);
    expect((await store.getOAuthState(started.state))?.status).not.toBe("completed");
  });

  it("does not resurrect an existing revoked pending account", async () => {
    const { service, store } = harness();
    const started = await service.startMcpOAuth({ url: "https://mcp.example/mcp", redirectUri: "https://polpo.example/callback", mode: "dynamic" });
    const pending = (await store.getOAuthState(started.state))!;
    await store.upsertConnection({ id: String(pending.metadata?.pendingConnectionId), providerId: "mcp_url", authType: "mcp", status: "revoked", grantedScopes: [], createdAt: pending.createdAt, updatedAt: pending.createdAt });
    await expect(service.completeMcpOAuth({ state: started.state, code: "once" })).rejects.toMatchObject({ code: "oauth_callback_in_progress" });
    expect(await store.listConnections()).toMatchObject([{ status: "revoked" }]);
  });

  it("never overwrites a newer secret generation when a delayed token exchange returns", async () => {
    const { service, store, secrets } = harness();
    const started = await service.startMcpOAuth({ url: "https://mcp.example/mcp", redirectUri: "https://polpo.example/callback", mode: "dynamic" });
    const ref = (await store.getOAuthState(started.state))!.temporarySecretRef!;
    exchangeMock.mockImplementationOnce(async () => {
      const existing = (await secrets.getSecret(ref))!;
      await secrets.setSecret(ref, { ...existing, mcpOAuth: { ...existing.mcpOAuth!, tokens: { accessToken: "newer", scopes: ["tools:read"] } } });
      return { access_token: "stale", scope: "tools:read" };
    });
    await expect(service.completeMcpOAuth({ state: started.state, code: "once" })).rejects.toMatchObject({ code: "oauth_callback_in_progress" });
    expect(await secrets.getSecret(ref)).toMatchObject({ mcpOAuth: { tokens: { accessToken: "newer" } } });
    expect(await store.listConnections()).toEqual([]);
  });

  it("recovers an atomic activation after a lost commit acknowledgement", async () => {
    const { service, store } = harness();
    const started = await service.startMcpOAuth({ url: "https://mcp.example/mcp", redirectUri: "https://polpo.example/callback", mode: "dynamic" });
    const commit = store.commitMcpOAuthConnection.bind(store);
    vi.spyOn(store, "commitMcpOAuthConnection").mockImplementationOnce(async input => {
      await commit(input); throw new Error("commit acknowledgement lost");
    });
    await expect(service.completeMcpOAuth({ state: started.state, code: "once" })).rejects.toThrow("commit acknowledgement lost");
    const account = await service.completeMcpOAuth({ state: started.state, code: "once" });
    expect(account.status).toBe("active");
    expect(await store.listConnections()).toHaveLength(1);
    expect(exchangeMock).toHaveBeenCalledOnce();
    await service.revokeConnection({ connectionId: account.id });
    await expect(service.completeMcpOAuth({ state: started.state, code: "once" })).rejects.toMatchObject({ code: "connection_revoked" });
  });

  it.each(["getOAuthState", "claimOAuthState", "releaseOAuthState", "commitMcpOAuthConnection"])("fails before discovery when the host lacks %s", async method => {
    const { service, store } = harness();
    Object.assign(store, { [method]: undefined });
    await expect(service.startMcpOAuth({ url: "https://mcp.example/mcp", redirectUri: "https://polpo.example/callback", mode: "dynamic" })).rejects.toMatchObject({ code: "setup_invalid" });
    expect(discoverMock).not.toHaveBeenCalled();
  });

  it("refreshes expired MCP OAuth tokens through the same connection", async () => {
    let current = new Date("2026-08-31T12:00:00.000Z");
    const { service } = harness(() => current);
    const started = await service.startMcpOAuth({
      url: "https://mcp.example/mcp",
      redirectUri: "https://polpo.example/v1/connect/oauth/callback",
      mode: "dynamic",
    });
    const connection = await service.completeMcpOAuth({ state: started.state, code: "code-1" });
    current = new Date("2026-08-31T12:02:00.000Z");
    await expect(service.resolveCredential({ connectionId: connection.id })).resolves.toMatchObject({
      kind: "mcp",
      accessToken: "access-2",
      tokenType: "Bearer",
    });
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it("keeps prior provider consent outside the Connection scope ceiling", async () => {
    exchangeMock.mockResolvedValueOnce({ access_token: "access-1", scope: "tools:read tools:call" });
    const { service } = harness();
    const connection = await connect(service);
    expect(connection.grantedScopes).toEqual(["tools:read"]);
    await expect(service.resolveCredential({ connectionId: connection.id, scopes: ["tools:call"] }))
      .rejects.toMatchObject({ code: "invalid_scope" });
  });

  it("rejects partial consent and scopes outside the Connector definition", async () => {
    const { service } = harness();
    await expect(connect(service, ["admin"])) .rejects.toMatchObject({ code: "invalid_scope" });
    exchangeMock.mockResolvedValueOnce({ access_token: "access-1", scope: "" });
    await expect(connect(service)).rejects.toMatchObject({ code: "invalid_scope" });
  });

  it("preserves the prior token scope set when a refresh omits scope", async () => {
    exchangeMock.mockResolvedValueOnce({ access_token: "access-1", refresh_token: "refresh-1", scope: "tools:read tools:call" });
    refreshMock.mockResolvedValueOnce({ access_token: "access-2", expires_in: 3600 });
    const { service, store } = harness();
    const connection = await connect(service, ["tools:read", "tools:call"]);
    await service.resolveCredential({ connectionId: connection.id, scopes: ["tools:read"], forceRefresh: true });
    expect(await store.getConnection(connection.id)).toMatchObject({ grantedScopes: ["tools:call", "tools:read"] });
    await expect(service.resolveCredential({ connectionId: connection.id, scopes: ["tools:call"] }))
      .resolves.toMatchObject({ accessToken: "access-2" });
  });

  it("denies a removed scope immediately after refresh", async () => {
    const { service, store } = harness();
    const connection = await connect(service);
    refreshMock.mockResolvedValueOnce({ access_token: "access-2", expires_in: 3600, scope: "" });
    await expect(service.resolveCredential({ connectionId: connection.id, scopes: ["tools:read"], forceRefresh: true }))
      .rejects.toMatchObject({ code: "invalid_scope" });
    expect(await store.getConnection(connection.id)).toMatchObject({ grantedScopes: [] });
  });

  it("single-flights concurrent forced refreshes", async () => {
    const { service } = harness();
    const connection = await connect(service);
    const credentials = await Promise.all(Array.from({ length: 8 }, () => service.resolveCredential({
      connectionId: connection.id, scopes: ["tools:read"], forceRefresh: true,
    })));
    expect(credentials).toHaveLength(8);
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it("does not recreate or return a credential revoked during refresh", async () => {
    const { service, secrets } = harness();
    const connection = await connect(service);
    refreshMock.mockImplementationOnce(async () => {
      await service.revokeConnection({ connectionId: connection.id });
      return { access_token: "late-access", refresh_token: "late-refresh", scope: "tools:read", expires_in: 3600 };
    });
    await expect(service.resolveCredential({ connectionId: connection.id, forceRefresh: true }))
      .rejects.toMatchObject({ code: "connection_revoked" });
    expect(await secrets.getSecret(connection.secretRef!)).toBeNull();
  });

  it("denies a pending MCP callback before exchanging its code when host authorization changes", async () => {
    let disabled = false;
    const { service, store } = harness(undefined, { authorizeOAuth: async () => {
      if (disabled) throw new ConnectError("policy_denied", "OAuth disabled");
    } });
    const started = await service.startMcpOAuth({ url: "https://mcp.example/mcp", redirectUri: "https://polpo.example/callback", mode: "dynamic" });
    disabled = true;
    await expect(service.completeOAuthCallback({ state: started.state, code: "code" })).rejects.toMatchObject({ code: "policy_denied" });
    expect(exchangeMock).not.toHaveBeenCalled();
    expect(await store.listConnections()).toEqual([]);
  });

  it("authorizes MCP refresh again after waiting for the coordinator", async () => {
    let disabled = false;
    const { service } = harness(undefined, { authorizeOAuth: async () => {
      if (disabled) throw new ConnectError("policy_denied", "OAuth disabled");
    }, refreshCoordinator: { runExclusive: async (_id, work) => { disabled = true; return work(); } } });
    const connection = await connect(service);
    await expect(service.resolveCredential({ connectionId: connection.id, forceRefresh: true })).rejects.toMatchObject({ code: "policy_denied" });
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("can retry without reusing a spent code if the host disables MCP OAuth during exchange", async () => {
    let disabled = false;
    const { service, store, secrets } = harness(undefined, { authorizeOAuth: async () => {
      if (disabled) throw new ConnectError("policy_denied", "OAuth disabled");
    } });
    const started = await service.startMcpOAuth({ url: "https://mcp.example/mcp", redirectUri: "https://polpo.example/callback", mode: "dynamic" });
    exchangeMock.mockImplementationOnce(async () => {
      disabled = true;
      return { access_token: "exchanged-access", refresh_token: "exchanged-refresh", scope: "tools:read" };
    });
    await expect(service.completeMcpOAuth({ state: started.state, code: "one-time-code" })).rejects.toMatchObject({ code: "policy_denied" });
    expect(await store.listConnections()).toEqual([]);
    const pending = await store.getOAuthState(started.state);
    expect(pending?.status).toBe("pending");
    expect(await secrets.getSecret(pending!.temporarySecretRef!)).toMatchObject({ mcpOAuth: { tokens: { accessToken: "exchanged-access" } } });
    disabled = false;
    await expect(service.completeMcpOAuth({ state: started.state, code: "one-time-code" })).resolves.toMatchObject({ status: "active" });
    expect(exchangeMock).toHaveBeenCalledOnce();
  });

  it("retains rotated MCP tokens but denies delivery if disabled during the refresh", async () => {
    let disabled = false;
    const { service, secrets } = harness(undefined, { authorizeOAuth: async () => {
      if (disabled) throw new ConnectError("policy_denied", "OAuth disabled");
    } });
    const connection = await connect(service);
    refreshMock.mockImplementationOnce(async () => {
      disabled = true;
      return { access_token: "rotated-access", refresh_token: "rotated-refresh", scope: "tools:read", expires_in: 3600 };
    });
    await expect(service.resolveCredential({ connectionId: connection.id, forceRefresh: true })).rejects.toMatchObject({ code: "policy_denied" });
    expect(await secrets.getSecret(connection.secretRef!)).toMatchObject({ mcpOAuth: {
      tokens: { accessToken: "rotated-access", refreshToken: "rotated-refresh" },
    } });
  });

  it("does not activate an MCP Connection when the host disables OAuth while staging the exchanged token", async () => {
    let disabled = false;
    const { service, secrets, store } = harness(undefined, { authorizeOAuth: async () => {
      if (disabled) throw new ConnectError("policy_denied", "OAuth disabled");
    } });
    const started = await service.startMcpOAuth({ url: "https://mcp.example/mcp", redirectUri: "https://polpo.example/callback", mode: "dynamic" });
    const save = secrets.setSecret.bind(secrets);
    vi.spyOn(secrets, "setSecret").mockImplementationOnce(async (...args) => { await save(...args); disabled = true; });
    await expect(service.completeMcpOAuth({ state: started.state, code: "code" })).rejects.toMatchObject({ code: "policy_denied" });
    expect(await store.listConnections()).toEqual([]);
    disabled = false;
    await expect(service.completeMcpOAuth({ state: started.state, code: "code" })).resolves.toMatchObject({ status: "active" });
    expect(exchangeMock).toHaveBeenCalledOnce();
  });
});

async function connect(service: ReturnType<typeof createConnectService>, scopes?: string[]) {
  const started = await service.startMcpOAuth({
    url: "https://mcp.example/mcp", redirectUri: "https://polpo.example/v1/connect/oauth/callback", mode: "dynamic", scopes,
  });
  return service.completeMcpOAuth({ state: started.state, code: "code-1" });
}

function harness(now: () => Date = () => new Date("2026-08-31T12:00:00.000Z"), options: Partial<CreateConnectServiceOptions> = {}) {
  const store = new MemoryConnectStore();
  const secrets = new MemoryConnectionSecretStore();
  const service = createConnectService({
    providers: [provider],
    store,
    secrets,
    fetch: vi.fn(async () => new Response(null, { status: 204 })) as any,
    resolveHostname: async () => ["93.184.216.34"],
    now,
    ...options,
  });
  return { service, store, secrets };
}
