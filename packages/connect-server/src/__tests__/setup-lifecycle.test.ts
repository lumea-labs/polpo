import { describe, expect, it, vi } from "vitest";
import { createConnectService } from "../service.js";
import { MemoryConnectStore } from "../memory-store.js";
import { MemoryConnectionSecretStore } from "../secrets.js";
import type { ConnectorProviderDefinition } from "@polpo-ai/connect";

const provider: ConnectorProviderDefinition = { id: "example", name: "Example", scopes: [{ id: "read", label: "Read records" }],
  auth: { type: "oauth2", authorizationUrl: "https://auth.example/authorize", tokenUrl: "https://auth.example/token", defaultScopes: ["read"] } };
function harness() {
  let time = new Date("2026-10-10T00:00:00Z");
  const store = new MemoryConnectStore();
  const secrets = new MemoryConnectionSecretStore();
  const client = { id: "client", providerId: provider.id, clientId: "public-client", clientSecret: "private-client-secret",
    redirectUris: ["https://host.example/callback"], owner: { type: "instance" as const, id: "host" } };
  const fetch = vi.fn(async () => Response.json({ access_token: "private-access", scope: "read" }));
  const authorizeOAuth = vi.fn(async () => {});
  const createService = () => createConnectService({ providers: [provider], store, secrets, links: store, setupSessions: store,
    oauthClients: { resolve: async () => client, resolveById: async () => client },
    allowedReturnUrlOrigins: ["https://app.example"], resolveHostname: async () => ["8.8.8.8"], fetch, authorizeOAuth,
    now: () => time, setupSessionTtlMs: 60_000, oauthStateTtlMs: 120_000 });
  const service = createService();
  const setup = () => service.createSetupSession({ providerId: provider.id, projectId: "project", audience: "end_user",
    subject: { type: "external_user", namespace: "app", id: "private-owner" }, returnUrl: "https://app.example/connected", oauthClientMode: "instance",
    metadata: { private: "private-value", application: { name: "Example app", url: "https://app.example", secret: "private-app-secret" } } });
  return { service, createService, store, secrets, fetch, authorizeOAuth, setup, advance: (ms: number) => { time = new Date(time.getTime() + ms); } };
}

