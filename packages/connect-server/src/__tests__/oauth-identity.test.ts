import { describe, expect, it, vi } from "vitest";
import { createConnectService, MemoryConnectStore, MemoryConnectionSecretStore } from "../index.js";
import type { ConnectorDefinition } from "@polpo-ai/connect";
import { normalizeOAuthTokenScopes, resolveOAuthAccountIdentity } from "../oauth-identity.js";

export const identityDefinition: ConnectorDefinition = {
  version: 2, id: "accounts", name: "Accounts", source: "custom", protocol: "http_api",
  defaultAuthenticationId: "oauth", scopes: [{ id: "read" }, { id: "openid" }],
  authentication: [{ id: "oauth", type: "oauth2", authorizationUrl: "https://auth.example/authorize",
    tokenUrl: "https://auth.example/token", defaultScopes: ["read"],
    identity: { method: "userinfo", issuer: "https://auth.example", url: "https://identity.example/userinfo", requiredScopes: ["openid"] } }],
  http: { origins: ["https://api.example"] },
};

export function identityHarness() {
  const store = new MemoryConnectStore(), secrets = new MemoryConnectionSecretStore();
  const client = { id: "app", providerId: "accounts", clientId: "client", clientSecret: "fixture-secret",
    redirectUris: ["https://host.example/callback"], owner: { type: "instance" as const, id: "instance" } };
  const userinfo = vi.fn(async () => Response.json({ sub: "account-1", email: "person@example.com" }));
  const fetch = vi.fn<typeof globalThis.fetch>(async (url) => String(url).includes("/token")
    ? Response.json({ access_token: "private-token", refresh_token: "private-refresh", scope: "read openid" }) : userinfo());
  const options = { providers: [identityDefinition], store, links: store, setupSessions: store, secrets, fetch,
    allowedReturnUrlOrigins: ["https://app.example"],
    resolveHostname: async () => ["8.8.8.8"], oauthClients: { resolve: async () => client, resolveById: async () => client } };
  const service = createConnectService(options);
  const start = () => service.startOAuth({ providerId: "accounts", redirectUri: client.redirectUris[0] });
  return { store, secrets, client, userinfo, fetch, service, start, options };
}

