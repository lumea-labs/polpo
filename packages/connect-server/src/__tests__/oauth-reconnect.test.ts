import { describe, expect, it, vi } from "vitest";
import type { ConnectionRecord, ConnectorDefinition, ResolvedOAuthClient } from "@polpo-ai/connect";
import { createConnectionAccessResolver } from "@polpo-ai/connect";
import { createToolInvocationContext } from "@polpo-ai/core";
import { oauthIdentityPolicyFingerprint } from "../oauth-identity.js";
import { createConnectService, MemoryConnectStore, MemoryConnectionSecretStore, type TokenRefreshCoordinator } from "../index.js";

const callback = "https://host.example/callback";
const identity = { method: "userinfo" as const, issuer: "https://auth.example", url: "https://identity.example/userinfo", requiredScopes: ["read"] };
const provider: ConnectorDefinition = {
  version: 2, id: "accounts", name: "Accounts", source: "custom", protocol: "http_api",
  defaultAuthenticationId: "key", scopes: [{ id: "read" }, { id: "write" }],
  authentication: [
    { id: "key", type: "api_key", injection: { mode: "bearer" } },
    { id: "own-oauth", type: "oauth2", authorizationUrl: "https://auth.example/authorize", tokenUrl: "https://auth.example/token", defaultScopes: ["read", "write"], identity },
  ],
  http: { origins: ["https://api.example"] },
};

