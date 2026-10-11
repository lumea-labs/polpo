import { describe, expect, it, vi } from "vitest";
import { ConnectError, normalizeConnectorDefinition, type ConnectorDefinition } from "@polpo-ai/connect";
import { createConnectService, MemoryConnectStore, MemoryConnectionSecretStore } from "../index.js";

function harness(input: { public?: boolean; probe?: boolean; response?: Response; beforeDispatch?: Parameters<typeof createConnectService>[0]["beforeDispatch"] } = {}) {
  const definition = {
    version: 2, id: "example", name: "Example", source: "custom", protocol: "http_api", defaultAuthenticationId: "default",
    authentication: input.public ? [{ id: "default", type: "none" }] : [{ id: "default", type: "api_key", injection: { mode: "bearer" } }],
    scopes: [{ id: "read" }],
    http: { origins: ["https://api.example.com"], allowedMethods: ["GET"], allowedPathPatterns: ["/me"] },
    ...(input.probe === false ? {} : { verification: { kind: "http", path: "/me", scopes: ["read"],
      ...(input.public ? {} : { account: { idPath: ["id"], labelPath: ["name"] } }) } }),
  } as ConnectorDefinition;
  const store = new MemoryConnectStore(), secrets = new MemoryConnectionSecretStore();
  const fetch = vi.fn<typeof globalThis.fetch>(async () => input.response ?? Response.json({ id: "account-1", name: "Example account" }));
  const service = createConnectService({ providers: [definition], store, secrets, fetch, beforeDispatch: input.beforeDispatch, resolveHostname: async () => ["8.8.8.8"] });
  return { store, secrets, fetch, service, definition };
}

