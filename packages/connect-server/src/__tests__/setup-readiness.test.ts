import { describe, expect, it, vi } from "vitest";
import { ConnectError, type ConnectorDefinition, type ResolvedOAuthClient } from "@polpo-ai/connect";
import { createConnectService, MemoryConnectStore, MemoryConnectionSecretStore } from "../index.js";

const provider: ConnectorDefinition = {
  version: 2, id: "contacts", name: "Contacts", source: "custom", protocol: "http_api",
  defaultAuthenticationId: "oauth",
  authentication: [
    { id: "oauth", type: "oauth2", authorizationUrl: "https://auth.example/authorize", tokenUrl: "https://auth.example/token" },
    { id: "key", type: "api_key", injection: { mode: "bearer" } },
    { id: "public", type: "none" },
  ],
  http: { origins: ["https://api.example"] },
};

function harness() {
  const client: ResolvedOAuthClient = {
    id: "stored-app", providerId: "contacts", clientId: "app-id", clientSecret: "private-client-secret",
    redirectUris: ["https://host.example/callback"], owner: { type: "project", id: "project-1" },
  };
  const resolve = vi.fn(async () => client);
  const fetch = vi.fn<typeof globalThis.fetch>();
  const service = createConnectService({
    providers: [provider], store: new MemoryConnectStore(), secrets: new MemoryConnectionSecretStore(),
    oauthClients: { resolve, resolveById: async () => client }, fetch,
  });
  return { service, resolve, fetch, client };
}

describe("Connector setup readiness", () => {
  it("checks the selected registered app without calling the provider or exposing its credentials", async () => {
    const { service, resolve, fetch } = harness();
    const result = await service.getSetupReadiness({
      providerId: "contacts", authenticationId: "oauth", oauthClientMode: "customer",
      projectId: "project-1", redirectUri: "https://host.example/callback",
    });
    expect(result).toMatchObject({ check: "configuration", outcome: "passed", code: "consent_required", nextStep: "oauth_consent" });
    expect(resolve).toHaveBeenCalledWith({ providerId: "contacts", authenticationId: "oauth", projectId: "project-1", mode: "customer" });
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("private-client-secret");
    expect(JSON.stringify(result)).not.toContain("app-id");
  });

  it("reports missing client and invalid callback as configuration failures, not live verification", async () => {
    const { service, resolve } = harness();
    expect(await service.getSetupReadiness({ providerId: "contacts", redirectUri: "https://other.example/callback" }))
      .toMatchObject({ outcome: "failed", code: "invalid_request" });
    resolve.mockRejectedValueOnce(new ConnectError("setup_invalid", "internal credential details"));
    const result = await service.getSetupReadiness({ providerId: "contacts", redirectUri: "https://host.example/callback" });
    expect(result).toMatchObject({ outcome: "failed", code: "setup_invalid" });
    expect(JSON.stringify(result)).not.toContain("internal credential details");
  });

  it("keeps key entry and unauthenticated setup distinct", async () => {
    const { service, resolve } = harness();
    expect(await service.getSetupReadiness({ providerId: "contacts", authenticationId: "key" }))
      .toMatchObject({ outcome: "passed", code: "credentials_required", nextStep: "credentials" });
    expect(await service.getSetupReadiness({ providerId: "contacts", authenticationId: "public" }))
      .toMatchObject({ outcome: "passed", code: "ready", nextStep: "create" });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("does not claim MCP discovery or a credential-only legacy key is a ready HTTP integration", async () => {
    const service = createConnectService({
      providers: [{ id: "legacy_key", name: "Key", auth: { type: "api_key" } },
        { id: "mcp_url", name: "MCP", auth: { type: "mcp", auth: "oauth2" } }],
      store: new MemoryConnectStore(), secrets: new MemoryConnectionSecretStore(),
    });
    expect(await service.getSetupReadiness({ providerId: "legacy_key" })).toMatchObject({ outcome: "unsupported", code: "credential_only" });
    expect(await service.getSetupReadiness({ providerId: "mcp_url" }))
      .toMatchObject({ outcome: "inconclusive", code: "discovery_required", nextStep: "mcp_discovery" });
  });

  it("changes configuration generation when the selected OAuth app changes", async () => {
    const { service, client } = harness();
    const input = { providerId: "contacts", redirectUri: "https://host.example/callback" };
    const first = await service.getSetupReadiness(input);
    client.clientId = "replacement-app";
    expect((await service.getSetupReadiness(input)).configurationVersion).not.toBe(first.configurationVersion);
  });
});
