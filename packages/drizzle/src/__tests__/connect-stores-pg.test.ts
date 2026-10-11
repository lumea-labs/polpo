import { mcpSetupCommitContract, mcpSetupFixture } from "./helpers/mcp-setup-commit-contract.js";
import { mcpCommitContract } from "./helpers/mcp-commit-contract.js";
import { refreshLineageContract } from "./helpers/refresh-lineage-contract.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { connectRecordsPg, createPgConnectStores, ensureConnectSchema } from "../connect/index.js";
import { snapshotOAuthReconnect, type ConnectionRecord, type ConnectionSetupSession } from "@polpo-ai/connect";

const databaseUrl = process.env.CONNECT_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("PostgreSQL Connect persistence", () => {
  const namespace = `connect-test-${randomUUID()}`;
  const client = postgres(databaseUrl!, { max: 4 });
  const db = drizzle(client);
  const options = { namespace, encryptionKey: randomBytes(32) };
  const first = createPgConnectStores(db, options), second = createPgConnectStores(db, options);
  mcpCommitContract(async () => ({ first, second }));
  mcpSetupCommitContract(async () => ({ first, second }));
  refreshLineageContract(async () => ({ first, second }));
  beforeAll(async () => { await ensureConnectSchema(db, "pg"); });
  afterAll(async () => {
    await db.delete(connectRecordsPg).where(eq(connectRecordsPg.namespace, namespace));
    await client.end();
  });

  it.each(["activate", "deny"] as const)("rejects embedded %s after lease expires while waiting for the setup row lock", async operation => {
    const f = mcpSetupFixture(`setup-lock-${operation}`);
    await first.saveConnectionSetupSession(f.setup); await first.saveOAuthState(f.state);
    await first.claimOAuthState(f.state.state, "lease", new Date(Date.now() + 500).toISOString(), f.input.now);
    let pending: Promise<unknown> | undefined;
    await client.begin(async tx => {
      await tx.unsafe("SELECT id FROM connect_records WHERE namespace = $1 AND kind = 'setup' AND id = $2 FOR UPDATE", [namespace, f.setup.id]);
      pending = operation === "activate" ? first.commitMcpOAuthSetup(f.input) : first.failMcpOAuthSetup(f.input);
      await new Promise(resolve => setTimeout(resolve, 750));
    });
    expect(await pending).toBeNull();
    expect(await first.getConnection(f.input.connection.id)).toBeNull();
    expect(await first.getConnectionLink(f.input.link.id)).toBeNull();
    expect(await first.getConnectionSetupSession(f.setup.id)).toMatchObject({ status: "started" });
    expect(await first.getOAuthState(f.state.state)).toMatchObject({ status: "processing" });
  });

  it("rolls back the whole embedded activation when its last link insert fails", async () => {
    const f = mcpSetupFixture("pg-link-rollback");
    await first.saveConnectionSetupSession(f.setup); await first.saveOAuthState(f.state);
    await first.claimOAuthState(f.state.state, "lease", f.state.expiresAt, f.input.now);
    const trigger = `reject_embedded_${randomUUID().replaceAll("-", "")}`;
    await client.unsafe(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.kind = 'link' AND NEW.id = 'embedded-link-pg-link-rollback' THEN RAISE EXCEPTION 'injected link failure'; END IF; RETURN NEW; END $$`);
    try {
      await client.unsafe(`CREATE TRIGGER ${trigger} BEFORE INSERT ON connect_records FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);
      await expect(first.commitMcpOAuthSetup(f.input).catch(error => { throw error.cause ?? error; })).rejects.toThrow("injected link failure");
    } finally {
      await client.unsafe(`DROP TRIGGER IF EXISTS ${trigger} ON connect_records`);
      await client.unsafe(`DROP FUNCTION ${trigger}()`);
    }
    expect(await first.getConnection(f.input.connection.id)).toBeNull();
    expect(await first.getConnectionLink(f.input.link.id)).toBeNull();
    expect(await first.getConnectionSetupSession(f.setup.id)).toMatchObject({ status: "started" });
    expect(await first.getOAuthState(f.state.state)).toMatchObject({ status: "processing", claimToken: "lease" });
  });

  it("rejects a callback lease that expires while waiting for a PostgreSQL row lock", async () => {
    const now = new Date().toISOString();
    const account: ConnectionRecord = { id: "lock-account", providerId: "mcp_url", authType: "mcp", status: "active",
      credentialVersion: "generation", secretRef: "lock-secret", grantedScopes: [], createdAt: now, updatedAt: now,
      metadata: { auth: "oauth2", url: "https://mcp.example/mcp", transport: "http", oauthClientMode: "dynamic" } };
    await first.saveOAuthState({ state: "lock-state", providerId: "mcp_url", flowKind: "mcp", status: "pending", requestedScopes: [],
      temporarySecretRef: account.secretRef, metadata: { ...account.metadata, pendingConnectionId: account.id },
      redirectUri: "https://host.example/callback", createdAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    await first.claimOAuthState("lock-state", "lease", new Date(Date.now() + 500).toISOString(), now);
    let pending: ReturnType<typeof first.commitMcpOAuthConnection> | undefined;
    await client.begin(async tx => {
      await tx.unsafe("SELECT id FROM connect_records WHERE namespace = $1 AND kind = 'oauth_state' AND id = 'lock-state' FOR UPDATE", [namespace]);
      pending = first.commitMcpOAuthConnection({ state: "lock-state", claimToken: "lease", now, connection: account });
      await new Promise(resolve => setTimeout(resolve, 750));
    });
    expect(await pending).toBeNull();
    expect(await second.getConnection(account.id)).toBeNull();
    expect((await second.getOAuthState("lock-state"))?.status).toBe("processing");
  });

  it("atomically consumes setup and state and elects one credential writer across independent adapters", async () => {
    const setup: ConnectionSetupSession = {
      id: "setup", providerId: "gmail", oauthClientId: "client", projectId: "project", audience: "shared",
      subject: { type: "project", id: "project" }, scopes: [], returnUrl: "https://app.example/connected",
      createdAt: "2026-10-10T00:00:00Z", expiresAt: "2026-10-10T00:10:00Z",
    };
    await first.saveConnectionSetupSession(setup);
    const starts = await Promise.all([first, second].map(store => store.consumeConnectionSetupSession("setup", setup.createdAt)));
    expect(starts.filter(Boolean)).toHaveLength(1);
    await first.saveOAuthState({ state: "state", providerId: "gmail", requestedScopes: [], redirectUri: "https://host.example/callback",
      codeVerifier: "fixture-private-verifier", createdAt: setup.createdAt, expiresAt: setup.expiresAt });
    const callbacks = await Promise.all([first, second].map(store => store.consumeOAuthState("state")));
    expect(callbacks.filter(Boolean)).toHaveLength(1);
    await first.setSecret("secret", { kind: "api_key", apiKey: "fixture-private-key" });
    const snapshot = await second.getVersioned("secret");
    const writes = await Promise.all([first, second].map(store => store.compareAndSet("secret", snapshot!.version, { kind: "api_key", apiKey: "rotated" })));
    expect(writes.filter(Boolean)).toHaveLength(1);
    expect(await second.getSecret("secret")).toEqual({ kind: "api_key", apiKey: "rotated" });
    const rows = await db.select().from(connectRecordsPg).where(eq(connectRecordsPg.namespace, namespace));
    expect(JSON.stringify(rows)).not.toContain("fixture-private");
  });

  it("arbitrates setup cancellation and start, enforces expiration, and retains terminal receipts", async () => {
    const setup: ConnectionSetupSession = {
      id: "lifecycle-race", providerId: "gmail", oauthClientId: "client", projectId: "project", audience: "shared",
      subject: { type: "project", id: "project" }, scopes: [], returnUrl: "https://app.example/connected",
      createdAt: "2026-10-10T00:00:00Z", expiresAt: "2026-10-10T00:10:00Z",
    };
    await first.saveConnectionSetupSession(setup);
    const race = await Promise.all([
      first.consumeConnectionSetupSession(setup.id, setup.createdAt),
      second.cancelConnectionSetupSession(setup.id, setup.createdAt),
    ]);
    expect(race.filter(Boolean)).toHaveLength(1);
    await first.saveConnectionSetupSession({ ...setup, id: "lifecycle-complete" });
    const started = await second.consumeConnectionSetupSession("lifecycle-complete", setup.createdAt, "2026-10-10T00:20:00Z");
    expect(started?.consumedAt).toBeUndefined();
    expect(await first.getConnectionSetupSession("lifecycle-complete")).toMatchObject({ status: "started", authorizationExpiresAt: "2026-10-10T00:20:00Z" });
    expect(await first.finishConnectionSetupSession("lifecycle-complete", { status: "completed", connectionId: "account" }, setup.createdAt)).toMatchObject({ status: "completed" });
    expect(await second.finishConnectionSetupSession("lifecycle-complete", { status: "error" }, setup.createdAt)).toBeNull();
    expect(await second.finishConnectionSetupSession("lifecycle-complete", { status: "completed", connectionId: "another" }, setup.createdAt)).toBeNull();
    await first.saveConnectionSetupSession({ ...setup, id: "lifecycle-expired" });
    expect(await second.consumeConnectionSetupSession("lifecycle-expired", setup.expiresAt)).toBeNull();
    expect(await second.cancelConnectionSetupSession("lifecycle-expired", setup.expiresAt)).toBeNull();
  });

  it("recovers a pinned setup across adapters only after its exact active link exists", async () => {
    const timestamp = "2026-10-10T00:00:00Z";
    const setup: ConnectionSetupSession = { id: "receipt-recovery", providerId: "gmail", oauthClientId: "client", projectId: "project", audience: "shared",
      subject: { type: "project", id: "project" }, scopes: [], returnUrl: "https://app.example/connected",
      createdAt: timestamp, expiresAt: "2026-10-10T00:10:00Z" };
    const account: ConnectionRecord = { id: "receipt-account", providerId: "gmail", authType: "oauth2", status: "active", grantedScopes: [],
      credentialVersion: "original", secretRef: "receipt-secret", createdAt: timestamp, updatedAt: timestamp };
    const link = { id: "receipt-link", connectionId: account.id, projectId: setup.projectId, status: "active" as const, createdAt: timestamp, updatedAt: timestamp };
    await first.saveConnectionSetupSession(setup);
    await first.consumeConnectionSetupSession(setup.id, timestamp);
    const intent = { connection: snapshotOAuthReconnect(account), link: { id: link.id, connectionId: account.id, projectId: setup.projectId } };
    expect(await first.prepareConnectionSetupCompletion(setup.id, intent)).not.toBeNull();
    expect(await second.prepareConnectionSetupCompletion(setup.id, { ...intent, connection: { ...intent.connection, authorizationFingerprint: "forged" } })).toBeNull();
    await first.upsertConnection(account);
    expect(await second.reconcileConnectionSetupSession(setup.id)).toMatchObject({ status: "started" });
    await first.upsertConnectionLink({ ...link, status: "revoked" });
    expect(await second.reconcileConnectionSetupSession(setup.id)).toMatchObject({ status: "started" });
    await first.upsertConnectionLink(link);
    const recovered = await Promise.all([first, second].map(store => store.reconcileConnectionSetupSession(setup.id)));
    expect(recovered.every(result => result?.status === "completed" && result.resultingConnectionId === account.id)).toBe(true);
  });

  it("keeps immutable definitions unique and merges concurrent Connection patches", async () => {
    const record = { createdAt: "2026-10-10T00:00:00Z", definition: {
      version: 2 as const, id: "api", name: "API", source: "custom" as const, protocol: "http_api" as const,
      defaultAuthenticationId: "public", authentication: [{ id: "public", type: "none" as const }], http: { origins: ["https://api.example"] },
    } };
    const creates = await Promise.allSettled([first, second].map(store => store.createConnectorDefinition(record)));
    expect(creates.filter(result => result.status === "fulfilled")).toHaveLength(1);
    await first.upsertConnection({ id: "account", providerId: "api", authType: "none", status: "active", grantedScopes: [],
      createdAt: record.createdAt, updatedAt: record.createdAt });
    await Promise.all([
      first.updateConnection("account", { status: "revoked" }),
      second.updateConnection("account", { providerAccountId: "identity" }),
    ]);
    expect(await first.getConnection("account")).toMatchObject({ status: "revoked", providerAccountId: "identity" });
  });

  it("elects one reconnect generation across independent adapters and refuses a concurrent revoke", async () => {
    const connection: ConnectionRecord = { id: "oauth-account", providerId: "gmail", authenticationId: "oauth", authType: "oauth2", status: "active",
      grantedScopes: ["read"], credentialVersion: "old-generation", secretRef: "old-secret", oauthClientId: "app", oauthClientFingerprint: "app-policy",
      oauthIdentity: { issuer: "https://auth.example", subject: "stable-subject", policyFingerprint: "identity-policy", verifiedAt: "2026-10-10T00:00:00Z" },
      createdAt: "2026-10-10T00:00:00Z", updatedAt: "2026-10-10T00:00:00Z" };
    await first.upsertConnection(connection);
    const expected = snapshotOAuthReconnect(connection);
    const replacement = { secretRef: "new-secret", credentialVersion: "new-generation", grantedScopes: ["read"],
      oauthClientFingerprint: "app-policy", oauthIdentity: connection.oauthIdentity!, updatedAt: connection.updatedAt };
    const attempts = await Promise.all([first, second].map(s => s.replaceOAuthCredential(expected, replacement)));
    expect(attempts.filter(Boolean)).toHaveLength(1);
    const current = (await first.getConnection(connection.id))!;
    expect(current).toEqual({ ...connection, ...replacement });
    await second.updateConnection(connection.id, { status: "revoked", secretRef: undefined });
    expect(await first.replaceOAuthCredential(snapshotOAuthReconnect(current), replacement)).toBeNull();
    expect((await first.getConnection(connection.id))?.status).toBe("revoked");
  });
});