describe("Connection verification", () => {
  it("applies the host quota to API verification without sending or revoking on rejection", async () => {
    const beforeDispatch = vi.fn(async () => { throw new ConnectError("rate_limited", "Connection request limit exceeded"); });
    const { service, fetch } = harness({ beforeDispatch });
    const connection = await service.createApiKeyConnection({ providerId: "example", apiKey: "private", scopes: ["read"] });
    expect(await service.verifyConnection({ connectionId: connection.id })).toMatchObject({ outcome: "inconclusive", code: "rate_limited" });
    expect(beforeDispatch).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["limit", "revoke"])("passes a quota and revocation guard to the MCP verification adapter (%s)", async failure => {
    const store = new MemoryConnectStore(), secrets = new MemoryConnectionSecretStore();
    const send = vi.fn();
    const service = createConnectService({ store, secrets, providers: [{
      version: 2, id: "custom_mcp", name: "MCP", source: "custom", protocol: "mcp", defaultAuthenticationId: "public",
      authentication: [{ id: "public", type: "none" }], verification: { kind: "mcp_discovery" },
    }], beforeDispatch: async connection => {
      if (failure === "limit") throw new ConnectError("rate_limited", "Connection request limit exceeded");
      await store.updateConnection(connection.id, { status: "revoked" });
    }, verifyMcp: async input => { await input.beforeDispatch?.(); send(); return { toolCount: 1 }; } });
    const connection = await service.createMcpConnection({ providerId: "custom_mcp", url: "https://mcp.example/mcp", auth: "none" });
    const checked = await service.verifyConnection({ connectionId: connection.id });
    expect(checked.outcome).not.toBe("passed");
    expect(checked.code).toBe(failure === "limit" ? "rate_limited" : "connection_changed");
    expect(send).not.toHaveBeenCalled();
  });
  it.each([
    { kind: "http", path: "/me", method: "POST" },
    { kind: "http", path: "https://attacker.example/steal" },
    { kind: "http", path: "/outside-policy" },
    { kind: "http", path: "/me", scopes: ["admin"] },
    { kind: "http", path: "/me", account: { idPath: ["constructor", "name"] } },
  ])("rejects a probe outside its declared read policy", (verification) => {
    const { definition } = harness();
    expect(() => normalizeConnectorDefinition({ ...definition, verification })).toThrow();
  });

  it("performs MCP discovery through the host adapter after credential and scope checks", async () => {
    const store = new MemoryConnectStore(), secrets = new MemoryConnectionSecretStore();
    const verifyMcp = vi.fn(async () => ({ toolCount: 3 }));
    const service = createConnectService({ store, secrets, verifyMcp, providers: [{
      version: 2, id: "custom_mcp", name: "MCP", source: "custom", protocol: "mcp", defaultAuthenticationId: "key",
      authentication: [{ id: "key", type: "api_key", injection: { mode: "bearer" }, defaultScopes: ["tools:read"] }],
      scopes: [{ id: "tools:read" }], verification: { kind: "mcp_discovery", scopes: ["tools:read"] },
    }] });
    const connection = await service.createMcpConnection({ providerId: "custom_mcp", url: "https://mcp.example.com/mcp", apiKey: "private-mcp-key" });
    const checked = await service.verifyConnection({ connectionId: connection.id });
    expect(checked).toMatchObject({ check: "mcp_discovery", outcome: "passed", toolCount: 3 });
    expect(JSON.stringify(checked)).not.toContain("private-mcp-key");
    expect(verifyMcp).toHaveBeenCalledOnce();
  });

  it("verifies an authenticated account using the execution gateway, without returning its secret", async () => {
    const { service, fetch, store } = harness();
    const connection = await service.createApiKeyConnection({ providerId: "example", apiKey: "private-account-key", scopes: ["read"] });
    const checked = await service.verifyConnection({ connectionId: connection.id });
    expect(checked).toMatchObject({ connectionId: connection.id, providerId: "example", outcome: "passed", check: "authenticated_operation", account: { id: "account-1", label: "Example account" } });
    expect(checked.checkedAt).toBeTruthy();
    expect(checked.credentialVersion).toBeTruthy();
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get("authorization")).toBe("Bearer private-account-key");
    expect(JSON.stringify(checked)).not.toContain("private-account-key");
    expect(await store.getConnection(connection.id)).toMatchObject({ providerAccountId: "account-1" });
  });

  it("reports a public endpoint as an operation check, not credential verification", async () => {
    const { service, fetch } = harness({ public: true });
    const connection = await service.createPublicConnection({ providerId: "example", scopes: ["read"] });
    expect(await service.verifyConnection({ connectionId: connection.id })).toMatchObject({ outcome: "passed", check: "operation" });
    expect(new Headers(fetch.mock.calls[0][1]?.headers).has("authorization")).toBe(false);
  });

  it("honestly reports unsupported verification without provider access", async () => {
    const { service, fetch } = harness({ probe: false });
    const connection = await service.createApiKeyConnection({ providerId: "example", apiKey: "private-account-key" });
    expect(await service.verifyConnection({ connectionId: connection.id })).toMatchObject({ outcome: "unsupported", code: "probe_not_configured" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([[401, "failed", "invalid_credentials"], [403, "failed", "access_denied"], [429, "inconclusive", "rate_limited"], [503, "inconclusive", "provider_unavailable"]])("sanitizes provider %s without revoking the Connection", async (status, outcome, code) => {
    const { service, store } = harness({ response: Response.json({ token: "private-provider-value" }, { status: status as number }) });
    const connection = await service.createApiKeyConnection({ providerId: "example", apiKey: "private-account-key", scopes: ["read"] });
    const checked = await service.verifyConnection({ connectionId: connection.id });
    expect(checked).toMatchObject({ outcome, code });
    expect(JSON.stringify(checked)).not.toContain("private-provider-value");
    expect((await store.getConnection(connection.id))?.status).toBe("active");
  });

  it("does not accept a 200 response without the account identity required by the probe", async () => {
    const { service } = harness({ response: Response.json({ status: "public-health-ok" }) });
    const connection = await service.createApiKeyConnection({ providerId: "example", apiKey: "private-account-key", scopes: ["read"] });
    expect(await service.verifyConnection({ connectionId: connection.id })).toMatchObject({ outcome: "inconclusive", code: "invalid_response" });
  });

  it("respects scope and revocation checks before executing a probe", async () => {
    const { service, fetch } = harness();
    const connection = await service.createApiKeyConnection({ providerId: "example", apiKey: "private-account-key", scopes: [] });
    expect(await service.verifyConnection({ connectionId: connection.id })).toMatchObject({ outcome: "failed", code: "invalid_scope" });
    await service.revokeConnection({ connectionId: connection.id });
    expect(await service.verifyConnection({ connectionId: connection.id })).toMatchObject({ outcome: "failed", code: "connection_revoked" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
