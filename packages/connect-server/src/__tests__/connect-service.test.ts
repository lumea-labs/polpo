import { describe, expect, it, vi } from "vitest";
import { ConnectError, type ConnectorProviderDefinition, type TokenSet } from "@polpo-ai/connect";
import {
  MemoryConnectStore,
  MemoryConnectionSecretStore,
  MemoryTokenRefreshCoordinator,
  createConnectService,
} from "../index.js";

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
    extraAuthorizeParams: { audience: "polpo" },
  },
  scopes: [
    { id: "read" },
    { id: "write", dangerous: true },
  ],
};

const apiKeyProvider: ConnectorProviderDefinition = {
  id: "custom_api",
  name: "Custom API",
  auth: {
    type: "api_key",
    defaultScopes: ["use"],
  },
  scopes: [{ id: "use" }],
  http: {
    origins: ["https://api.example.com"],
    allowedMethods: ["GET", "POST"],
    allowedPathPatterns: ["/v1/items", "/v1/items/*"],
    auth: { mode: "header", name: "X-Api-Key" },
    maxRequestBytes: 1_024,
    maxResponseBytes: 1_024,
    timeoutMs: 5_000,
  },
};

const mcpProvider: ConnectorProviderDefinition = {
  id: "mcp_url",
  name: "MCP URL",
  auth: {
    type: "mcp",
    auth: "bearer",
    defaultScopes: ["tools:read", "tools:call"],
  },
  scopes: [
    { id: "tools:read" },
    { id: "tools:call", dangerous: true },
  ],
};

