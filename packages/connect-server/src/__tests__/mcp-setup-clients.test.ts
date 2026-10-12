import { describe, expect, it, vi } from "vitest";
import type { ResolvedMcpOAuthClient } from "@polpo-ai/connect";
import { resolveMcpOAuthSetupClient, verifyMcpOAuthSetupClient } from "../mcp-setup-clients.js";

const configuration: ResolvedMcpOAuthClient = {
  id: "customer-files", providerId: "mcp_url", authenticationId: "oauth",
  owner: { type: "project", id: "project" }, resourceUrl: "https://mcp.example/mcp", transport: "http",
  redirectUri: "https://host.example/callback",
  registration: { mode: "pre_registered", client: { client_id: "customer-app", client_secret: "private-client-secret" } },
};
const request = { providerId: "mcp_url", authenticationId: "oauth", projectId: "project", orgId: "org", mode: "customer" as const, configurationId: configuration.id };
function harness(client = configuration) {
  const resolver = { resolve: vi.fn(async () => client), resolveById: vi.fn(async () => client) };
  return { resolver };
}

describe("reusable host-owned MCP OAuth clients", () => {
  it.each(["http://localhost:4411/callback", "http://127.0.0.1:4411/callback", "http://[::1]:4411/callback", "https://api.polpo.localhost/callback"])("accepts a host-owned loopback callback: %s", async redirectUri => {
    const { resolver } = harness({ ...configuration, redirectUri });
    const result = await resolveMcpOAuthSetupClient(resolver, request);
    expect(result.client.redirectUri).toBe(redirectUri);
    expect((await verifyMcpOAuthSetupClient(resolver, result.reference)).client.redirectUri).toBe(redirectUri);
  });

  it.each([
    { mode: "dynamic" as const, clientName: "Customer app", clientUri: "https://customer.example" },
    { mode: "metadata_document" as const, clientMetadataUrl: "https://customer.example/client.json" },
    configuration.registration,
  ])("resolves %j independently from configuration ownership", async registration => {
    const { resolver } = harness({ ...configuration, registration });
    const result = await resolveMcpOAuthSetupClient(resolver, request);
    expect(resolver.resolve).toHaveBeenCalledWith(request);
    expect(result.client.registration.mode).toBe(registration.mode);
    expect(result.reference).toEqual({ id: configuration.id, fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(JSON.stringify(result.reference)).not.toContain("private-");
    expect(result.registrationNamespace).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    { owner: { type: "project", id: "another-project" } },
    { owner: { type: "org", id: "another-org" } },
    { owner: { type: "platform", id: "platform" } },
    { providerId: "other" }, { authenticationId: "other" }, { id: "another-configuration" },
  ])("rejects a resolver result outside its requested selection: %j", async change => {
    const { resolver } = harness({ ...configuration, ...change } as ResolvedMcpOAuthClient);
    await expect(resolveMcpOAuthSetupClient(resolver, request)).rejects.toMatchObject({ code: "setup_invalid" });
  });

  it("allows explicit managed and instance configurations without treating them as customer-owned", async () => {
    for (const [mode, type] of [["managed", "platform"], ["instance", "instance"]] as const) {
      const { resolver } = harness({ ...configuration, owner: { type, id: "host" } });
      expect((await resolveMcpOAuthSetupClient(resolver, { ...request, mode })).client.owner.type).toBe(type);
    }
  });

  it("permits secret rotation but rejects changed client identity and revoked configuration", async () => {
    const { resolver } = harness();
    const original = await resolveMcpOAuthSetupClient(resolver, request);
    resolver.resolveById.mockResolvedValueOnce({ ...configuration, registration: { mode: "pre_registered", client: { client_id: "customer-app", client_secret: "rotated-secret" } } });
    expect((await verifyMcpOAuthSetupClient(resolver, original.reference)).client.registration).toMatchObject({ client: { client_secret: "rotated-secret" } });
    resolver.resolveById.mockResolvedValueOnce({ ...configuration, registration: { mode: "pre_registered", client: { client_id: "another-app" } } });
    await expect(verifyMcpOAuthSetupClient(resolver, original.reference)).rejects.toMatchObject({ code: "setup_invalid" });
    resolver.resolveById.mockResolvedValueOnce(null as unknown as ResolvedMcpOAuthClient);
    await expect(verifyMcpOAuthSetupClient(resolver, original.reference)).rejects.toMatchObject({ code: "setup_invalid" });
  });

  it.each([
    { resourceUrl: "http://mcp.example/mcp" }, { resourceUrl: "https://127.0.0.1/mcp" },
    { resourceUrl: "https://mcp.example/mcp?access_token=private" }, { transport: "stdio" },
    { redirectUri: "https://user:secret@host.example/callback" },
    { redirectUri: "http://host.example/callback" }, { redirectUri: "http://localhost.evil.example/callback" },
    { redirectUri: "https://10.0.0.1/callback" }, { redirectUri: "http://0.0.0.0/callback" },
    { redirectUri: "http://localhost:4411/callback#fragment" }, { redirectUri: "http://localhost/callback?token=secret" },
    { registration: { mode: "metadata_document", clientMetadataUrl: "https://customer.example" } },
    { registration: { mode: "pre_registered", client: { client_id: "" } } },
    { registration: { mode: "dynamic", clientName: "" } },
  ])("rejects malformed or unsafe reusable configuration: %j", async change => {
    const { resolver } = harness({ ...configuration, ...change } as ResolvedMcpOAuthClient);
    await expect(resolveMcpOAuthSetupClient(resolver, request)).rejects.toMatchObject({ code: "setup_invalid" });
  });

  it.each([
    { resourceUrl: "https://another.example/mcp" }, { transport: "sse" },
    { redirectUri: "https://other.example/callback" }, { owner: { type: "org", id: "org" } },
  ])("rejects mutable consent authority changed after setup: %j", async change => {
    const { resolver } = harness();
    const original = await resolveMcpOAuthSetupClient(resolver, request);
    resolver.resolveById.mockResolvedValueOnce({ ...configuration, ...change } as ResolvedMcpOAuthClient);
    await expect(verifyMcpOAuthSetupClient(resolver, original.reference)).rejects.toMatchObject({ code: "setup_invalid" });
  });
});
