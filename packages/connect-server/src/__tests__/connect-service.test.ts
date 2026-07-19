import { describe, expect, it, vi } from "vitest";
import { ConnectError, type ConnectorProviderDefinition, type TokenSet } from "@polpo-ai/connect";
import { MemoryConnectStore, MemoryConnectionSecretStore, createConnectService } from "../index.js";

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

  it("rejects OAuth tokens that grant scopes outside the curated provider contract", async () => {
    const { service } = createHarness({
      fetchImpl: queueFetch([jsonResponse(200, { access_token: "access_1", scope: "read admin" })]),
    });
    const started = await service.startOAuth({ providerId: "test_oauth", scopes: ["read"], redirectUri: "https://app.example/callback" });

    await expect(service.completeOAuth({ state: started.state, code: "code_123" })).rejects.toMatchObject({
      code: "invalid_scope",
    });
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