describe("shared setup lifecycle", () => {
  it("projects safe status, records successful completion and does not let replay alter it", async () => {
    const h = harness(); const setup = await h.setup();
    const status = await h.service.getSetupStatus(setup.id);
    expect(status).toMatchObject({ status: "pending", scopes: ["read"], application: { name: "Example app", url: "https://app.example" } });
    expect(JSON.stringify(status)).not.toMatch(/private-|returnUrl|subject|oauthClient|metadata|reference/);
    const start = await h.service.startOAuthSetup({ setupSessionId: setup.id });
    expect(await h.service.getSetupStatus(setup.id)).toMatchObject({ status: "started" });
    const connection = await h.service.completeOAuth({ state: start.state, code: "code" });
    expect(await h.service.getSetupStatus(setup.id)).toMatchObject({ status: "completed", resultingConnectionId: connection.id });
    await expect(h.service.completeOAuth({ state: start.state, error: "access_denied" })).rejects.toMatchObject({ code: "oauth_state_not_found" });
    h.advance(600_000);
    expect(await h.service.getSetupStatus(setup.id)).toMatchObject({ status: "completed", resultingConnectionId: connection.id });
    expect(connection.metadata).not.toHaveProperty("setupSessionRef");
  });

  it("cancels idempotently, preserves its terminal state, and blocks provider authorization", async () => {
    const h = harness(); const setup = await h.setup();
    const results = await Promise.all([h.service.cancelSetupSession(setup.id), h.service.cancelSetupSession(setup.id)]);
    expect(results.every(result => result?.status === "cancelled")).toBe(true);
    await expect(h.service.startOAuthSetup({ setupSessionId: setup.id })).rejects.toMatchObject({ code: "setup_consumed" });
    h.advance(600_000);
    expect(await h.service.cancelSetupSession(setup.id)).toMatchObject({ status: "cancelled" });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("allows exactly one winner between starting and cancelling", async () => {
    const h = harness(); const setup = await h.setup();
    const outcomes = await Promise.allSettled([h.service.startOAuthSetup({ setupSessionId: setup.id }), h.service.cancelSetupSession(setup.id)]);
    expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(["started", "cancelled"]).toContain((await h.service.getSetupStatus(setup.id))?.status);
  });

  it("checks expiry in the atomic transition after a slow authorizer", async () => {
    const h = harness(); const setup = await h.setup();
    h.authorizeOAuth.mockImplementationOnce(async () => h.advance(61_000));
    await expect(h.service.startOAuthSetup({ setupSessionId: setup.id })).rejects.toMatchObject({ code: "setup_expired" });
    expect((await h.store.getConnectionSetupSession(setup.id))?.consumedAt).toBeUndefined();
  });

  it("uses the OAuth authorization deadline once started, not the original setup-link deadline", async () => {
    const h = harness(); const setup = await h.setup(); h.advance(50_000);
    const start = await h.service.startOAuthSetup({ setupSessionId: setup.id }); h.advance(20_000);
    expect(await h.service.getSetupStatus(setup.id)).toMatchObject({ status: "started", expiresAt: start.expiresAt });
    await expect(h.service.cancelSetupSession(setup.id)).rejects.toMatchObject({ code: "setup_consumed", status: 410 });
    await h.service.completeOAuth({ state: start.state, code: "code" });
    expect(await h.service.getSetupStatus(setup.id)).toMatchObject({ status: "completed" });
  });

  it("records a failure before state persistence even when the second authorization check denies", async () => {
    const h = harness(); const setup = await h.setup();
    h.authorizeOAuth.mockImplementationOnce(async () => {}).mockRejectedValueOnce(new Error("authorization revoked"));
    await expect(h.service.startOAuthSetup({ setupSessionId: setup.id })).rejects.toThrow("authorization revoked");
    expect(await h.service.getSetupStatus(setup.id)).toMatchObject({ status: "error" });
  });

  it("does not mark setup failed when an OAuth state write commits but loses its acknowledgement", async () => {
    const h = harness(); const setup = await h.setup();
    const save = h.store.saveOAuthState.bind(h.store);
    vi.spyOn(h.store, "saveOAuthState").mockImplementationOnce(async state => { await save(state); throw new Error("lost acknowledgement"); });
    await expect(h.service.startOAuthSetup({ setupSessionId: setup.id })).rejects.toThrow("lost acknowledgement");
    expect(await h.service.getSetupStatus(setup.id)).toMatchObject({ status: "started" });
  });

  it.each(["denied", "exchange"])("records %s failure without credentials or false completion", async failure => {
    const h = harness(); const setup = await h.setup(); const start = await h.service.startOAuthSetup({ setupSessionId: setup.id });
    if (failure === "exchange") h.fetch.mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(h.service.completeOAuth({ state: start.state, ...(failure === "denied" ? { error: "access_denied" } : { code: "code" }) })).rejects.toThrow();
    h.advance(600_000);
    expect(await h.service.getSetupStatus(setup.id)).toMatchObject({ status: "error" });
    expect(await h.store.listConnections()).toEqual([]);
  });

  it("does not mistake caller metadata for a setup completion reference", async () => {
    const h = harness(); const setup = await h.setup();
    const request = { providerId: provider.id, redirectUri: "https://host.example/callback",
      setupSessionRef: setup.id, authorizationExpiresAt: "2099-01-01T00:00:00Z",
      metadata: { setupSessionRef: setup.id, __polpoSetupTokenHash: setup.id } };
    const start = await h.service.startOAuth(request);
    expect((await h.store.getOAuthState(start.state))?.setupSessionRef).toBeUndefined();
    expect(start.expiresAt).not.toBe(request.authorizationExpiresAt);
    await h.service.completeOAuth({ state: start.state, code: "code" });
    expect(await h.service.getSetupStatus(setup.id)).toMatchObject({ status: "pending" });
  });

  it("recovers a receipt write that committed but lost its acknowledgement", async () => {
    const h = harness(); const setup = await h.setup(); const start = await h.service.startOAuthSetup({ setupSessionId: setup.id });
    const finish = h.store.finishConnectionSetupSession.bind(h.store);
    vi.spyOn(h.store, "finishConnectionSetupSession").mockImplementationOnce(async (...args) => { await finish(...args); throw new Error("receipt acknowledgement lost"); });
    const connection = await h.service.completeOAuth({ state: start.state, code: "code" });
    expect(await h.service.getSetupStatus(setup.id)).toMatchObject({ status: "completed", resultingConnectionId: connection.id });
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it("recovers committed account and link from a fresh service after receipt storage becomes available", async () => {
    const h = harness(); const setup = await h.setup(); const start = await h.service.startOAuthSetup({ setupSessionId: setup.id });
    const finish = vi.spyOn(h.store, "finishConnectionSetupSession").mockRejectedValue(new Error("receipt unavailable"));
    const reconcile = vi.spyOn(h.store, "reconcileConnectionSetupSession").mockRejectedValue(new Error("storage unavailable"));
    await expect(h.service.completeOAuth({ state: start.state, code: "code" })).rejects.toThrow("receipt unavailable");
    const [connection] = await h.store.listConnections();
    expect(connection.status).toBe("active");
    expect(await h.secrets.getSecret(connection.secretRef!)).toMatchObject({ kind: "oauth2" });
    finish.mockRestore(); reconcile.mockRestore(); h.advance(600_000);
    const results = await Promise.all([h.createService(), h.createService()].map(service => service.getSetupStatus(setup.id)));
    expect(results.every(result => result?.status === "completed" && result.resultingConnectionId === connection.id)).toBe(true);
    expect(JSON.stringify(results)).not.toMatch(/completionIntent|authorizationFingerprint|secretRef/);
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it("confirms an intent whose write committed but lost its acknowledgement before saving the account", async () => {
    const h = harness(); const setup = await h.setup(); const start = await h.service.startOAuthSetup({ setupSessionId: setup.id });
    const prepare = h.store.prepareConnectionSetupCompletion.bind(h.store);
    vi.spyOn(h.store, "prepareConnectionSetupCompletion").mockImplementationOnce(async (...args) => { await prepare(...args); throw new Error("lost intent acknowledgement"); });
    const connection = await h.service.completeOAuth({ state: start.state, code: "code" });
    expect(await h.service.getSetupStatus(setup.id)).toMatchObject({ status: "completed", resultingConnectionId: connection.id });
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not persist an account or link without a confirmed recovery intent", async () => {
    const h = harness(); const setup = await h.setup(); const start = await h.service.startOAuthSetup({ setupSessionId: setup.id });
    vi.spyOn(h.store, "prepareConnectionSetupCompletion").mockRejectedValue(new Error("intent unavailable"));
    const write = vi.spyOn(h.store, "upsertConnection");
    await expect(h.service.completeOAuth({ state: start.state, code: "code" })).rejects.toThrow("intent unavailable");
    expect(write).not.toHaveBeenCalled();
    expect(await h.store.listConnectionLinks()).toEqual([]);
    expect(await h.service.getSetupStatus(setup.id)).toMatchObject({ status: "error" });
  });

  it("recovers via status after the project link commits but loses its acknowledgement", async () => {
    const h = harness(); const setup = await h.setup(); const start = await h.service.startOAuthSetup({ setupSessionId: setup.id });
    const write = h.store.upsertConnectionLink.bind(h.store);
    vi.spyOn(h.store, "upsertConnectionLink").mockImplementationOnce(async link => { await write(link); throw new Error("lost link acknowledgement"); });
    await expect(h.service.completeOAuth({ state: start.state, code: "code" })).rejects.toThrow("lost link acknowledgement");
    const secretWrite = vi.spyOn(h.secrets, "setSecret");
    expect(await h.createService().getSetupStatus(setup.id)).toMatchObject({ status: "completed" });
    expect(secretWrite).not.toHaveBeenCalled();
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["generation", "binding", "scopes", "owner", "missing-link", "revoked-link", "revoked-account", "deleted-account"])("refuses receipt recovery for changed %s", async change => {
    const h = harness(); const setup = await h.setup(); const start = await h.service.startOAuthSetup({ setupSessionId: setup.id });
    const finish = vi.spyOn(h.store, "finishConnectionSetupSession").mockRejectedValue(new Error("receipt unavailable"));
    const reconcile = vi.spyOn(h.store, "reconcileConnectionSetupSession").mockRejectedValue(new Error("storage unavailable"));
    await expect(h.service.completeOAuth({ state: start.state, code: "code" })).rejects.toThrow();
    finish.mockRestore(); reconcile.mockRestore();
    const [connection] = await h.store.listConnections();
    if (change === "generation") await h.store.updateConnection(connection.id, { credentialVersion: "different" });
    if (change === "binding") await h.store.updateConnection(connection.id, { binding: { scopeEpoch: "different" } });
    if (change === "scopes") await h.store.updateConnection(connection.id, { grantedScopes: ["write"] });
    if (change === "owner") await h.store.updateConnection(connection.id, { owner: { type: "external_user", namespace: "other", id: "private-owner" } });
    if (change === "revoked-account") await h.store.updateConnection(connection.id, { status: "revoked" });
    if (change === "deleted-account") await h.store.deleteConnection(connection.id);
    const [link] = await h.store.listConnectionLinks({ connectionId: connection.id });
    if (change === "missing-link") await h.store.updateConnectionLink(link.id, { projectId: "other" });
    if (change === "revoked-link") await h.store.updateConnectionLink(link.id, { status: "revoked" });
    expect(await h.createService().getSetupStatus(setup.id)).toMatchObject({ status: "started" });
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });
});
