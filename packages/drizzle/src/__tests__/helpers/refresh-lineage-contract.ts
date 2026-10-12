import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createConnectService } from "@polpo-ai/connect-server";
import type { ConnectorProviderDefinition } from "@polpo-ai/connect";
import type { DrizzleConnectStores } from "../../connect/index.js";

const provider: ConnectorProviderDefinition = { id: "refresh-fixture", name: "Refresh fixture",
  auth: { type: "oauth2", authorizationUrl: "https://auth.example/authorize", tokenUrl: "https://auth.example/token",
    clientId: "fixture", defaultScopes: ["read"] }, scopes: [{ id: "read" }] };
const fresh = () => Response.json({ access_token: "durable-access", refresh_token: "durable-next-refresh", scope: "read", expires_in: 3600 });

export function refreshLineageContract(stores: () => Promise<{ first: DrizzleConnectStores; second: DrizzleConnectStores }>) {
  async function fixture() {
    const { first, second } = await stores();
    const id = randomUUID(), ref = `credential-${id}`;
    await first.upsertConnection({ id, providerId: provider.id, authType: "oauth2", status: "active", secretRef: ref,
      grantedScopes: ["read"], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" });
    await first.setSecret(ref, { kind: "oauth2", tokens: { accessToken: "expired", refreshToken: "durable-once-only",
      scopes: ["read"], expiresAt: "2026-01-01T00:00:00Z" } });
    const fetch = vi.fn<typeof globalThis.fetch>(async () => fresh());
    const replica = (store: DrizzleConnectStores) => createConnectService({ providers: [provider], store, secrets: store, fetch,
      now: () => new Date("2026-02-01T00:00:00Z"), tokenRefreshSkewMs: 0, resolveHostname: async () => ["93.184.216.34"],
      refreshCoordinator: { runExclusive: async (_id, work) => work() } });
    return { first, second, ref, fetch, a: replica(first), b: replica(second), request: { connectionId: id } };
  }

  it("fences concurrent refresh using encrypted durable intent across independent store adapters", async () => {
    const f = await fixture();
    let entered!: () => void, release!: (response: Response) => void;
    const dispatched = new Promise<void>(resolve => { entered = resolve; });
    f.fetch.mockImplementationOnce(async () => { entered(); return new Promise(resolve => { release = resolve; }); });
    const active = f.a.getToken(f.request);
    await dispatched;
    try {
      await expect(f.b.getToken(f.request)).rejects.toMatchObject({ code: "refresh_unavailable" });
      expect(f.fetch).toHaveBeenCalledOnce();
    } finally { release(fresh()); await active; }
    await expect(f.b.getToken(f.request)).resolves.toMatchObject({ accessToken: "durable-access" });
    expect(f.fetch).toHaveBeenCalledOnce();
    expect((await f.second.getSecret(f.ref))?.tokens?.refreshToken).toBe("durable-next-refresh");
  });

  it("retains uncertain refresh across adapters and recovers only through a replacement credential", async () => {
    const f = await fixture();
    f.fetch.mockRejectedValueOnce(new Error("provider rotated the token but its response was lost"));
    await expect(f.a.getToken(f.request)).rejects.toThrow();
    await expect(f.b.getToken(f.request)).rejects.toMatchObject({ code: "refresh_unavailable" });
    expect(f.fetch).toHaveBeenCalledOnce();
    const replacement = `${f.ref}-reconnected`;
    await f.second.setSecret(replacement, { kind: "oauth2", tokens: { accessToken: "reauthorized", refreshToken: "new-lineage",
      scopes: ["read"], expiresAt: "2026-02-02T00:00:00Z" } });
    await f.second.updateConnection(f.request.connectionId, { secretRef: replacement, credentialVersion: "replacement" });
    await expect(f.a.getToken(f.request)).resolves.toMatchObject({ accessToken: "reauthorized" });
    expect(f.fetch).toHaveBeenCalledOnce();
  });

  it.each([1, 2])("recovers encrypted refresh persistence after lost write acknowledgement %s", async lostWrite => {
    const f = await fixture();
    const persist = f.first.compareAndSet.bind(f.first);
    let writes = 0;
    const spy = vi.spyOn(f.first, "compareAndSet").mockImplementation(async (...args) => {
      const result = await persist(...args);
      if (++writes === lostWrite) throw new Error("lost acknowledgement");
      return result;
    });
    try {
      await expect(f.a.getToken(f.request)).resolves.toMatchObject({ accessToken: "durable-access" });
      await expect(f.b.getToken(f.request)).resolves.toMatchObject({ accessToken: "durable-access" });
      expect(f.fetch).toHaveBeenCalledOnce();
    } finally { spy.mockRestore(); }
  });
}