async function harness(refreshCoordinator?: TokenRefreshCoordinator) {
  const store = new MemoryConnectStore();
  const own: ResolvedOAuthClient = { id: "own-app", providerId: provider.id, clientId: "own-client",
    clientSecret: "fixture-secret", redirectUris: [callback], owner: { type: "project", id: "project-1" } };
  const resolve = vi.fn(async () => ({ ...own, id: "managed-app", clientId: "managed-client" }));
  const resolveById = vi.fn(async (): Promise<ResolvedOAuthClient | null> => own);
  const userinfo = vi.fn(async () => Response.json({ sub: "account-1", email: "person@example.com" }));
  const fetch = vi.fn<typeof globalThis.fetch>(async url => String(url).includes("/token")
    ? Response.json({ access_token: "fixture-token", scope: "read" }) : userinfo());
  const secrets = new MemoryConnectionSecretStore();
  const service = createConnectService({ providers: [provider], store, links: store,
    secrets, oauthClients: { resolve, resolveById }, fetch, refreshCoordinator,
    resolveHostname: async () => ["8.8.8.8"] });
  const original: ConnectionRecord = { id: "connection-1", providerId: provider.id, authenticationId: "own-oauth",
    oauthClientId: own.id, orgId: "org-1", audience: "personal", owner: { type: "user", id: "user-1" },
    binding: { principal: { type: "user", id: "user-1" }, tenant: { namespace: "app", id: "tenant-1" }, scopeEpoch: "epoch-2" },
    authType: "oauth2", status: "active", grantedScopes: ["read"], name: "My account",
    secretRef: "old-secret", credentialVersion: "old-generation",
    oauthIdentity: { issuer: identity.issuer, subject: "account-1", policyFingerprint: oauthIdentityPolicyFingerprint(identity)!, verifiedAt: new Date().toISOString() },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await store.upsertConnection(original);
  await secrets.setSecret("old-secret", { kind: "oauth2", tokens: { accessToken: "old-token", scopes: ["read"] } });
  await store.upsertConnectionLink({ id: "existing-link", connectionId: original.id, projectId: "project-1", status: "active", createdAt: original.createdAt, updatedAt: original.updatedAt });
  return { service, store, secrets, original, own, resolve, resolveById, fetch, userinfo };
}

describe("OAuth reconnect lineage", () => {
  it("preserves the exact customer app, nondefault method, audience, binding and scope ceiling through consent", async () => {
    const { service, store, secrets, original, own, resolve, resolveById } = await harness();
    const started = await service.reconnectOAuth({ connectionId: original.id, projectId: "project-1", orgId: "org-1", redirectUri: callback });
    expect(new URL(started.authorizationUrl).searchParams.get("client_id")).toBe(own.clientId);
    expect(new URL(started.authorizationUrl).searchParams.get("scope")).toBe("read");
    expect(resolveById).toHaveBeenCalledWith("own-app");
    expect(resolve).not.toHaveBeenCalled();
    expect(await store.getConnection(original.id)).toEqual(original);
    const next = await service.completeOAuth({ state: started.state, code: "fixture-code" });
    expect(next).toMatchObject({ id: original.id, oauthClientId: own.id, authenticationId: "own-oauth", audience: original.audience,
      owner: original.owner, binding: original.binding, grantedScopes: ["read"], name: original.name });
    expect(await store.listConnectionLinks({ projectId: "project-1" })).toEqual([
      expect.objectContaining({ id: "existing-link", connectionId: original.id, status: "active" }),
    ]);
    expect(next.credentialVersion).not.toBe(original.credentialVersion);
    expect(next.secretRef).not.toBe(original.secretRef);
    expect(await secrets.getSecret("old-secret")).toBeNull();
    expect(await store.listConnections()).toHaveLength(1);
  });

  it.each(["missing", "different-provider", "different-id"])("never substitutes another app when the original client is %s", async (reason) => {
    const { service, store, original, own, resolveById, resolve, fetch } = await harness();
    resolveById.mockResolvedValue(reason === "missing" ? null : {
      ...own, ...(reason === "different-provider" ? { providerId: "other" } : { id: "managed-app" }),
    });
    await expect(service.reconnectOAuth({ connectionId: original.id, redirectUri: callback })).rejects.toMatchObject({ code: "setup_invalid" });
    expect(await store.getConnection(original.id)).toEqual(original);
    expect(resolve).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects legacy records without a pinned client instead of guessing managed ownership", async () => {
    const { service, store, original, resolve } = await harness();
    await store.upsertConnection({ ...original, oauthClientId: undefined });
    await expect(service.reconnectOAuth({ connectionId: original.id, redirectUri: callback })).rejects.toMatchObject({ code: "setup_invalid" });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("rejects an unrelated organization before resolving credentials", async () => {
    const { service, original, resolveById } = await harness();
    await expect(service.reconnectOAuth({ connectionId: original.id, orgId: "other-org", redirectUri: callback })).rejects.toMatchObject({ code: "policy_denied" });
    expect(resolveById).not.toHaveBeenCalled();
  });
});


describe("OAuth reconnect account and concurrency guarantees", () => {
  it("recovers a credential replacement committed before its acknowledgement was lost", async () => {
    const { service, store, original, secrets } = await harness();
    const replace = store.replaceOAuthCredential.bind(store);
    vi.spyOn(store, "replaceOAuthCredential").mockImplementationOnce(async (...args) => {
      await replace(...args); throw new Error("acknowledgement lost");
    });
    const start = await service.reconnectOAuth({ connectionId: original.id, redirectUri: callback });
    const next = await service.completeOAuth({ state: start.state, code: "code" });
    expect(next.secretRef).not.toBe(original.secretRef);
    expect(await store.getConnection(original.id)).toEqual(next);
    expect(await secrets.getSecret(next.secretRef!)).not.toBeNull();
    expect(await secrets.getSecret("old-secret")).toBeNull();
  });

  it.each(["old_row", "read_failed", "revoked"] as const)("preserves staged reconnect tokens when the CAS outcome cannot be recovered: %s", async (failure) => {
    const { service, store, original, secrets } = await harness();
    const save = vi.spyOn(secrets, "setSecret");
    const replace = store.replaceOAuthCredential.bind(store);
    vi.spyOn(store, "replaceOAuthCredential").mockImplementationOnce(async (...args) => {
      if (failure !== "old_row") await replace(...args);
      if (failure === "revoked") await store.updateConnection(original.id, { status: "revoked" });
      if (failure === "read_failed") vi.spyOn(store, "getConnection").mockRejectedValueOnce(new Error("read unavailable"));
      throw new Error("acknowledgement lost");
    });
    const start = await service.reconnectOAuth({ connectionId: original.id, redirectUri: callback });
    await expect(service.completeOAuth({ state: start.state, code: "code" })).rejects.toThrow("acknowledgement lost");
    expect(await secrets.getSecret(save.mock.calls[0][0])).not.toBeNull();
    const stored = (await store.getConnection(original.id))!;
    expect(stored.status).toBe(failure === "revoked" ? "revoked" : "active");
  });

  it("does not delete an already committed credential when coordinator release fails", async () => {
    const { service, store, original, secrets } = await harness({ runExclusive: async (_id, fn) => {
      await fn();
      throw new Error("coordinator release failed");
    } });
    const start = await service.reconnectOAuth({ connectionId: original.id, redirectUri: callback });
    const next = await service.completeOAuth({ state: start.state, code: "code" });
    expect(await store.getConnection(original.id)).toEqual(next);
    expect(await secrets.getSecret(next.secretRef!)).not.toBeNull();
    expect(await secrets.getSecret("old-secret")).toBeNull();
  });

  it.each(["revoked", "changed"])("rechecks an app %s while UserInfo was in flight", async change => {
    const { service, original, own, store, userinfo, resolveById, secrets } = await harness();
    const save = vi.spyOn(secrets, "setSecret");
    userinfo.mockImplementation(async () => {
      resolveById.mockResolvedValue(change === "revoked" ? null : { ...own, clientId: "other-client" });
      return Response.json({ sub: "account-1" });
    });
    const start = await service.reconnectOAuth({ connectionId: original.id, redirectUri: callback });
    await expect(service.completeOAuth({ state: start.state, code: "code" })).rejects.toMatchObject({ code: "setup_invalid" });
    expect(await store.getConnection(original.id)).toEqual(original);
    expect(save).not.toHaveBeenCalled();
  });

  it("invalidates an already acquired run capability while allowing a fresh authorized acquisition", async () => {
    const { service, store, original } = await harness();
    const resolver = createConnectionAccessResolver({ store, isConnectionVisible: () => true,
      resolveSelector: () => ({ projectId: "project-1", orgId: "org-1", ...original.binding }) });
    const input = { slot: "account", spec: { provider: provider.id, scopes: ["read"] }, toolName: "read_account", toolCallId: "call",
      invocation: createToolInvocationContext({ runId: "old-run", requestId: "request", surface: "channel" }) };
    const access = await resolver.acquire(input);
    expect((await access.current()).credentialVersion).toBe("old-generation");
    const start = await service.reconnectOAuth({ connectionId: original.id, redirectUri: callback });
    const next = await service.completeOAuth({ state: start.state, code: "code" });
    await expect(access.current()).rejects.toMatchObject({ code: "connection_not_found_for_scope" });
    expect((await (await resolver.acquire(input)).current()).credentialVersion).toBe(next.credentialVersion);
  });

  it("allows a changed email only when the stable subject is the same", async () => {
    const { service, userinfo, original } = await harness();
    userinfo.mockImplementation(async () => Response.json({ sub: "account-1", email: "renamed@example.com" }));
    const start = await service.reconnectOAuth({ connectionId: original.id, redirectUri: callback });
    expect((await service.completeOAuth({ state: start.state, code: "code" })).id).toBe(original.id);
  });

  it("refuses a different subject even with the same email and leaves the original intact", async () => {
    const { service, userinfo, original, secrets, store } = await harness();
    const save = vi.spyOn(secrets, "setSecret");
    userinfo.mockImplementation(async () => Response.json({ sub: "different-account", email: "person@example.com" }));
    const start = await service.reconnectOAuth({ connectionId: original.id, redirectUri: callback });
    await expect(service.completeOAuth({ state: start.state, code: "code" })).rejects.toMatchObject({ code: "policy_denied" });
    expect(await store.getConnection(original.id)).toEqual(original);
    expect(await secrets.getSecret("old-secret")).not.toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it.each(["revoke", "generation", "owner", "binding", "scopes"])("cannot commit over a concurrent %s", async change => {
    const { service, original, userinfo, store, secrets } = await harness();
    const remove = vi.spyOn(secrets, "deleteSecret");
    userinfo.mockImplementation(async () => {
      await store.updateConnection(original.id, change === "revoke" ? { status: "revoked" }
        : change === "generation" ? { credentialVersion: "other-generation" }
          : change === "owner" ? { owner: { type: "user", id: "other-user" } }
            : change === "binding" ? { binding: { ...original.binding, scopeEpoch: "new-epoch" } }
              : { grantedScopes: [] });
      return Response.json({ sub: "account-1" });
    });
    const start = await service.reconnectOAuth({ connectionId: original.id, redirectUri: callback });
    await expect(service.completeOAuth({ state: start.state, code: "code" })).rejects.toMatchObject({ code: "policy_denied" });
    expect((await store.getConnection(original.id))?.secretRef).toBe("old-secret");
    expect(await secrets.getSecret("old-secret")).not.toBeNull();
    expect(remove).toHaveBeenCalledOnce();
    expect(remove).not.toHaveBeenCalledWith("old-secret");
    expect(await secrets.getSecret(remove.mock.calls[0][0])).toBeNull();
  });

  it("elects one winner for two valid consents started from the same credential generation", async () => {
    const { service, original, store, secrets } = await harness();
    const starts = await Promise.all([1, 2].map(() => service.reconnectOAuth({ connectionId: original.id, redirectUri: callback })));
    const results = await Promise.allSettled(starts.map(start => service.completeOAuth({ state: start.state, code: "code" })));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    const saved = (await store.getConnection(original.id))!;
    expect(saved.credentialVersion).not.toBe(original.credentialVersion);
    expect(await secrets.getSecret(saved.secretRef!)).not.toBeNull();
    expect(await store.listConnectionLinks({ projectId: "project-1" })).toHaveLength(1);
  });

  it("does not grant reconnect authority to caller-provided metadata", async () => {
    const { service, original, store, own, resolve } = await harness();
    resolve.mockResolvedValue(own);
    const start = await service.startOAuth({ providerId: provider.id, authenticationId: "own-oauth", redirectUri: callback,
      scopes: ["read"], metadata: { reconnectConnectionId: original.id } });
    const next = await service.completeOAuth({ state: start.state, code: "code" });
    expect(next.id).not.toBe(original.id);
    expect(await store.getConnection(original.id)).toEqual(original);
  });

  it("requires explicit new setup for legacy identities and does not promote a Test Connection account id", async () => {
    const { service, original, store, fetch } = await harness();
    await store.updateConnection(original.id, { oauthIdentity: undefined, providerAccountId: "account-1" });
    await expect(service.reconnectOAuth({ connectionId: original.id, redirectUri: callback })).rejects.toMatchObject({ code: "setup_invalid" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not re-add identity scopes removed from the original authorization ceiling", async () => {
    const { service, original, store, fetch } = await harness();
    await store.updateConnection(original.id, { grantedScopes: [] });
    await expect(service.reconnectOAuth({ connectionId: original.id, redirectUri: callback })).rejects.toMatchObject({ code: "setup_invalid" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a host without atomic replacement and does not resurrect revoked records", async () => {
    const { service, original, store } = await harness();
    const replace = store.replaceOAuthCredential;
    Object.assign(store, { replaceOAuthCredential: undefined });
    await expect(service.reconnectOAuth({ connectionId: original.id, redirectUri: callback })).rejects.toMatchObject({ code: "setup_invalid" });
    store.replaceOAuthCredential = replace;
    await store.updateConnection(original.id, { status: "revoked" });
    await expect(service.reconnectOAuth({ connectionId: original.id, redirectUri: callback })).rejects.toMatchObject({ code: "connection_revoked" });
  });

  it("leaves the original usable after provider denial and prevents callback replay", async () => {
    const { service, original, store, fetch } = await harness();
    const start = await service.reconnectOAuth({ connectionId: original.id, redirectUri: callback });
    await expect(service.completeOAuth({ state: start.state, error: "access_denied" })).rejects.toMatchObject({ code: "oauth_error" });
    await expect(service.completeOAuth({ state: start.state, code: "code" })).rejects.toMatchObject({ code: "oauth_state_not_found" });
    expect(await store.getConnection(original.id)).toEqual(original);
    expect(fetch).not.toHaveBeenCalled();
  });
});