describe("connect service", () => {
  it("consumes a host dispatch budget after authorization on every API redirect", async () => {
    const fetchImpl = queueFetch([new Response(null, { status: 307, headers: { location: "/v1/items/next" } }), jsonResponse(200, {})]);
    const { service } = createHarness({ fetchImpl, providers: [{ ...apiKeyProvider, http: { ...apiKeyProvider.http!, followRedirects: true } }] });
    const connection = await service.createApiKeyConnection({ providerId: "custom_api", apiKey: "private", scopes: ["use"] });
    const order: string[] = [];
    const beforeDispatch = vi.fn(async () => {
      order.push("budget");
      if (order.filter(x => x === "budget").length > 1) throw new ConnectError("rate_limited", "Connection request limit exceeded");
    });
    await expect(service.request({ connectionId: connection.id, request: { method: "GET", path: "/v1/items" },
      authorizeDispatch: async () => { order.push("authorize"); }, beforeDispatch,
    })).rejects.toMatchObject({ code: "rate_limited", status: 429 });
    expect(order).toEqual(["authorize", "budget", "authorize", "authorize", "budget"]);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it.each(["credential", "grant"])("blocks a %s revoked while the quota is pending", async change => {
    const fetchImpl = queueFetch([jsonResponse(200, {})]);
    const { service } = createHarness({ fetchImpl });
    const connection = await service.createApiKeyConnection({ providerId: "custom_api", apiKey: "private", scopes: ["use"] });
    let granted = true;
    const beforeDispatch = vi.fn(async () => {
      if (change === "credential") await service.revokeConnection({ connectionId: connection.id });
      else granted = false;
    });
    await expect(service.request({ connectionId: connection.id, request: { method: "GET", path: "/v1/items" }, beforeDispatch,
      authorizeDispatch: async () => { if (!granted) throw new ConnectError("policy_denied", "Grant revoked"); },
    })).rejects.toMatchObject({ code: change === "credential" ? "connection_revoked" : "policy_denied" });
    expect(beforeDispatch).toHaveBeenCalledOnce();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("checks host invocation authority after token refresh and before sending credentials", async () => {
    let nowMs = Date.UTC(2026, 0, 1, 10, 0, 0);
    const fetchImpl = queueFetch([
      jsonResponse(200, { access_token: "old", refresh_token: "refresh", scope: "read", expires_in: 1 }),
      jsonResponse(200, { access_token: "fresh", scope: "read", expires_in: 3600 }),
      jsonResponse(200, { mustNotBeCalled: true }),
    ]);
    const { service } = createHarness({ providers: [{ ...oauthProvider, http: apiKeyProvider.http }], fetchImpl,
      now: () => new Date(nowMs), tokenRefreshSkewMs: 0 });
    const started = await service.startOAuth({ providerId: "test_oauth", scopes: ["read"], redirectUri: "https://app.example/callback" });
    const connection = await service.completeOAuth({ state: started.state, code: "fixture" });
    nowMs += 2000;
    const authorizeDispatch = vi.fn(async () => { throw new ConnectError("policy_denied", "Agent was deleted"); });
    await expect(service.request({ connectionId: connection.id, scopes: ["read"], request: { method: "GET", path: "/v1/items" }, authorizeDispatch }))
      .rejects.toMatchObject({ code: "policy_denied" });
    expect(authorizeDispatch).toHaveBeenCalledOnce();
    expect(fetchImpl.calls.map(call => call.url)).toEqual(["https://auth.example/token", "https://auth.example/token"]);
  });

  it("rechecks invocation authority before following an allowed provider redirect", async () => {
    const fetchImpl = queueFetch([new Response(null, { status: 307, headers: { location: "https://api.example.com/v1/items/next" } }), jsonResponse(200, {})]);
    const { service } = createHarness({ fetchImpl, providers: [{ ...apiKeyProvider, http: { ...apiKeyProvider.http!, followRedirects: true } }] });
    const connection = await service.createApiKeyConnection({ providerId: "custom_api", apiKey: "private", scopes: ["use"] });
    const authorizeDispatch = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new ConnectError("policy_denied", "Revoked during redirect"));
    await expect(service.request({ connectionId: connection.id, scopes: ["use"], request: { method: "GET", path: "/v1/items" }, authorizeDispatch }))
      .rejects.toMatchObject({ code: "policy_denied" });
    expect(authorizeDispatch).toHaveBeenCalledTimes(2); expect(fetchImpl.calls).toHaveLength(1);
  });
  it("binds end-user setup to its subject before consent and rejects conflicting identity", async () => {
    const client = { id: "setup-client", providerId: "test_oauth", clientId: "fixture-client",
      redirectUris: ["https://host.example/callback"], owner: { type: "instance" as const, id: "instance" } };
    const { service } = createHarness({ allowedReturnUrlOrigins: ["https://app.example"],
      oauthClients: { resolve: async () => client, resolveById: async () => client } });
    const base = { providerId: "test_oauth", projectId: "project", returnUrl: "https://app.example/settings",
      audience: "end_user" as const, subject: { type: "external_user" as const, namespace: "app", id: "user-a" } };
    expect(await service.createSetupSession(base)).toMatchObject({
      binding: { principal: { type: "external_user", namespace: "app", id: "user-a" } },
    });
    await expect(service.createSetupSession({ ...base,
      binding: { principal: { type: "external_user", namespace: "different-app", id: "user-a" } },
    })).rejects.toMatchObject({ code: "setup_invalid" });
    await expect(service.createSetupSession({ ...base,
      binding: { principal: { type: "external_user", id: "user-b" } },
    })).rejects.toMatchObject({ code: "setup_invalid" });
    await expect(service.createSetupSession({ ...base, subject: { type: "project", id: "project" } }))
      .rejects.toMatchObject({ code: "setup_invalid" });
    await expect(service.createSetupSession({ ...base, audience: "personal" }))
      .rejects.toMatchObject({ code: "setup_invalid" });
    expect(await service.createSetupSession({ ...base, audience: "personal", subject: { type: "user", id: "owner" } }))
      .toMatchObject({ binding: { principal: { type: "user", id: "owner" } } });
  });

  it.each(["api_key", "mcp"] as const)("retains %s credentials when a write outcome is unknown, even if a read sees no row", async (kind) => {
    const { service, store, secrets } = createHarness();
    const save = vi.spyOn(secrets, "setSecret");
    const persist = vi.spyOn(store, "upsertConnection").mockRejectedValueOnce(new Error("store unavailable"));
    const creation = kind === "api_key"
      ? service.createApiKeyConnection({ providerId: "custom_api", apiKey: "secret" })
      : service.createMcpConnection({ url: "https://mcp.example/mcp", bearerToken: "secret" });
    await expect(creation).rejects.toThrow("store unavailable");
    expect(await store.listConnections()).toEqual([]);
    expect(await secrets.getSecret(save.mock.calls[0]![0])).not.toBeNull();
    // A timeout can return before the remote writer eventually commits.
    const delayed = await store.upsertConnection(persist.mock.calls[0][0]);
    expect(await service.resolveCredential({ connectionId: delayed.id })).toMatchObject({ kind });
  });

  it.each(["api_key", "mcp"] as const)("recovers a confirmed %s commit after a lost acknowledgement", async (kind) => {
    const { service, store, secrets } = createHarness();
    const persist = store.upsertConnection.bind(store);
    vi.spyOn(store, "upsertConnection").mockImplementationOnce(async record => {
      await persist(record); throw new Error("acknowledgement lost");
    });
    const connection = await (kind === "api_key"
      ? service.createApiKeyConnection({ providerId: "custom_api", apiKey: "secret" })
      : service.createMcpConnection({ url: "https://mcp.example/mcp", bearerToken: "secret" }));
    expect(await store.getConnection(connection.id)).toEqual(connection);
    expect(await secrets.getSecret(connection.secretRef!)).not.toBeNull();
    expect(await service.resolveCredential({ connectionId: connection.id })).toMatchObject({ kind });
  });

  it.each(["read_failed", "revoked"] as const)("does not delete or reactivate a committed credential when recovery is %s", async (failure) => {
    const { service, store, secrets } = createHarness();
    const persist = store.upsertConnection.bind(store);
    vi.spyOn(store, "upsertConnection").mockImplementationOnce(async record => {
      await persist({ ...record, status: failure === "revoked" ? "revoked" : record.status });
      if (failure === "read_failed") vi.spyOn(store, "getConnection").mockRejectedValueOnce(new Error("read unavailable"));
      throw new Error("acknowledgement lost");
    });
    await expect(service.createApiKeyConnection({ providerId: "custom_api", apiKey: "secret" })).rejects.toThrow("acknowledgement lost");
    const [connection] = await store.listConnections();
    expect(connection.status).toBe(failure === "revoked" ? "revoked" : "active");
    expect(await secrets.getSecret(connection.secretRef!)).not.toBeNull();
  });

  it("recovers API OAuth persistence after a lost acknowledgement without deleting its tokens", async () => {
    const { service, store, secrets } = createHarness({ fetchImpl: queueFetch([
      jsonResponse(200, { access_token: "private-token", scope: "read" }),
    ]) });
    const started = await service.startOAuth({ providerId: "test_oauth", redirectUri: "https://app.example/callback" });
    const persist = store.upsertConnection.bind(store);
    vi.spyOn(store, "upsertConnection").mockImplementationOnce(async record => {
      await persist(record); throw new Error("acknowledgement lost");
    });
    const connection = await service.completeOAuth({ state: started.state, code: "one-time-code" });
    expect(await store.getConnection(connection.id)).toEqual(connection);
    expect(await secrets.getSecret(connection.secretRef!)).not.toBeNull();
  });

  it("preserves API OAuth tokens when an uncertain write commits after the callback error", async () => {
    const { service, store, secrets } = createHarness({ fetchImpl: queueFetch([
      jsonResponse(200, { access_token: "private-token", scope: "read" }),
    ]) });
    const started = await service.startOAuth({ providerId: "test_oauth", redirectUri: "https://app.example/callback" });
    const persist = vi.spyOn(store, "upsertConnection").mockRejectedValueOnce(new Error("database timeout"));
    await expect(service.completeOAuth({ state: started.state, code: "one-time-code" })).rejects.toThrow("database timeout");
    const delayed = await store.upsertConnection(persist.mock.calls[0][0]);
    expect(await secrets.getSecret(delayed.secretRef!)).not.toBeNull();
    expect(await service.resolveCredential({ connectionId: delayed.id })).toMatchObject({ kind: "oauth2" });
  });

  it("denies use after revocation even if secret deletion fails", async () => {
    const { service, store, secrets } = createHarness();
    const connection = await service.createApiKeyConnection({ providerId: "custom_api", apiKey: "secret" });
    vi.spyOn(secrets, "deleteSecret").mockRejectedValueOnce(new Error("vault unavailable"));
    await expect(service.revokeConnection({ connectionId: connection.id })).rejects.toThrow("vault unavailable");
    expect(await store.getConnection(connection.id)).toMatchObject({ status: "revoked" });
    await expect(service.getToken({ connectionId: connection.id })).rejects.toMatchObject({ code: "connection_revoked" });
    // A subsequent revoke retries secret cleanup.
    await service.revokeConnection({ connectionId: connection.id });
    expect(await secrets.getSecret(connection.secretRef!)).toBeNull();
  });

  it("creates API-key connections and returns runtime tokens without leaking metadata", async () => {
    const { service, secrets } = createHarness();
    const connection = await service.createApiKeyConnection({
      providerId: "custom_api",
      apiKey: "  sk_live_123  ",
      scopes: ["use"],
      subject: { type: "user", id: "usr_1" },
    });

    expect(connection.status).toBe("active");
    expect(connection.secretRef).toMatch(/^connsec_/);
    expect(connection).not.toHaveProperty("apiKey");
    expect(await secrets.getSecret(connection.secretRef!)).toEqual({ kind: "api_key", apiKey: "sk_live_123" });

    await expect(service.getToken({ connectionId: connection.id, scopes: ["use"] })).resolves.toMatchObject({
      accessToken: "sk_live_123",
      tokenType: "ApiKey",
      providerId: "custom_api",
    });
  });

  it("rejects empty API keys and invalid API-key scopes", async () => {
    const { service } = createHarness();
    await expect(service.createApiKeyConnection({ providerId: "custom_api", apiKey: "  " })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(service.createApiKeyConnection({ providerId: "custom_api", apiKey: "sk", scopes: ["admin"] })).rejects.toMatchObject({
      code: "invalid_scope",
    });
  });

  it("stores host-only API-key metadata with the encrypted secret", async () => {
    const { service, secrets } = createHarness();
    const connection = await service.createApiKeyConnection({
      providerId: "custom_api",
      apiKey: "sk_live_123",
      secretMetadata: {
        channelCredentials: { publicKey: "provider-public-key" },
      },
    });

    expect(connection.metadata).toBeUndefined();
    await expect(secrets.getSecret(connection.secretRef!)).resolves.toEqual({
      kind: "api_key",
      apiKey: "sk_live_123",
      metadata: {
        channelCredentials: { publicKey: "provider-public-key" },
      },
    });
  });

  it("creates bearer MCP connections and resolves MCP credentials without leaking the token", async () => {
    const { service, secrets } = createHarness();
    const connection = await service.createMcpConnection({
      name: "Linear MCP",
      url: "https://mcp.linear.example/mcp",
      auth: "bearer",
      bearerToken: "  lin_secret  ",
      scopes: ["tools:read", "tools:call"],
      metadata: { serverName: "linear" },
    });

    expect(connection).toMatchObject({
      providerId: "mcp_url",
      authType: "mcp",
      status: "active",
      grantedScopes: ["tools:call", "tools:read"],
      metadata: {
        url: "https://mcp.linear.example/mcp",
        transport: "http",
        auth: "bearer",
        serverName: "linear",
      },
    });
    expect(connection).not.toHaveProperty("bearerToken");
    expect(await secrets.getSecret(connection.secretRef!)).toEqual({
      kind: "mcp",
      apiKey: "lin_secret",
      metadata: { tokenType: "Bearer" },
    });
    await expect(
      service.resolveCredential({
        connectionId: connection.id,
        scopes: ["tools:call"],
        subject: { type: "agent", id: "support" },
      }),
    ).resolves.toMatchObject({
      kind: "mcp",
      accessToken: "lin_secret",
      tokenType: "Bearer",
      providerId: "mcp_url",
    });
    await expect(service.getToken({ connectionId: connection.id, scopes: ["tools:call"] })).resolves.toMatchObject({
      accessToken: "lin_secret",
      tokenType: "Bearer",
    });
  });

  it("creates no-auth MCP connections without storing a fake token", async () => {
    const { service } = createHarness();
    const connection = await service.createMcpConnection({
      name: "Public MCP",
      url: "https://mcp.public.example/mcp",
      auth: "none",
      scopes: ["tools:read"],
    });

    expect(connection.secretRef).toBeUndefined();
    await expect(service.resolveCredential({ connectionId: connection.id, scopes: ["tools:read"] })).resolves.toMatchObject({
      kind: "none",
      providerId: "mcp_url",
      scopes: ["tools:read"],
    });
    await expect(service.getToken({ connectionId: connection.id, scopes: ["tools:read"] })).rejects.toMatchObject({
      code: "token_not_available",
    });
  });

  it("validates MCP inputs and provider type", async () => {
    const { service } = createHarness();
    await expect(
      service.createMcpConnection({
        url: "https://mcp.example/mcp",
        auth: "bearer",
        bearerToken: " ",
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      service.createMcpConnection({
        providerId: "custom_api",
        url: "https://mcp.example/mcp",
        auth: "none",
      }),
    ).rejects.toMatchObject({ code: "unsupported_auth" });
    await expect(
      service.createMcpConnection({
        url: "http://mcp.example/mcp",
        auth: "none",
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("builds OAuth authorization URLs with state, PKCE, normalized scopes, and extra params", async () => {
    const { service } = createHarness();
    const started = await service.startOAuth({
      providerId: "test_oauth",
      scopes: ["write", "read", "write"],
      redirectUri: "https://app.example/callback",
      subject: { type: "user", id: "usr_1" },
    });

    const url = new URL(started.authorizationUrl);
    expect(url.origin + url.pathname).toBe("https://auth.example/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client_id");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.example/callback");
    expect(url.searchParams.get("state")).toBe(started.state);
    expect(url.searchParams.get("scope")).toBe("read write");
    expect(url.searchParams.get("audience")).toBe("polpo");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("fails OAuth start when provider credentials are incomplete", async () => {
    const { service } = createHarness({
      providers: [{ ...oauthProvider, auth: { ...oauthProvider.auth, clientId: undefined } }],
    });

    await expect(service.startOAuth({ providerId: "test_oauth", redirectUri: "https://app.example/callback" })).rejects.toMatchObject({
      code: "invalid_provider",
    });
  });

  it("resolves OAuth client ownership independently from the Connector manifest", async () => {
    const protocolOnlyProvider: ConnectorProviderDefinition = {
      ...oauthProvider,
      auth: {
        ...oauthProvider.auth,
        clientId: undefined,
        clientSecret: undefined,
      },
    };
    const oauthClient = {
      id: "oauth-client-managed",
      providerId: "test_oauth",
      clientId: "managed-client-id",
      clientSecret: "managed-client-secret",
      redirectUris: ["https://app.example/callback"],
      owner: { type: "platform" as const, id: "polpo" },
    };
    const oauthClients = {
      resolve: vi.fn(async () => oauthClient),
      resolveById: vi.fn(async (id: string) => id === oauthClient.id ? oauthClient : null),
    };
    const fetchImpl = queueFetch([jsonResponse(200, {
      access_token: "access-1",
      refresh_token: "refresh-1",
      scope: "read",
    })]);
    const { service } = createHarness({
      providers: [protocolOnlyProvider, apiKeyProvider, mcpProvider],
      oauthClients,
      fetchImpl,
    });

    const started = await service.startOAuth({
      providerId: "test_oauth",
      redirectUri: "https://app.example/callback",
      projectId: "project-1",
      oauthClientMode: "managed",
    });
    const connection = await service.completeOAuth({ state: started.state, code: "code-1" });

    expect(connection.oauthClientId).toBe(oauthClient.id);
    expect(oauthClients.resolve).toHaveBeenCalledWith({
      providerId: "test_oauth",
      projectId: "project-1",
      mode: "managed",
    });
    expect(oauthClients.resolveById).toHaveBeenCalledWith(oauthClient.id);
    expect(fetchImpl.calls[0]!.bodyString).toContain("client_id=managed-client-id");
    expect(fetchImpl.calls[0]!.bodyString).toContain("client_secret=managed-client-secret");

    await expect(service.startOAuth({
      providerId: "test_oauth",
      redirectUri: "https://attacker.example/callback",
      oauthClientMode: "managed",
    })).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("uses immutable single-use setup sessions and creates an explicit project link", async () => {
    const protocolOnlyProvider: ConnectorProviderDefinition = {
      ...oauthProvider,
      auth: { ...oauthProvider.auth, clientId: undefined, clientSecret: undefined },
    };
    const oauthClient = {
      id: "oauth-client-managed",
      providerId: "test_oauth",
      clientId: "managed-client-id",
      clientSecret: "managed-client-secret",
      redirectUris: ["https://polpo.example/v1/connect/oauth/callback"],
      owner: { type: "platform" as const, id: "polpo" },
    };
    const oauthClients = {
      resolve: vi.fn(async () => oauthClient),
      resolveById: vi.fn(async () => oauthClient),
    };
    const fetchImpl = queueFetch([jsonResponse(200, {
      access_token: "access-1",
      refresh_token: "refresh-1",
      scope: "read",
    })]);
    const { service, store } = createHarness({
      providers: [protocolOnlyProvider, apiKeyProvider, mcpProvider],
      oauthClients,
      fetchImpl,
      allowedReturnUrlOrigins: ["https://app.example"],
    });
    const setup = await service.createSetupSession({
      providerId: "test_oauth",
      projectId: "project-1",
      audience: "end_user",
      subject: { type: "external_user", namespace: "acme", id: "user-1" },
      binding: {
        principal: { type: "external_user", id: "user-1" },
        tenant: { namespace: "acme", id: "tenant-1" },
        resource: { namespace: "acme", type: "site", id: "site-1" },
        scopeEpoch: "4",
      },
      scopes: ["read"],
      returnUrl: "https://app.example/settings/integrations",
      oauthClientMode: "managed",
    });

    const started = await service.startOAuthSetup({ setupSessionId: setup.id });
    await expect(service.startOAuthSetup({ setupSessionId: setup.id }))
      .rejects.toMatchObject({ code: "setup_consumed", status: 409 });
    const connection = await service.completeOAuth({ state: started.state, code: "code-1" });

    expect(connection).toMatchObject({
      audience: "end_user",
      owner: { type: "external_user", namespace: "acme", id: "user-1" },
      oauthClientId: oauthClient.id,
      binding: expect.objectContaining({ scopeEpoch: "4" }),
    });
    expect(connection.projectId).toBeUndefined();
    await expect(store.listConnectionLinks({ connectionId: connection.id }))
      .resolves.toEqual([expect.objectContaining({
        connectionId: connection.id,
        projectId: "project-1",
        status: "active",
      })]);
  });

  it("links and unlinks one shared Connection idempotently", async () => {
    const { service } = createHarness();
    const connection = await service.createApiKeyConnection({
      providerId: "custom_api",
      apiKey: "secret",
      scopes: ["use"],
    });

    const first = await service.linkConnection({ connectionId: connection.id, projectId: "project-1" });
    const second = await service.linkConnection({ connectionId: connection.id, projectId: "project-1" });
    expect(second.id).toBe(first.id);
    await expect(service.listConnectionLinks({ projectId: "project-1", status: "active" }))
      .resolves.toEqual([expect.objectContaining({ id: first.id, connectionId: connection.id })]);

    const revoked = await service.unlinkConnection({ linkId: first.id });
    expect(revoked.status).toBe("revoked");
    await expect(service.unlinkConnection({ linkId: first.id })).resolves.toEqual(revoked);
  });

  it("rejects setup return URL attacks, expiry, and concurrent replay", async () => {
    let clock = new Date(Date.UTC(2026, 0, 1, 10, 0, 0));
    const oauthClient = {
      id: "oauth-client-managed",
      providerId: "test_oauth",
      clientId: "managed-client-id",
      clientSecret: "managed-client-secret",
      redirectUris: ["https://polpo.example/v1/connect/oauth/callback"],
      owner: { type: "platform" as const, id: "polpo" },
    };
    const { service } = createHarness({
      oauthClients: {
        resolve: vi.fn(async () => oauthClient),
        resolveById: vi.fn(async () => oauthClient),
      },
      now: () => clock,
      allowedReturnUrlOrigins: ["https://app.example"],
    });
    const base = {
      providerId: "test_oauth",
      projectId: "project-1",
      audience: "end_user" as const,
      subject: { type: "external_user" as const, namespace: "app", id: "user-1" },
      scopes: ["read"],
      oauthClientMode: "managed" as const,
    };

    await expect(service.createSetupSession({
      ...base,
      returnUrl: "https://attacker.example/callback",
    })).rejects.toMatchObject({ code: "setup_invalid" });

    const expired = await service.createSetupSession({
      ...base,
      returnUrl: "https://app.example/settings",
    });
    clock = new Date(clock.getTime() + 11 * 60_000);
    await expect(service.startOAuthSetup({ setupSessionId: expired.id }))
      .rejects.toMatchObject({ code: "setup_expired", status: 410 });

    clock = new Date(Date.UTC(2026, 0, 1, 11, 0, 0));
    const singleUse = await service.createSetupSession({
      ...base,
      returnUrl: "https://app.example/settings",
    });
    const results = await Promise.allSettled([
      service.startOAuthSetup({ setupSessionId: singleUse.id }),
      service.startOAuthSetup({ setupSessionId: singleUse.id }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: "setup_consumed" }) }),
    ]);
  });

  it("exchanges OAuth code, stores tokens, and rejects reused state", async () => {
    const fetchImpl = queueFetch([
      jsonResponse(200, {
        access_token: "access_1",
        refresh_token: "refresh_1",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "read write",
      }),
    ]);
    const { service } = createHarness({ fetchImpl });
    const started = await service.startOAuth({
      providerId: "test_oauth",
      scopes: ["read", "write"],
      redirectUri: "https://app.example/callback",
      connectionName: "Main account",
    });
    const connection = await service.completeOAuth({ state: started.state, code: "code_123" });

    expect(connection).toMatchObject({
      providerId: "test_oauth",
      name: "Main account",
      status: "active",
      grantedScopes: ["read", "write"],
    });
    await expect(service.getToken({ connectionId: connection.id, scopes: ["read"] })).resolves.toMatchObject({
      accessToken: "access_1",
      tokenType: "Bearer",
    });
    await expect(service.completeOAuth({ state: started.state, code: "code_123" })).rejects.toMatchObject({
      code: "oauth_state_not_found",
    });

    const body = String(fetchImpl.calls[0]!.init.body);
    expect(body).toContain("grant_type=authorization_code");
    expect(body).toContain("client_secret=client_secret");
    expect(body).toContain("code_verifier=");
  });

  it("consumes OAuth state even when provider returns an OAuth error", async () => {
    const { service } = createHarness();
    const started = await service.startOAuth({ providerId: "test_oauth", redirectUri: "https://app.example/callback" });

    await expect(service.completeOAuth({ state: started.state, error: "access_denied", errorDescription: "Denied" })).rejects.toMatchObject({
      code: "oauth_error",
    });
    await expect(service.completeOAuth({ state: started.state, code: "code_123" })).rejects.toMatchObject({
      code: "oauth_state_not_found",
    });
  });

  it("rejects expired OAuth state before exchanging code", async () => {
    let nowMs = Date.UTC(2026, 0, 1, 10, 0, 0);
    const fetchImpl = queueFetch([jsonResponse(200, { access_token: "should_not_be_called" })]);
    const { service } = createHarness({ now: () => new Date(nowMs), fetchImpl, oauthStateTtlMs: 1_000 });
    const started = await service.startOAuth({ providerId: "test_oauth", redirectUri: "https://app.example/callback" });
    nowMs += 1_001;

    await expect(service.completeOAuth({ state: started.state, code: "code_123" })).rejects.toMatchObject({
      code: "oauth_state_expired",
    });
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it("rejects broken token endpoint responses", async () => {
    for (const response of [
      jsonResponse(500, { error: "temporarily_unavailable" }),
      textResponse(200, "{not json"),
      jsonResponse(200, { refresh_token: "refresh_without_access" }),
    ]) {
      const { service } = createHarness({ fetchImpl: queueFetch([response]) });
      const started = await service.startOAuth({ providerId: "test_oauth", redirectUri: "https://app.example/callback" });
      await expect(service.completeOAuth({ state: started.state, code: "code_123" })).rejects.toBeInstanceOf(ConnectError);
    }
  });

  it("keeps extra provider token scopes outside the Connection permission ceiling", async () => {
    const { service, secrets } = createHarness({
      fetchImpl: queueFetch([jsonResponse(200, { access_token: "access_1", scope: "read admin" })]),
    });
    const started = await service.startOAuth({ providerId: "test_oauth", scopes: ["read"], redirectUri: "https://app.example/callback" });

    const connection = await service.completeOAuth({ state: started.state, code: "code_123" });
    expect(connection.grantedScopes).toEqual(["read"]);
    expect(await secrets.getSecret(connection.secretRef!)).toMatchObject({ tokens: { scopes: ["admin", "read"] } });
    await expect(service.getToken({ connectionId: connection.id, scopes: ["admin"] })).rejects.toMatchObject({ code: "invalid_scope" });
    await expect(service.getToken({ connectionId: connection.id, scopes: ["read"] })).resolves.toMatchObject({ scopes: ["read"] });
  });

  it("refreshes expired OAuth tokens, preserves refresh token rotation fallback, and updates stored token", async () => {
    let nowMs = Date.UTC(2026, 0, 1, 10, 0, 0);
    const fetchImpl = queueFetch([
      jsonResponse(200, {
        access_token: "expired_access",
        refresh_token: "refresh_1",
        expires_in: 1,
        scope: "read",
      }),
      jsonResponse(200, {
        access_token: "fresh_access",
        expires_in: 3600,
        scope: "read",
      }),
    ]);
    const { service, secrets } = createHarness({ now: () => new Date(nowMs), fetchImpl, tokenRefreshSkewMs: 0 });
    const started = await service.startOAuth({ providerId: "test_oauth", scopes: ["read"], redirectUri: "https://app.example/callback" });
    const connection = await service.completeOAuth({ state: started.state, code: "code_123" });

    nowMs += 2_000;
    await expect(service.getToken({ connectionId: connection.id, scopes: ["read"] })).resolves.toMatchObject({
      accessToken: "fresh_access",
    });
    const secret = await secrets.getSecret(connection.secretRef!);
    expect(secret?.tokens?.refreshToken).toBe("refresh_1");
    expect(fetchImpl.calls[1]!.bodyString).toContain("grant_type=refresh_token");
  });

  it("single-flights refresh across runtime replicas and preserves rotated refresh tokens", async () => {
    let nowMs = Date.UTC(2026, 0, 1, 10, 0, 0);
    const fetchImpl = queueFetch([
      jsonResponse(200, {
        access_token: "expired_access",
        refresh_token: "refresh_1",
        expires_in: 1,
        scope: "read",
      }),
      jsonResponse(200, {
        access_token: "fresh_access",
        refresh_token: "refresh_2",
        expires_in: 3600,
        scope: "read",
      }),
    ]);
    const store = new MemoryConnectStore();
    const secrets = new MemoryConnectionSecretStore();
    const refreshCoordinator = new MemoryTokenRefreshCoordinator();
    const options = {
      providers: [oauthProvider, apiKeyProvider, mcpProvider],
      store,
      secrets,
      fetch: fetchImpl,
      now: () => new Date(nowMs),
      tokenRefreshSkewMs: 0,
      refreshCoordinator,
      resolveHostname: async () => ["93.184.216.34"],
    };
    const replicaA = createConnectService(options);
    const replicaB = createConnectService(options);
    const started = await replicaA.startOAuth({
      providerId: "test_oauth",
      scopes: ["read"],
      redirectUri: "https://app.example/callback",
    });
    const connection = await replicaA.completeOAuth({ state: started.state, code: "code_123" });
    nowMs += 2_000;

    const tokens = await Promise.all(Array.from({ length: 12 }, (_, index) =>
      (index % 2 === 0 ? replicaA : replicaB).getToken({
        connectionId: connection.id,
        scopes: ["read"],
      })));

    expect(tokens.map((token) => token.accessToken)).toEqual(
      Array.from({ length: 12 }, () => "fresh_access"),
    );
    expect(fetchImpl.calls).toHaveLength(2);
    expect((await secrets.getSecret(connection.secretRef!))?.tokens).toMatchObject({
      accessToken: "fresh_access",
      refreshToken: "refresh_2",
    });
  });

  it("provides versioned secret compare-and-set semantics", async () => {
    const secrets = new MemoryConnectionSecretStore();
    await secrets.setSecret("secret-1", { kind: "api_key", apiKey: "one" });
    const first = await secrets.getVersioned("secret-1");
    expect(first).toMatchObject({ version: "1", secret: { apiKey: "one" } });

    await expect(secrets.compareAndSet(
      "secret-1",
      first!.version,
      { kind: "api_key", apiKey: "two" },
    )).resolves.toBe(true);
    await expect(secrets.compareAndSet(
      "secret-1",
      first!.version,
      { kind: "api_key", apiKey: "stale" },
    )).resolves.toBe(false);
    await expect(secrets.getSecret("secret-1")).resolves.toMatchObject({ apiKey: "two" });
  });

  it("executes opaque provider requests with server-injected auth and sanitized responses", async () => {
    const fetchImpl = queueFetch([new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-request-id": "provider-request-1",
        "set-cookie": "secret-cookie=1",
        authorization: "should-not-return",
      },
    })]);
    const { service } = createHarness({ fetchImpl });
    const connection = await service.createApiKeyConnection({
      providerId: "custom_api",
      apiKey: "secret-api-key",
      scopes: ["use"],
    });

    const response = await service.request({
      connectionId: connection.id,
      scopes: ["use"],
      request: {
        method: "POST",
        path: "/v1/items",
        headers: { Accept: "application/json" },
        body: { name: "Item" },
        idempotencyKey: "request-1",
      },
    });

    expect(response).toEqual({
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-request-id": "provider-request-1",
      },
      body: { ok: true },
      requestId: "provider-request-1",
    });
    const call = fetchImpl.calls[0]!;
    expect(call.url).toBe("https://api.example.com/v1/items");
    expect(new Headers(call.init.headers)).toMatchObject(expect.any(Headers));
    expect(new Headers(call.init.headers).get("x-api-key")).toBe("secret-api-key");
    expect(new Headers(call.init.headers).get("idempotency-key")).toBe("request-1");
    expect(new Headers(call.init.headers).get("content-type")).toBe("application/json");
    expect(call.bodyString).toBe(JSON.stringify({ name: "Item" }));
  });

  it("fails closed on DNS rebinding, redirects, and oversized provider responses", async () => {
    const privateFetch = queueFetch([jsonResponse(200, { should: "not run" })]);
    const privateHarness = createHarness({
      fetchImpl: privateFetch,
      resolveHostname: async () => ["10.0.0.1"],
    });
    const privateConnection = await privateHarness.service.createApiKeyConnection({
      providerId: "custom_api",
      apiKey: "secret",
    });
    await expect(privateHarness.service.request({
      connectionId: privateConnection.id,
      request: { method: "GET", path: "/v1/items" },
    })).rejects.toMatchObject({ code: "http_error", status: 502 });
    expect(privateFetch.calls).toHaveLength(0);

    const redirectHarness = createHarness({
      fetchImpl: queueFetch([new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/steal" },
      })]),
    });
    const redirectConnection = await redirectHarness.service.createApiKeyConnection({
      providerId: "custom_api",
      apiKey: "secret",
    });
    await expect(redirectHarness.service.request({
      connectionId: redirectConnection.id,
      request: { method: "GET", path: "/v1/items" },
    })).rejects.toMatchObject({ code: "http_error" });

    const largeHarness = createHarness({
      fetchImpl: queueFetch([textResponse(200, "x".repeat(1_025))]),
    });
    const largeConnection = await largeHarness.service.createApiKeyConnection({
      providerId: "custom_api",
      apiKey: "secret",
    });
    await expect(largeHarness.service.request({
      connectionId: largeConnection.id,
      request: { method: "GET", path: "/v1/items" },
    })).rejects.toMatchObject({ code: "http_error" });
  });

  it("fails expired OAuth tokens that cannot be refreshed", async () => {
    let nowMs = Date.UTC(2026, 0, 1, 10, 0, 0);
    const { service } = createHarness({
      now: () => new Date(nowMs),
      fetchImpl: queueFetch([jsonResponse(200, { access_token: "expired_access", expires_in: 1, scope: "read" })]),
      tokenRefreshSkewMs: 0,
    });
    const started = await service.startOAuth({ providerId: "test_oauth", scopes: ["read"], redirectUri: "https://app.example/callback" });
    const connection = await service.completeOAuth({ state: started.state, code: "code_123" });

    nowMs += 2_000;
    await expect(service.getToken({ connectionId: connection.id, scopes: ["read"] })).rejects.toMatchObject({
      code: "token_not_available",
    });
  });

  it("enforces requested scopes and optional runtime policy before returning tokens", async () => {
    const { service } = createHarness({
      policy: {
        canUseConnection: ({ subject }) => subject?.id === "allowed_agent",
      },
    });
    const connection = await service.createApiKeyConnection({ providerId: "custom_api", apiKey: "sk", scopes: ["use"] });

    await expect(service.getToken({ connectionId: connection.id, scopes: ["admin"] })).rejects.toMatchObject({
      code: "invalid_scope",
    });
    await expect(
      service.getToken({ connectionId: connection.id, scopes: ["use"], subject: { type: "agent", id: "blocked_agent" } }),
    ).rejects.toMatchObject({ code: "policy_denied" });
    await expect(
      service.getToken({ connectionId: connection.id, scopes: ["use"], subject: { type: "agent", id: "allowed_agent" } }),
    ).resolves.toMatchObject({ accessToken: "sk" });
  });

  it("revokes connections and deletes stored secrets", async () => {
    const { service, secrets } = createHarness();
    const connection = await service.createApiKeyConnection({ providerId: "custom_api", apiKey: "sk", scopes: ["use"] });
    const secretRef = connection.secretRef!;

    const revoked = await service.revokeConnection({ connectionId: connection.id });
    expect(revoked.status).toBe("revoked");
    expect(revoked.secretRef).toBeUndefined();
    expect(await secrets.getSecret(secretRef)).toBeNull();
    await expect(service.getToken({ connectionId: connection.id })).rejects.toMatchObject({ code: "connection_revoked" });
  });
});

function createHarness(input: {
  providers?: ConnectorProviderDefinition[];
  fetchImpl?: MockFetch;
  now?: () => Date;
  tokenRefreshSkewMs?: number;
  oauthStateTtlMs?: number;
  policy?: Parameters<typeof createConnectService>[0]["policy"];
  resolveHostname?: Parameters<typeof createConnectService>[0]["resolveHostname"];
  oauthClients?: Parameters<typeof createConnectService>[0]["oauthClients"];
  allowedReturnUrlOrigins?: Parameters<typeof createConnectService>[0]["allowedReturnUrlOrigins"];
} = {}) {
  const store = new MemoryConnectStore();
  const secrets = new MemoryConnectionSecretStore();
  const service = createConnectService({
    providers: input.providers ?? [oauthProvider, apiKeyProvider, mcpProvider],
    store,
    secrets,
    fetch: input.fetchImpl ?? queueFetch([]),
    now: input.now ?? (() => new Date(Date.UTC(2026, 0, 1, 10, 0, 0))),
    tokenRefreshSkewMs: input.tokenRefreshSkewMs,
    oauthStateTtlMs: input.oauthStateTtlMs,
    policy: input.policy,
    resolveHostname: input.resolveHostname ?? (async () => ["93.184.216.34"]),
    oauthClients: input.oauthClients,
    setupSessions: store,
    links: store,
    allowedReturnUrlOrigins: input.allowedReturnUrlOrigins,
  });
  return { service, store, secrets };
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

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(status: number, text: string): Response {
  return new Response(text, { status });
}
