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

import { createMcpOAuthProtocol } from "../mcp-oauth.js";

const discovery = {
  authorizationServerUrl: "https://auth.example/",
  authorizationServerMetadata: {
    authorization_endpoint: "https://auth.example/authorize",
    token_endpoint: "https://auth.example/token",
    registration_endpoint: "https://auth.example/register",
    revocation_endpoint: "https://auth.example/revoke",
    scopes_supported: ["read", "write"],
    code_challenge_methods_supported: ["S256"],
  },
  resourceMetadata: {
    resource: "https://mcp.example/mcp",
    authorization_servers: ["https://auth.example/"],
  },
};

describe("MCP OAuth protocol", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    discoverMock.mockResolvedValue(discovery);
    registerMock.mockResolvedValue({ client_id: "dcr-client" });
    startMock.mockResolvedValue({
      authorizationUrl: new URL("https://auth.example/authorize?state=state-1"),
      codeVerifier: "pkce-verifier",
    });
    exchangeMock.mockResolvedValue({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600, scope: "read write" });
    refreshMock.mockResolvedValue({ access_token: "access-2", expires_in: 3600, scope: "read write" });
  });

  it("discovers RFC metadata without inferring no-auth from endpoint reachability", async () => {
    const protocol = createMcpOAuthProtocol({ fetch });
    await expect(protocol.inspect({ url: "https://mcp.example/mcp" })).resolves.toMatchObject({
      auth: "oauth2",
      clientModes: ["dynamic", "metadata_document", "pre_registered"],
      discovery: { resource: "https://mcp.example/mcp", tokenEndpoint: "https://auth.example/token" },
    });
    discoverMock.mockRejectedValueOnce(new Error("no metadata"));
    await expect(protocol.inspect({ url: "https://public.example/mcp" })).resolves.toMatchObject({
      auth: "unknown",
      warnings: [expect.stringContaining("inconclusive")],
    });
  });

  it("registers a DCR client once and reuses it for subsequent authorizations", async () => {
    const cache = new Map<string, any>();
    const registrations = {
      get: vi.fn(async ({ resource }: any) => cache.get(resource) ?? null),
      set: vi.fn(async ({ resource, client }: any) => { cache.set(resource, client); }),
    };
    const protocol = createMcpOAuthProtocol({ fetch, registrations });
    const input = {
      url: "https://mcp.example/mcp",
      redirectUri: "https://polpo.example/v1/connect/oauth/callback",
      state: "state-1",
      scopes: ["write", "read"],
      mode: "dynamic" as const,
    };
    const first = await protocol.start(input);
    const second = await protocol.start({ ...input, state: "state-2" });
    expect(first.material).toMatchObject({ client: { client_id: "dcr-client" }, codeVerifier: "pkce-verifier" });
    expect(second.material.client).toEqual(first.material.client);
    expect(registerMock).toHaveBeenCalledTimes(1);
    expect(startMock).toHaveBeenCalledTimes(2);
  });

  it("supports metadata-document and pre-registered clients without DCR", async () => {
    const protocol = createMcpOAuthProtocol({ fetch });
    const common = { url: "https://mcp.example/mcp", redirectUri: "https://polpo.example/v1/connect/oauth/callback", state: "state-1" };
    await expect(protocol.start({ ...common, mode: "metadata_document", clientMetadataUrl: "https://polpo.example/oauth/client.json" })).resolves.toMatchObject({
      material: { client: { client_id: "https://polpo.example/oauth/client.json" } },
    });
    await expect(protocol.start({ ...common, mode: "pre_registered", preRegisteredClient: { client_id: "github-client", client_secret: "secret" } })).resolves.toMatchObject({
      material: { client: { client_id: "github-client" } },
    });
    expect(registerMock).not.toHaveBeenCalled();
  });

  it("exchanges and refreshes tokens while preserving refresh state", async () => {
    const protocol = createMcpOAuthProtocol({ fetch, now: () => new Date("2026-08-31T12:00:00.000Z") });
    const started = await protocol.start({
      url: "https://mcp.example/mcp",
      redirectUri: "https://polpo.example/v1/connect/oauth/callback",
      state: "state-1",
      scopes: ["read", "write"],
      mode: "pre_registered",
      preRegisteredClient: { client_id: "client-1" },
    });
    const tokens = await protocol.complete({ material: started.material, code: "code-1", requestedScopes: ["read", "write"] });
    expect(tokens).toMatchObject({ accessToken: "access-1", refreshToken: "refresh-1", expiresAt: "2026-08-31T13:00:00.000Z" });
    const refreshed = await protocol.refresh({ material: { ...started.material, tokens }, fallbackScopes: ["read", "write"] });
    expect(refreshed).toMatchObject({ accessToken: "access-2", refreshToken: "refresh-1" });
  });

  it("fails closed when PKCE S256 is unsupported", async () => {
    discoverMock.mockResolvedValueOnce({
      ...discovery,
      authorizationServerMetadata: { ...discovery.authorizationServerMetadata, code_challenge_methods_supported: ["plain"] },
    });
    const protocol = createMcpOAuthProtocol({ fetch });
    await expect(protocol.inspect({ url: "https://mcp.example/mcp" })).rejects.toMatchObject({ code: "oauth_discovery_failed" });
  });
});
