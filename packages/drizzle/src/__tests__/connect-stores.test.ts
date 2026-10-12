import { mcpSetupCommitContract, mcpSetupFixture } from "./helpers/mcp-setup-commit-contract.js";
import { mcpCommitContract } from "./helpers/mcp-commit-contract.js";
import { refreshLineageContract } from "./helpers/refresh-lineage-contract.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { ConnectionRecord, ConnectionSetupSession, OAuthStateRecord } from "@polpo-ai/connect";
import { snapshotOAuthReconnect } from "@polpo-ai/connect";
import { createSqliteConnectStores, ensureConnectSchema } from "../connect/index.js";

const opened: InstanceType<typeof Database>[] = [];
const directories: string[] = [];
const key = randomBytes(32);
async function harness(path = ":memory:", namespace = "operator") {
  const sqlite = new Database(path); opened.push(sqlite);
  const db = drizzle(sqlite);
  await ensureConnectSchema(db, "sqlite");
  return { sqlite, db, store: createSqliteConnectStores(db, { namespace, encryptionKey: key }) };
}
afterEach(() => {
  for (const db of opened.splice(0)) if (db.open) db.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const connection: ConnectionRecord = {
  id: "connection-1", providerId: "contacts", authenticationId: "key", credentialVersion: "generation-1",
  authType: "api_key", status: "active", grantedScopes: ["read"], secretRef: "secret-1",
  createdAt: "2026-10-10T00:00:00Z", updatedAt: "2026-10-10T00:00:00Z",
};
const setup: ConnectionSetupSession = {
  id: "setup-1", providerId: "contacts", authenticationId: "oauth", oauthClientId: "app-1", projectId: "project-1",
  audience: "end_user", subject: { type: "external_user", namespace: "app", id: "gioia" }, scopes: ["read"],
  returnUrl: "https://app.example/connected", expiresAt: "2026-10-10T00:10:00Z", createdAt: "2026-10-10T00:00:00Z",
};

describe("durable Connect stores", () => {
  refreshLineageContract(async () => {
    const dir = mkdtempSync(join(tmpdir(), "connect-refresh-")); directories.push(dir);
    const path = join(dir, "refresh.sqlite");
    return { first: (await harness(path)).store, second: (await harness(path)).store };
  });
  mcpCommitContract(async () => {
    const { store, db } = await harness();
    return { first: store, second: createSqliteConnectStores(db, { namespace: "operator", encryptionKey: key }) };
  });
  mcpSetupCommitContract(async () => {
    const { store, db } = await harness();
    return { first: store, second: createSqliteConnectStores(db, { namespace: "operator", encryptionKey: key }) };
  });
  it("rolls back all four embedded rows when the final project link insert fails", async () => {
    const { store, sqlite } = await harness(), f = mcpSetupFixture("link-rollback");
    await store.saveConnectionSetupSession(f.setup); await store.saveOAuthState(f.state);
    await store.claimOAuthState(f.state.state, "lease", f.state.expiresAt, f.input.now);
    sqlite.exec("CREATE TRIGGER reject_link BEFORE INSERT ON connect_records WHEN NEW.kind = 'link' BEGIN SELECT RAISE(ABORT, 'injected link failure'); END;");
    await expect(store.commitMcpOAuthSetup(f.input)).rejects.toThrow("injected link failure");
    expect(await store.getConnection(f.input.connection.id)).toBeNull();
    expect(await store.getConnectionLink(f.input.link.id)).toBeNull();
    expect(await store.getConnectionSetupSession(f.setup.id)).toMatchObject({ status: "started" });
    expect(await store.getOAuthState(f.state.state)).toMatchObject({ status: "processing", claimToken: "lease" });
  });
  it.each(["expired_wait", "insert_error"])("keeps SQLite activation atomic during %s", async failure => {
    const { store, db, sqlite } = await harness();
    const now = new Date().toISOString();
    const account: ConnectionRecord = { id: "atomic-account", providerId: "mcp_url", authType: "mcp", status: "active",
      credentialVersion: "generation", secretRef: "atomic-secret", grantedScopes: [], createdAt: now, updatedAt: now,
      metadata: { auth: "oauth2", url: "https://mcp.example/mcp", transport: "http", oauthClientMode: "dynamic" } };
    await store.saveOAuthState({ state: "atomic-state", providerId: "mcp_url", flowKind: "mcp", status: "pending", requestedScopes: [],
      temporarySecretRef: account.secretRef, metadata: { ...account.metadata, pendingConnectionId: account.id },
      redirectUri: "https://host.example/callback", createdAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    await store.claimOAuthState("atomic-state", "lease", new Date(Date.now() + 200).toISOString(), now);
    if (failure === "expired_wait") {
      const all = db.all.bind(db);
      // The adapter also accepts asynchronous SQLite drivers. Inject I/O wait
      // without changing the real SQLite statement or result.
      vi.spyOn(db, "all").mockImplementationOnce((async (query: Parameters<typeof db.all>[0]) => {
        await new Promise(resolve => setTimeout(resolve, 300));
        return all(query);
      }) as unknown as typeof db.all);
      expect(await store.commitMcpOAuthConnection({ state: "atomic-state", claimToken: "lease", now, connection: account })).toBeNull();
    } else {
      sqlite.exec("CREATE TRIGGER reject_mcp BEFORE INSERT ON connect_records WHEN NEW.kind = 'connection' BEGIN SELECT RAISE(ABORT, 'injected account failure'); END;");
      await expect(store.commitMcpOAuthConnection({ state: "atomic-state", claimToken: "lease", now, connection: account })).rejects.toThrow("injected account failure");
    }
    expect(await store.getConnection(account.id)).toBeNull();
    expect((await store.getOAuthState("atomic-state"))?.status).toBe("processing");
  });

  it("survives restart and encrypts credentials, OAuth state and account metadata at rest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polpo-connect-")); directories.push(dir);
    const path = join(dir, "connect.sqlite");
    const first = await harness(path);
    await first.store.upsertConnection({ ...connection, metadata: { private: "private-account-metadata" } });
    await first.store.setSecret("secret-1", { kind: "api_key", apiKey: "private-api-key" });
    await first.store.saveOAuthState({ state: "state-1", providerId: "contacts", requestedScopes: [], redirectUri: "https://host.example/callback",
      codeVerifier: "private-code-verifier", createdAt: setup.createdAt, expiresAt: setup.expiresAt });
    const raw = JSON.stringify(first.sqlite.prepare("select * from connect_records").all());
    for (const value of ["private-api-key", "private-account-metadata", "private-code-verifier"]) expect(raw).not.toContain(value);
    first.sqlite.close();
    const restarted = await harness(path);
    expect(await restarted.store.getConnection(connection.id)).toMatchObject(connection);
    expect(await restarted.store.getSecret("secret-1")).toEqual({ kind: "api_key", apiKey: "private-api-key" });
    expect(await restarted.store.consumeOAuthState("state-1")).toMatchObject({ codeVerifier: "private-code-verifier" });
    expect(await restarted.store.consumeOAuthState("state-1")).toBeNull();
  });

  it("isolates all records by the trusted host namespace and detects ciphertext swaps", async () => {
    const { db, store, sqlite } = await harness();
    await store.setSecret("one", { kind: "api_key", apiKey: "one" });
    await store.setSecret("two", { kind: "api_key", apiKey: "two" });
    const other = createSqliteConnectStores(db, { namespace: "other", encryptionKey: key });
    expect(await other.getSecret("one")).toBeNull();
    expect(await other.listConnections()).toEqual([]);
    sqlite.prepare("update connect_records set payload = (select payload from connect_records where id = 'one') where id = 'two'").run();
    await expect(store.getSecret("two")).rejects.toThrow("Connect storage could not be decrypted");
  });

  it("uses atomic secret generations across replicas, including delete and recreation", async () => {
    const { db, store } = await harness();
    const replica = createSqliteConnectStores(db, { namespace: "operator", encryptionKey: key });
    await store.setSecret("secret", { kind: "api_key", apiKey: "first" });
    const snapshot = await store.getVersioned("secret");
    const winners = await Promise.all([store, replica].map(s => s.compareAndSet("secret", snapshot!.version, { kind: "api_key", apiKey: "next" })));
    expect(winners.filter(Boolean)).toHaveLength(1);
    await replica.deleteSecret("secret");
    await replica.setSecret("secret", { kind: "api_key", apiKey: "replacement" });
    expect(await store.compareAndSet("secret", snapshot!.version, { kind: "api_key", apiKey: "stale" })).toBe(false);
  });

  it("consumes a setup session once and preserves a concurrent revoke when applying metadata", async () => {
    const { store, db } = await harness();
    const replica = createSqliteConnectStores(db, { namespace: "operator", encryptionKey: key });
    await store.saveConnectionSetupSession(setup);
    const attempts = await Promise.all([store, replica].map(s => s.consumeConnectionSetupSession(setup.id, setup.createdAt)));
    expect(attempts.filter(Boolean)).toHaveLength(1);
    await store.upsertConnection(connection);
    await Promise.all([
      store.updateConnection(connection.id, { status: "revoked", secretRef: undefined }),
      replica.updateConnection(connection.id, { providerAccountId: "account-1" }),
    ]);
    expect(await store.getConnection(connection.id)).toMatchObject({ status: "revoked", providerAccountId: "account-1" });
    expect((await store.getConnection(connection.id))?.secretRef).toBeUndefined();
  });

  it("arbitrates setup start/cancel across replicas and preserves terminal receipts", async () => {
    const { store, db } = await harness();
    const replica = createSqliteConnectStores(db, { namespace: "operator", encryptionKey: key });
    await store.saveConnectionSetupSession(setup);
    const outcomes = await Promise.all([
      store.consumeConnectionSetupSession(setup.id, setup.createdAt, "2026-10-10T00:20:00Z"),
      replica.cancelConnectionSetupSession(setup.id, setup.createdAt),
    ]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    const result = await store.getConnectionSetupSession(setup.id);
    if (result?.status === "started") {
      expect(result.authorizationExpiresAt).toBe("2026-10-10T00:20:00Z");
      expect(await store.finishConnectionSetupSession(setup.id, { status: "completed", connectionId: "connection" }, setup.createdAt)).toMatchObject({ status: "completed" });
      expect(await replica.finishConnectionSetupSession(setup.id, { status: "error" }, setup.createdAt)).toBeNull();
      expect(await replica.finishConnectionSetupSession(setup.id, { status: "completed", connectionId: "other" }, setup.createdAt)).toBeNull();
      expect(await replica.getConnectionSetupSession(setup.id)).toMatchObject({ status: "completed", resultingConnectionId: "connection" });
    } else {
      expect(result?.status).toBe("cancelled");
      expect(await store.consumeConnectionSetupSession(setup.id, setup.createdAt)).toBeNull();
    }
    await store.saveConnectionSetupSession({ ...setup, id: "expired" });
    expect(await replica.consumeConnectionSetupSession("expired", setup.expiresAt)).toBeNull();
    expect(await replica.cancelConnectionSetupSession("expired", setup.expiresAt)).toBeNull();
  });

  it("recovers an exact completed setup after a database restart without recreating missing links", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polpo-setup-")); directories.push(dir);
    const path = join(dir, "connect.sqlite");
    const first = await harness(path);
    await first.store.saveConnectionSetupSession(setup);
    await first.store.consumeConnectionSetupSession(setup.id, setup.createdAt);
    const account: ConnectionRecord = { ...connection, authType: "oauth2", authenticationId: "oauth" };
    const link = { id: "recovery-link", connectionId: account.id, projectId: setup.projectId, status: "active" as const,
      createdAt: setup.createdAt, updatedAt: setup.createdAt };
    const intent = { connection: snapshotOAuthReconnect(account), link: { id: link.id, connectionId: account.id, projectId: link.projectId } };
    expect(await first.store.prepareConnectionSetupCompletion(setup.id, intent)).not.toBeNull();
    expect(await first.store.prepareConnectionSetupCompletion(setup.id, { ...intent, link: { ...intent.link, id: "other" } })).toBeNull();
    await first.store.upsertConnection(account);
    expect(await first.store.reconcileConnectionSetupSession(setup.id)).toMatchObject({ status: "started" });
    expect(await first.store.listConnectionLinks()).toEqual([]);
    await first.store.upsertConnectionLink(link);
    first.sqlite.close();
    const restarted = await harness(path);
    const replica = createSqliteConnectStores(restarted.db, { namespace: "operator", encryptionKey: key });
    const results = await Promise.all([restarted.store, replica].map(store => store.reconcileConnectionSetupSession(setup.id)));
    expect(results.every(result => result?.status === "completed" && result.resultingConnectionId === account.id)).toBe(true);
    expect(JSON.stringify(restarted.sqlite.prepare("select * from connect_records").all())).not.toContain("authorizationFingerprint");
  });

  it("claims MCP callbacks atomically, rejects stale claims and permits an expired lease to be reclaimed", async () => {
    const { store } = await harness();
    const state: OAuthStateRecord = { state: "state", providerId: "mcp_url", flowKind: "mcp", status: "pending",
      requestedScopes: [], redirectUri: "https://host.example/callback", createdAt: setup.createdAt, expiresAt: setup.expiresAt };
    await store.saveOAuthState(state);
    const claims = await Promise.all(["a", "b"].map(token => store.claimOAuthState("state", token, "2026-10-10T00:01:00Z", setup.createdAt)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await store.claimOAuthState("state", "new", "2026-10-10T00:03:00Z", "2026-10-10T00:02:00Z")).toMatchObject({ claimToken: "new" });
    expect(await store.completeOAuthState("state", "a", "wrong")).toBeNull();
    expect(await store.completeOAuthState("state", "new", "right")).toMatchObject({ status: "completed", completedConnectionId: "right" });
    expect(await store.releaseOAuthState("state", "new", "failure")).toBeNull();
  });

  it("rotates the same OAuth identity once across replicas without copying links or resurrecting revoked records", async () => {
    const { store, db } = await harness();
    const replica = createSqliteConnectStores(db, { namespace: "operator", encryptionKey: key });
    const original: ConnectionRecord = { ...connection, authType: "oauth2", authenticationId: "oauth", audience: "shared",
      oauthClientId: "app", oauthClientFingerprint: "app-policy", owner: { type: "project", id: "project" },
      oauthIdentity: { issuer: "https://auth.example", subject: "stable-subject", policyFingerprint: "identity-policy", verifiedAt: connection.createdAt } };
    await store.upsertConnection(original);
    const link = { id: "link", connectionId: original.id, projectId: "project", status: "active" as const, createdAt: connection.createdAt, updatedAt: connection.updatedAt };
    await store.upsertConnectionLink(link);
    const expected = snapshotOAuthReconnect(original);
    const replacement = { secretRef: "next-secret", credentialVersion: "next-generation", grantedScopes: ["read"],
      oauthClientFingerprint: "app-policy", oauthIdentity: original.oauthIdentity!, updatedAt: connection.updatedAt };
    const attempts = await Promise.all([store, replica].map(s => s.replaceOAuthCredential(expected, replacement)));
    expect(attempts.filter(Boolean)).toHaveLength(1);
    expect(await store.listConnections()).toEqual([{ ...original, ...replacement }]);
    expect(await store.listConnectionLinks()).toEqual([link]);
    const current = (await store.getConnection(original.id))!;
    await replica.updateConnection(original.id, { status: "revoked", secretRef: undefined });
    expect(await store.replaceOAuthCredential(snapshotOAuthReconnect(current), replacement)).toBeNull();
    expect(await store.getConnection(original.id)).toMatchObject({ status: "revoked" });
  });

  it("persists typed reconnect authority and identity-policy pinning independently of metadata", async () => {
    const { store } = await harness();
    const state: OAuthStateRecord = { state: "reconnect-state", providerId: "contacts", requestedScopes: ["read"], redirectUri: "https://host.example/callback",
      createdAt: setup.createdAt, expiresAt: setup.expiresAt, oauthIdentityPolicyFingerprint: "identity-policy",
      reconnect: { connectionId: "connection-1", authorizationFingerprint: "snapshot" } };
    await store.saveOAuthState(state);
    expect(await store.consumeOAuthState(state.state)).toEqual(state);
    await store.saveConnectionSetupSession({ ...setup, oauthIdentityPolicyFingerprint: "identity-policy" });
    expect(await store.getConnectionSetupSession(setup.id)).toMatchObject({ oauthIdentityPolicyFingerprint: "identity-policy" });
  });

  it("creates custom definitions once and cannot reuse a disabled identity", async () => {
    const { store } = await harness();
    const record = { createdAt: setup.createdAt, definition: {
      version: 2 as const, id: "public_api", name: "Public", source: "custom" as const, protocol: "http_api" as const,
      defaultAuthenticationId: "public", authentication: [{ id: "public", type: "none" as const }], http: { origins: ["https://api.example"] },
    } };
    const attempts = await Promise.allSettled([store.createConnectorDefinition(record), store.createConnectorDefinition(record)]);
    expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(1);
    await store.disableConnectorDefinition("public_api", setup.createdAt);
    await expect(store.createConnectorDefinition(record)).rejects.toMatchObject({ code: "invalid_provider" });
    expect(await store.listConnectorDefinitions()).toMatchObject([{ disabledAt: setup.createdAt }]);
  });
});
