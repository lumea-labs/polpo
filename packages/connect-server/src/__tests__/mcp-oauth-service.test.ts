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

import type { ConnectorProviderDefinition } from "@polpo-ai/connect";
import {
  MemoryConnectStore,
  MemoryConnectionSecretStore,
  createConnectService,
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
});

function harness(now: () => Date = () => new Date("2026-08-31T12:00:00.000Z")) {
  const store = new MemoryConnectStore();
  const secrets = new MemoryConnectionSecretStore();
  const service = createConnectService({
    providers: [provider],
    store,
    secrets,
    fetch: vi.fn(async () => new Response(null, { status: 204 })) as any,
    resolveHostname: async () => ["93.184.216.34"],
    now,
  });
  return { service, store, secrets };
}
