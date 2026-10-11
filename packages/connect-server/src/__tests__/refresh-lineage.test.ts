import { describe, expect, it, vi } from "vitest";
import { ConnectError, type ConnectorProviderDefinition } from "@polpo-ai/connect";
import { createConnectService, MemoryConnectStore, MemoryConnectionSecretStore } from "../index.js";

const provider: ConnectorProviderDefinition = { id: "rotating", name: "Rotating tokens",
  auth: { type: "oauth2", authorizationUrl: "https://auth.example/authorize", tokenUrl: "https://auth.example/token",
    clientId: "fixture", defaultScopes: ["read"] }, scopes: [{ id: "read" }] };
const fresh = () => Response.json({ access_token: "fresh-access", refresh_token: "refresh-next", expires_in: 3600, scope: "read" });

async function fixture(authorizeOAuth?: Parameters<typeof createConnectService>[0]["authorizeOAuth"]) {
  const store = new MemoryConnectStore();
  const secrets = new MemoryConnectionSecretStore();
  await store.upsertConnection({ id: "account", providerId: provider.id, authType: "oauth2", status: "active",
    grantedScopes: ["read"], secretRef: "credential", createdAt: "2026-01-01", updatedAt: "2026-01-01" });
  await secrets.setSecret("credential", { kind: "oauth2", tokens: { accessToken: "expired-access",
    refreshToken: "single-use-refresh", scopes: ["read"], expiresAt: "2026-01-01T00:00:00Z" } });
  const fetch = vi.fn<typeof globalThis.fetch>(async () => fresh());
  // Independent coordinators deliberately provide no shared exclusion. This
  // models a second replica acquiring an expired lease, without timing luck.
  const replica = () => createConnectService({ providers: [provider], store, secrets, fetch, authorizeOAuth,
    now: () => new Date("2026-02-01T00:00:00Z"), tokenRefreshSkewMs: 0,
    resolveHostname: async () => ["93.184.216.34"],
    refreshCoordinator: { runExclusive: async (_id, work) => work() } });
  return { store, secrets, fetch, replica, request: { connectionId: "account", scopes: ["read"] } };
}

describe("durable refresh token lineage", () => {
  it("recovers when a host gate denies after the intent but before any provider dispatch", async () => {
    let denied = false;
    const f = await fixture(async () => { if (denied) throw new ConnectError("policy_denied", "disabled"); });
    const save = f.secrets.compareAndSet.bind(f.secrets);
    vi.spyOn(f.secrets, "compareAndSet").mockImplementationOnce(async (...args) => {
      const result = await save(...args); denied = true; return result;
    });
    await expect(f.replica().getToken(f.request)).rejects.toMatchObject({ code: "policy_denied" });
    expect(f.fetch).not.toHaveBeenCalled();
    denied = false;
    await expect(f.replica().getToken(f.request)).resolves.toMatchObject({ accessToken: "fresh-access" });
    expect(f.fetch).toHaveBeenCalledOnce();
  });
  it.each(["read_failure", "scope_restricted"])("persists a known rotated token before a post-refresh %s", async failure => {
    const f = await fixture();
    f.fetch.mockImplementationOnce(async () => {
      if (failure === "read_failure") vi.spyOn(f.store, "getConnection").mockRejectedValueOnce(new Error("temporary read failure"));
      else await f.store.updateConnection("account", { grantedScopes: [] });
      return fresh();
    });
    await expect(f.replica().getToken(f.request)).rejects.toThrow();
    expect(await f.secrets.getSecret("credential")).toMatchObject({ tokens: { refreshToken: "refresh-next" },
      metadata: { "polpo:oauth-refresh:v1": { status: "completed" } } });
    if (failure === "scope_restricted") {
      await expect(f.replica().getToken(f.request)).rejects.toThrow();
      await f.store.updateConnection("account", { grantedScopes: ["read"] });
    }
    await expect(f.replica().getToken(f.request)).resolves.toMatchObject({ accessToken: "fresh-access" });
    expect(f.fetch).toHaveBeenCalledOnce();
  });
  it.each([null, {}, { status: "completed" }])("fails closed for a malformed private refresh receipt: %j", async receipt => {
    const f = await fixture();
    const previous = (await f.secrets.getSecret("credential"))!;
    await f.secrets.setSecret("credential", { ...previous,
      tokens: { ...previous.tokens!, expiresAt: "2026-02-02T00:00:00Z" },
      metadata: { "polpo:oauth-refresh:v1": receipt } });
    await expect(f.replica().getToken(f.request)).rejects.toMatchObject({ code: "refresh_unavailable" });
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("does not consume a refresh token twice when independent replicas overlap", async () => {
    const f = await fixture();
    let entered!: () => void;
    let release!: (response: Response) => void;
    const dispatched = new Promise<void>(resolve => { entered = resolve; });
    f.fetch.mockImplementationOnce(async () => { entered(); return new Promise(resolve => { release = resolve; }); });
    const first = f.replica().getToken(f.request);
    await dispatched;
    try {
      await expect(f.replica().getToken(f.request)).rejects.toMatchObject({ code: "refresh_unavailable" });
      expect(f.fetch).toHaveBeenCalledOnce();
    } finally { release(fresh()); await first; }
    await expect(f.replica().getToken(f.request)).resolves.toMatchObject({ accessToken: "fresh-access" });
    expect(f.fetch).toHaveBeenCalledOnce();
  });

  it("does not retry a possibly consumed refresh token after a lost provider response", async () => {
    const f = await fixture();
    f.fetch.mockRejectedValueOnce(new Error("provider consumed the token, response was lost"));
    await expect(f.replica().getToken(f.request)).rejects.toThrow();
    await expect(f.replica().getToken(f.request)).rejects.toMatchObject({ code: "refresh_unavailable" });
    expect(f.fetch).toHaveBeenCalledOnce();
  });

  it("does not dispatch after losing the durable claim", async () => {
    const f = await fixture();
    vi.spyOn(f.secrets, "compareAndSet").mockResolvedValueOnce(false);
    await expect(f.replica().getToken(f.request)).rejects.toMatchObject({ code: "refresh_unavailable" });
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each([1, 2])("recovers a lost acknowledgement of refresh persistence write %s", async lostWrite => {
    const f = await fixture();
    const write = f.secrets.compareAndSet.bind(f.secrets);
    let writes = 0;
    vi.spyOn(f.secrets, "compareAndSet").mockImplementation(async (...args) => {
      const result = await write(...args);
      if (++writes === lostWrite) throw new Error("storage committed, acknowledgement lost");
      return result;
    });
    const result = await f.replica().getToken(f.request);
    expect(result).toMatchObject({ accessToken: "fresh-access" });
    expect(f.fetch).toHaveBeenCalledOnce();
    expect((await f.secrets.getSecret("credential"))?.tokens?.refreshToken).toBe("refresh-next");
    expect(JSON.stringify(result)).not.toMatch(/single-use-refresh|refresh-next|attempt/);
  });
});
