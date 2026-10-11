import { describe, expect, it, vi } from "vitest";
import { MemoryConnectStore, MemoryConnectionSecretStore, MemoryConnectorDefinitionStore, createConnectService } from "../index.js";

const definition = {
  version: 2, id: "custom_crm", name: "CRM", protocol: "http_api", source: "catalog", defaultAuthenticationId: "key",
  authentication: [{ id: "key", type: "api_key", injection: { mode: "header", name: "X-API-Key" } }],
  http: { origins: ["https://crm.example.com"], allowedMethods: ["GET"], allowedPathPatterns: ["/contacts"] },
};

describe("Persisted custom Connector definitions", () => {
  it("registers a non-secret definition and uses it after the service restarts", async () => {
    const definitions = new MemoryConnectorDefinitionStore();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ contacts: [] }));
    const options = { providers: [], definitions, store: new MemoryConnectStore(), secrets: new MemoryConnectionSecretStore(), fetch, resolveHostname: async () => ["8.8.8.8"] };
    const first = createConnectService(options);
    expect(await first.registerConnectorDefinition(definition)).toMatchObject({ definition: { source: "custom" } });
    const connection = await first.createApiKeyConnection({ providerId: "custom_crm", apiKey: "private-key" });
    const restarted = createConnectService(options);
    expect(await restarted.listCatalog()).toMatchObject([{ id: "custom_crm", source: "custom", protocol: "http_api" }]);
    await restarted.request({ connectionId: connection.id, request: { method: "GET", path: "/contacts" } });
    expect(String(fetch.mock.calls[0][0])).toBe("https://crm.example.com/contacts");
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get("x-api-key")).toBe("private-key");
  });

  it("does not allow replacing a registered destination under existing credentials", async () => {
    const service = createConnectService({ providers: [], definitions: new MemoryConnectorDefinitionStore(), store: new MemoryConnectStore(), secrets: new MemoryConnectionSecretStore() });
    await service.registerConnectorDefinition(definition);
    await expect(service.registerConnectorDefinition({ ...definition, http: { ...definition.http, origins: ["https://another.example.com"] } }))
      .rejects.toMatchObject({ code: "invalid_provider" });
    expect(await service.listCatalog()).toMatchObject([{ http: { origins: ["https://crm.example.com"] } }]);
  });

  it("disabling a custom definition blocks an existing Connection without substituting a provider", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const service = createConnectService({ providers: [], definitions: new MemoryConnectorDefinitionStore(), store: new MemoryConnectStore(), secrets: new MemoryConnectionSecretStore(), fetch });
    await service.registerConnectorDefinition(definition);
    const connection = await service.createApiKeyConnection({ providerId: "custom_crm", apiKey: "private-key" });
    await service.disableConnectorDefinition("custom_crm");
    await expect(service.request({ connectionId: connection.id, request: { method: "GET", path: "/contacts" } })).rejects.toMatchObject({ code: "provider_not_found" });
    expect(await service.listCatalog()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not let a custom registration shadow a host Connector", async () => {
    const service = createConnectService({ providers: [{ id: "custom_crm", name: "Host CRM", auth: { type: "api_key" } }], definitions: new MemoryConnectorDefinitionStore(), store: new MemoryConnectStore(), secrets: new MemoryConnectionSecretStore() });
    await expect(service.registerConnectorDefinition(definition)).rejects.toMatchObject({ code: "invalid_provider" });
  });
});
