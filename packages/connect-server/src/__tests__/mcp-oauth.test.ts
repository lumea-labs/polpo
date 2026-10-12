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

  it("leaves authentication undecided when an endpoint has no OAuth metadata", async () => {
    discoverMock.mockResolvedValueOnce({ authorizationServerUrl: "https://public.example/", authorizationServerMetadata: undefined, resourceMetadata: undefined });
    const protocol = createMcpOAuthProtocol({ fetch });
    await expect(protocol.inspect({ url: "https://public.example/mcp" })).resolves.toMatchObject({
      auth: "unknown", warnings: [expect.stringContaining("choose authentication explicitly")],
    });
  });

  it.each(["configuration", "branding", "issuer", "scopes"])("does not reuse a DCR registration after changing %s", async change => {
    const cache = new Map<string, any>();
    const registrations = {
      get: vi.fn(async (input: any) => cache.get(input.registrationKey ?? input.resource) ?? null),
      set: vi.fn(async (input: any) => { cache.set(input.registrationKey ?? input.resource, input.client); }),
    };
    registerMock.mockResolvedValueOnce({ client_id: "first-app", client_secret: "first-secret" })
      .mockResolvedValueOnce({ client_id: "second-app", client_secret: "second-secret" });
    const protocol = createMcpOAuthProtocol({ fetch, registrations });
    const input = { url: "https://mcp.example/mcp", redirectUri: "https://polpo.example/callback", state: "first", mode: "dynamic" as const,
      clientName: "Polpo", registrationNamespace: "managed-config", scopes: ["read"] };
    await protocol.start(input);
    if (change === "issuer") discoverMock.mockResolvedValueOnce({ ...discovery,
      authorizationServerUrl: "https://other.example/", authorizationServerMetadata: { ...discovery.authorizationServerMetadata,
        authorization_endpoint: "https://other.example/authorize", token_endpoint: "https://other.example/token", registration_endpoint: "https://other.example/register" } });
    const second = await protocol.start({ ...input, state: "second",
      ...(change === "configuration" ? { registrationNamespace: "customer-config" } : {}),
      ...(change === "branding" ? { clientName: "Customer app" } : {}),
      ...(change === "scopes" ? { scopes: ["read", "write"] } : {}),
    });
    expect(second.material.client.client_id).toBe("second-app");
    expect(registerMock).toHaveBeenCalledTimes(2);
    expect(registrations.get.mock.calls.every(([input]) => /^[a-f0-9]{64}$/.test(input.registrationKey))).toBe(true);
    expect(JSON.stringify(registrations.get.mock.calls)).not.toContain("first-secret");
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

  it("passes a host-owned loopback callback through registration, PKCE and code exchange", async () => {
    const protocol = createMcpOAuthProtocol({ fetch });
    const redirectUri = "http://localhost:4411/callback";
    const result = await protocol.start({ url: "https://mcp.example/mcp", redirectUri, state: "local-state", mode: "dynamic" });
    expect(registerMock.mock.calls[0][1].clientMetadata.redirect_uris).toEqual([redirectUri]);
    expect(startMock.mock.calls[0][1]).toMatchObject({ redirectUrl: redirectUri, state: "local-state" });
    await protocol.complete({ material: result.material, code: "code", requestedScopes: [] });
    expect(exchangeMock.mock.calls[0][1]).toMatchObject({ redirectUri, codeVerifier: "pkce-verifier" });
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
