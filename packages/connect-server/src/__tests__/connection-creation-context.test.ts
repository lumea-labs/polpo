import { describe, expect, it, vi } from "vitest";
import type { ConnectionOwner, ConnectorProviderDefinition } from "@polpo-ai/connect";
import { createConnectService, MemoryConnectStore, MemoryConnectionSecretStore } from "../index.js";

const providers: ConnectorProviderDefinition[] = [
  { id: "key", name: "Key", auth: { type: "api_key" }, scopes: [] },
  { id: "public", name: "Public", auth: { type: "none" }, scopes: [],
    http: { origins: ["https://api.example"], auth: { mode: "none" } } },
  { id: "mcp_url", name: "MCP", auth: { type: "mcp", auth: "bearer" }, scopes: [] },
];

function harness() {
  const store = new MemoryConnectStore();
  const secrets = new MemoryConnectionSecretStore();
  const service = createConnectService({ providers, store, secrets });
  return { store, secrets, service };
}

describe.each(["api_key", "public", "mcp"] as const)("%s Connection creation context", (kind) => {
  const create = (service: ReturnType<typeof harness>["service"], context: {
    audience?: "shared" | "personal" | "end_user";
    subject?: ConnectionOwner;
    binding?: { principal?: { type: string; id: string; namespace?: string }; scopeEpoch?: string };
  } = {}) => kind === "api_key"
    ? service.createApiKeyConnection({ providerId: "key", apiKey: "private", ...context })
    : kind === "public" ? service.createPublicConnection({ providerId: "public", ...context })
      : service.createMcpConnection({ url: "https://mcp.example/mcp", apiKey: "private", ...context });

  it("persists a namespaced end-user owner and derives its binding", async () => {
    const { service } = harness();
    const subject = { type: "external_user" as const, namespace: "application", id: "user-a" };
    const connection = await create(service, { audience: "end_user", subject, binding: { scopeEpoch: "epoch-1" } });
    expect(connection).toMatchObject({ audience: "end_user", owner: subject,
      binding: { principal: subject, scopeEpoch: "epoch-1" } });
  });

  it("binds personal access, while an explicitly shared account may have the same owner", async () => {
    const { service } = harness();
    const subject = { type: "user" as const, id: "builder" };
    expect(await create(service, { audience: "personal", subject }))
      .toMatchObject({ audience: "personal", owner: subject, binding: { principal: subject } });
    const shared = await create(service, { audience: "shared", subject });
    expect(shared).toMatchObject({ audience: "shared", owner: subject });
    expect(shared.binding).toBeUndefined();
  });

  it("preserves shared default semantics without inferring audience from the credential owner", async () => {
    const { service } = harness();
    const subject = { type: "user" as const, id: "builder" };
    const connection = await create(service, { subject });
    expect(connection).toMatchObject({ audience: "shared", owner: subject });
    expect(connection.binding).toBeUndefined();
  });

  it.each([
    { audience: "personal", subject: { type: "project", id: "project" } },
    { audience: "end_user" },
    { audience: "end_user", subject: { type: "external_user", namespace: "", id: "a" } },
    { audience: "end_user", subject: { type: "external_user", namespace: "app", id: "a" },
      binding: { principal: { type: "external_user", namespace: "other", id: "a" } } },
    { audience: "personal", subject: { type: "user", id: "a" }, binding: { principal: { type: "user", id: "b" } } },
    { audience: "unexpected" },
    { audience: null },
    { audience: "shared", binding: { unexpected: "field" } },
    { audience: "shared", binding: { principal: null } },
    { audience: "shared", binding: { tenant: null } },
    { audience: "shared", binding: { resource: null } },
  ])("rejects invalid or conflicting identity before storing a credential: %j", async (context) => {
    const { service, store, secrets } = harness();
    const secretWrite = vi.spyOn(secrets, "setSecret");
    await expect(create(service, context as Parameters<typeof create>[1])).rejects.toMatchObject({ code: "setup_invalid" });
    expect(secretWrite).not.toHaveBeenCalled();
    expect(await store.listConnections()).toEqual([]);
  });
});

it("does not accept a caller-authored MCP discovery inventory at creation", async () => {
  const { service } = harness();
  const connection = await service.createMcpConnection({ url: "https://mcp.example/mcp", auth: "none",
    metadata: { serverName: "notes", label: "Kept", discoveredTools: [{ name: "forged" }], lastDiscoveredAt: "2099-01-01" } });
  expect(connection.metadata).toMatchObject({ serverName: "notes", label: "Kept" });
  expect(connection.metadata).not.toHaveProperty("discoveredTools");
  expect(connection.metadata).not.toHaveProperty("lastDiscoveredAt");
});

it("creates generic MCP header authentication atomically and rejects transport headers before secret storage", async () => {
  const { service, secrets } = harness();
  const connection = await service.createMcpConnection({ url: "https://mcp.example/mcp", auth: "header", headerName: "X-API-Key", apiKey: "private" });
  expect(connection.metadata).toMatchObject({ auth: "header", headerName: "X-API-Key" });
  expect(await secrets.getSecret(connection.secretRef!)).toMatchObject({ apiKey: "private" });
  const write = vi.spyOn(secrets, "setSecret");
  for (const headerName of ["Host", "Cookie", "proxy-authorization", "sec-fetch-site", "bad\r\nheader", ""]) {
    await expect(service.createMcpConnection({ url: "https://mcp.example/mcp", auth: "header", headerName, apiKey: "private" })).rejects.toThrow();
  }
  expect(write).not.toHaveBeenCalled();
});