describe("OAuth account identity", () => {
  it("checks UserInfo before activation and never substitutes an email or decoded JWT for the subject", async () => {
    const { service, start, fetch, store } = identityHarness();
    const started = await start();
    expect(new URL(started.authorizationUrl).searchParams.get("scope")?.split(" ")).toEqual(["openid", "read"]);
    const connection = await service.completeOAuth({ state: started.state, code: "code" });
    expect(connection.oauthIdentity).toMatchObject({ issuer: "https://auth.example", subject: "account-1", policyFingerprint: expect.any(String) });
    expect(String(fetch.mock.calls[1][0])).toBe("https://identity.example/userinfo");
    expect(new Headers(fetch.mock.calls[1][1]?.headers).get("authorization")).toBe("Bearer private-token");
    expect(await store.listConnections()).toHaveLength(1);
  });

  it.each([401, 403, 429, 500])("does not activate an account after UserInfo returns %s", async status => {
    const { service, start, store, userinfo, secrets } = identityHarness();
    const save = vi.spyOn(secrets, "setSecret");
    userinfo.mockImplementation(async () => new Response("private-provider-body", { status }));
    const { state } = await start();
    await expect(service.completeOAuth({ state, code: "code" })).rejects.toMatchObject({ code: "setup_invalid" });
    expect(await store.listConnections()).toEqual([]);
    expect(save).not.toHaveBeenCalled();
  });

  it.each([{ email: "account-1" }, { sub: "" }, { sub: 123 }, { sub: "account-1", iss: "https://other.example" }])("rejects an invalid identity response %#", async response => {
    const { service, start, userinfo, store } = identityHarness();
    userinfo.mockImplementation(async () => Response.json(response));
    const { state } = await start();
    await expect(service.completeOAuth({ state, code: "code" })).rejects.toMatchObject({ code: "setup_invalid" });
    expect(await store.listConnections()).toEqual([]);
  });

  it.each(["issuer", "url", "requiredScopes", "scopeAliases", "removed"])("invalidates a callback and existing identity when the %s policy changes", async change => {
    const { service, start, options } = identityHarness();
    const first = await start();
    const connection = await service.completeOAuth({ state: first.state, code: "code" });
    const pending = await start();
    const changed = structuredClone(identityDefinition);
    if (changed.protocol !== "http_api" || changed.authentication[0].type !== "oauth2") throw new Error("fixture");
    const policy = changed.authentication[0].identity!;
    if (change === "issuer") policy.issuer = "https://other.example";
    if (change === "url") policy.url = "https://other.example/userinfo";
    if (change === "requiredScopes") policy.requiredScopes = ["openid", "read"];
    if (change === "scopeAliases") policy.scopeAliases = { "provider-openid": "openid" };
    if (change === "removed") changed.authentication[0].identity = undefined;
    const other = createConnectService({ ...options, providers: [changed] });
    await expect(other.completeOAuth({ state: pending.state, code: "code" })).rejects.toMatchObject({ code: "setup_invalid" });
    await expect(other.resolveCredential({ connectionId: connection.id })).rejects.toMatchObject({ code: "setup_invalid" });
  });

  it("pins identity policy and required scopes in a setup session before redirecting", async () => {
    const { service, options } = identityHarness();
    const setup = await service.createSetupSession({ providerId: "accounts", projectId: "project", audience: "shared",
      subject: { type: "project", id: "project" }, returnUrl: "https://app.example/connected", scopes: ["read"], oauthClientMode: "instance" });
    expect(setup.scopes).toEqual(["openid", "read"]);
    expect(setup.oauthIdentityPolicyFingerprint).toEqual(expect.any(String));
    const changed = structuredClone(identityDefinition);
    if (changed.protocol !== "http_api" || changed.authentication[0].type !== "oauth2") throw new Error("fixture");
    changed.authentication[0].identity!.issuer = "https://other.example";
    await expect(createConnectService({ ...options, providers: [changed] }).startOAuthSetup({ setupSessionId: setup.id }))
      .rejects.toMatchObject({ code: "setup_invalid" });
  });

  it("permits initial custom OAuth without identity but requires explicit new setup for reconnect", async () => {
    const { options } = identityHarness();
    const definition = structuredClone(identityDefinition);
    if (definition.protocol !== "http_api" || definition.authentication[0].type !== "oauth2") throw new Error("fixture");
    delete definition.authentication[0].identity;
    const service = createConnectService({ ...options, providers: [definition] });
    const start = await service.startOAuth({ providerId: "accounts", redirectUri: "https://host.example/callback" });
    const connection = await service.completeOAuth({ state: start.state, code: "code" });
    expect(connection.oauthIdentity).toBeUndefined();
    await expect(service.reconnectOAuth({ connectionId: connection.id, redirectUri: "https://host.example/callback" }))
      .rejects.toMatchObject({ code: "setup_invalid" });
  });

  it("normalizes only explicitly declared aliases, never object prototype keys", () => {
    expect(normalizeOAuthTokenScopes({ type: "oauth2", authorizationUrl: "https://auth.example", tokenUrl: "https://auth.example/token",
      identity: { method: "userinfo", issuer: "https://auth.example", url: "https://identity.example/userinfo", requiredScopes: ["email"],
        scopeAliases: { "provider-email": "email" } } }, ["provider-email", "constructor", "toString"]))
      .toEqual(["constructor", "email", "toString"]);
  });

  it("does not move a verified account to a different OAuth registration during reconnect", async () => {
    const { service, start, options, client } = identityHarness();
    const pending = await start();
    const connection = await service.completeOAuth({ state: pending.state, code: "code" });
    const changed = createConnectService({ ...options, oauthClients: { ...options.oauthClients,
      resolveById: async () => ({ ...client, clientId: "different-app-registration" }) } });
    await expect(changed.reconnectOAuth({ connectionId: connection.id, redirectUri: client.redirectUris[0] }))
      .rejects.toMatchObject({ code: "setup_invalid" });
  });

  it("does not activate a new Connection when its app changes during UserInfo", async () => {
    const { service, start, client, userinfo, store, secrets } = identityHarness();
    userinfo.mockImplementation(async () => {
      client.clientId = "different-app-registration";
      return Response.json({ sub: "account-1" });
    });
    const save = vi.spyOn(secrets, "setSecret");
    const pending = await start();
    await expect(service.completeOAuth({ state: pending.state, code: "code" })).rejects.toMatchObject({ code: "setup_invalid" });
    expect(await store.listConnections()).toEqual([]);
    expect(save).not.toHaveBeenCalled();
  });
});

describe("protected UserInfo transport", () => {
  const policy = { method: "userinfo" as const, issuer: "https://auth.example", url: "https://identity.example/userinfo", requiredScopes: ["openid"] };
  it.each([
    new Response("encoded.private.jwt", { headers: { "content-type": "application/jwt" } }),
    new Response(JSON.stringify({ sub: "account-1" }), { headers: { "content-type": "text/html" } }),
    new Response(null, { status: 302, headers: { location: "https://evil.example" } }),
    new Response("x".repeat(262145), { headers: { "content-type": "application/json" } }),
  ])("rejects untrusted response formats, redirects and oversized payloads without exposing them", async response => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response);
    const error = await resolveOAuthAccountIdentity({ fetch, resolveHostname: async () => ["8.8.8.8"] }, policy, "private-token", new Date())
      .catch(error => error);
    expect(error).toMatchObject({ code: "setup_invalid" });
    expect(JSON.stringify(error)).not.toMatch(/private-token|encoded.private.jwt|evil.example/);
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: "GET", redirect: "error", signal: expect.any(AbortSignal) });
  });

  it("denies private DNS before transmitting credentials", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(resolveOAuthAccountIdentity({ fetch, resolveHostname: async () => ["127.0.0.1"] }, policy, "private-token", new Date()))
      .rejects.toMatchObject({ code: "setup_invalid", details: { category: "network_denied" } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("bounds stalled UserInfo bodies and cancels the stream", async () => {
    const cancel = vi.fn();
    await expect(resolveOAuthAccountIdentity({ timeoutMs: 10, resolveHostname: async () => ["8.8.8.8"],
      fetch: async () => new Response(new ReadableStream({ cancel }), { headers: { "content-type": "application/json" } }) }, policy, "private-token", new Date()))
      .rejects.toMatchObject({ code: "setup_invalid", details: { category: "timeout" } });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
