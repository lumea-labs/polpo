import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { decrypt, encryptJson, resolveKey } from "@polpo-ai/vault-crypto";
import {
  ConnectError, normalizeConnectorDefinition, matchesOAuthReconnect,
  canCommitMcpOAuthConnection, completedMcpOAuthState, type McpOAuthConnectionCommit,
  canCommitMcpOAuthSetup, type McpOAuthSetupCommit,
  canFailMcpOAuthSetup, failedMcpOAuthState, type McpOAuthSetupFailure,
  canConsumeConnectionSetup, finishConnectionSetup, type ConnectionSetupOutcome,
  prepareConnectionSetupCompletion, reconcileConnectionSetup, type ConnectionSetupCompletionIntent,
  type OAuthReconnectSnapshot, type OAuthCredentialReplacement,
  type ConnectStore, type ConnectionRecord, type ConnectionListFilter,
  type ConnectionLink, type ConnectionLinkStore, type ConnectionLinkListFilter,
  type ConnectionSetupSession, type ConnectionSetupSessionStore, type OAuthStateRecord,
  type ConnectorDefinitionStore, type StoredConnectorDefinition,
  type ConnectionVerificationResult, type ConnectionVerificationStore, type StoredConnectionSecret,
} from "@polpo-ai/connect";
import type { VersionedConnectionSecretStore } from "@polpo-ai/connect-server";
import { connectRecordsSqlite } from "./schema.js";

export interface ConnectStorageOptions {
  /** Trusted operator/tenant partition, never derived from model arguments. */
  namespace: string;
  /** Defaults to the existing Polpo vault key resolver. Keep stable across restarts. */
  encryptionKey?: Buffer;
}

type Kind = "connection" | "secret" | "oauth_state" | "setup" | "link" | "definition" | "verification";
interface Row { namespace: string; kind: Kind; id: string; version: string; payload: string }

/**
 * Durable self-hosted Connect adapter for SQLite and PostgreSQL. Optimistic
 * updates and single-use consumption are database atomic across host processes.
 * Listings decrypt only the selected namespace/kind. Large managed inventories
 * may use an indexed normalized adapter implementing the same shared ports.
 */
export class DrizzleConnectStores implements ConnectStore, ConnectionLinkStore,
  ConnectionSetupSessionStore, ConnectorDefinitionStore, ConnectionVerificationStore,
  VersionedConnectionSecretStore {
  private readonly key: Buffer;
  private readonly namespace: string;

  constructor(private readonly db: any, private readonly table: any, options: ConnectStorageOptions) {
    if (!options.namespace.trim() || options.namespace.length > 256) throw new Error("Connect storage namespace is required");
    this.namespace = options.namespace;
    this.key = Buffer.from(options.encryptionKey ?? resolveKey());
    if (this.key.length !== 32) throw new Error("Connect storage encryption key must contain 32 bytes");
  }

  private where(kind: Kind, id?: string) {
    return and(eq(this.table.namespace, this.namespace), eq(this.table.kind, kind),
      id === undefined ? undefined : eq(this.table.id, id));
  }

  private encode(kind: Kind, id: string, value: unknown): Row {
    return { namespace: this.namespace, kind, id, version: randomUUID(),
      payload: encryptJson({ namespace: this.namespace, kind, id, value }, this.key) };
  }

  private decode<T>(row: Row): T {
    try {
      const envelope = JSON.parse(decrypt(Buffer.from(row.payload, "base64"), this.key).toString("utf8"));
      if (envelope.namespace !== this.namespace || envelope.kind !== row.kind || envelope.id !== row.id
        || !Object.hasOwn(envelope, "value")) throw new Error("Invalid envelope");
      return envelope.value as T;
    } catch {
      throw new Error("Connect storage could not be decrypted");
    }
  }

  private async snapshot<T>(kind: Kind, id: string): Promise<{ value: T; version: string } | null> {
    const [row]: Row[] = await this.db.select().from(this.table).where(this.where(kind, id)).limit(1);
    return row ? { value: this.decode<T>(row), version: row.version } : null;
  }

  private async get<T>(kind: Kind, id: string): Promise<T | null> {
    return (await this.snapshot<T>(kind, id))?.value ?? null;
  }

  private async list<T>(kind: Kind): Promise<T[]> {
    const rows: Row[] = await this.db.select().from(this.table).where(this.where(kind));
    return rows.map(row => this.decode<T>(row));
  }

  private async put<T>(kind: Kind, id: string, value: T): Promise<T> {
    const row = this.encode(kind, id, value);
    await this.db.insert(this.table).values(row).onConflictDoUpdate({
      target: [this.table.namespace, this.table.kind, this.table.id],
      set: { payload: row.payload, version: row.version },
    });
    return value;
  }

  private async cas<T>(kind: Kind, id: string, version: string, value: T): Promise<boolean> {
    const row = this.encode(kind, id, value);
    const rows = await this.db.update(this.table).set({ payload: row.payload, version: row.version })
      .where(and(this.where(kind, id), eq(this.table.version, version))).returning({ id: this.table.id });
    return rows.length === 1;
  }

  private async mutate<T>(kind: Kind, id: string, transform: (value: T | null) => T | null): Promise<T | null> {
    for (let attempt = 0; attempt < 16; attempt++) {
      const record = await this.snapshot<T>(kind, id);
      const next = transform(record?.value ?? null);
      if (next === null || !record) return null;
      if (await this.cas(kind, id, record.version, next)) return next;
    }
    throw new ConnectError("refresh_unavailable", "Connect storage remained busy during an atomic update");
  }

  async listConnections(filter: ConnectionListFilter = {}): Promise<ConnectionRecord[]> {
    return (await this.list<ConnectionRecord>("connection")).filter(value =>
      (!filter.providerId || value.providerId === filter.providerId)
      && (!filter.projectId || value.projectId === filter.projectId)
      && (!filter.orgId || value.orgId === filter.orgId)
      && (!filter.status || value.status === filter.status)
      && (!filter.owner || (value.owner?.type === filter.owner.type && value.owner.id === filter.owner.id
        && (filter.owner.type !== "external_user" || (value.owner.type === "external_user" && value.owner.namespace === filter.owner.namespace)))));
  }
  getConnection(id: string): Promise<ConnectionRecord | null> { return this.get("connection", id); }
  upsertConnection(record: ConnectionRecord): Promise<ConnectionRecord> { return this.put("connection", record.id, record); }
  async updateConnection(id: string, patch: Partial<Omit<ConnectionRecord, "id" | "createdAt">>): Promise<ConnectionRecord> {
    return (await this.mutate<ConnectionRecord>("connection", id, value => {
      if (!value) throw new ConnectError("connection_not_found", "Connection not found");
      return { ...value, ...patch, id, createdAt: value.createdAt };
    }))!;
  }
  async deleteConnection(id: string): Promise<void> { await this.db.delete(this.table).where(this.where("connection", id)); }

  async replaceOAuthCredential(expected: OAuthReconnectSnapshot, replacement: OAuthCredentialReplacement): Promise<ConnectionRecord | null> {
    const row = await this.snapshot<ConnectionRecord>("connection", expected.connectionId);
    if (!row || !matchesOAuthReconnect(row.value, expected)) return null;
    const next = { ...row.value, ...replacement };
    return await this.cas("connection", expected.connectionId, row.version, next) ? next : null;
  }

  async saveOAuthState(record: OAuthStateRecord): Promise<void> { await this.put("oauth_state", record.state, record); }
  getOAuthState(state: string): Promise<OAuthStateRecord | null> { return this.get("oauth_state", state); }
  async commitMcpOAuthConnection(input: McpOAuthConnectionCommit): Promise<ConnectionRecord | null> {
    const state = await this.snapshot<OAuthStateRecord>("oauth_state", input.state);
    if (!state || !canCommitMcpOAuthConnection(state.value, input)) return null;
    const receipt = this.encode("oauth_state", input.state, completedMcpOAuthState(state.value, input.connection.id));
    const account = this.encode("connection", input.connection.id, input.connection);
    if (this.table === connectRecordsSqlite) {
      // One SQLite statement holds the write lock for the predicate and both
      // rows. MATERIALIZED pins eligibility before replacing the state row.
      const rows = await this.db.all(sql`
        WITH eligible AS MATERIALIZED (
          SELECT 1 FROM ${this.table}
          WHERE namespace = ${this.namespace} AND kind = 'oauth_state' AND id = ${input.state}
            AND version = ${state.version}
            AND julianday('now') < julianday(${state.value.claimExpiresAt})
            AND julianday('now') < julianday(${state.value.expiresAt})
            AND NOT EXISTS (SELECT 1 FROM ${this.table} WHERE namespace = ${this.namespace}
              AND kind = 'connection' AND id = ${account.id})
        )
        INSERT INTO ${this.table} (namespace, kind, id, version, payload)
        SELECT ${this.namespace}, 'oauth_state', ${receipt.id}, ${receipt.version}, ${receipt.payload} FROM eligible
        UNION ALL
        SELECT ${this.namespace}, 'connection', ${account.id}, ${account.version}, ${account.payload} FROM eligible
        WHERE TRUE
        ON CONFLICT (namespace, kind, id) DO UPDATE SET version = excluded.version, payload = excluded.payload
        RETURNING kind, id
      `);
      return rows.some((row: { kind: string; id: string }) => row.kind === "connection" && row.id === account.id) ? input.connection : null;
    }
    // PostgreSQL's UPDATE rechecks version after any concurrent claim writer.
    // A conflicting account insert aborts the whole statement, including the
    // receipt. Do not use ON CONFLICT DO NOTHING here.
    const result = await this.db.execute(sql`
      WITH locked AS MATERIALIZED (
        SELECT id, version, ${state.value.claimExpiresAt}::timestamptz AS lease_deadline,
          ${state.value.expiresAt}::timestamptz AS authorization_deadline
        FROM ${this.table} WHERE namespace = ${this.namespace} AND kind = 'oauth_state'
          AND id = ${input.state} AND version = ${state.version} FOR UPDATE
      ), claimed AS (
        UPDATE ${this.table} SET version = ${receipt.version}, payload = ${receipt.payload}
        FROM locked
        WHERE namespace = ${this.namespace} AND kind = 'oauth_state' AND ${this.table}.id = locked.id
          AND ${this.table}.version = locked.version
          AND clock_timestamp() < locked.lease_deadline AND clock_timestamp() < locked.authorization_deadline
          AND NOT EXISTS (SELECT 1 FROM ${this.table} existing WHERE existing.namespace = ${this.namespace}
            AND existing.kind = 'connection' AND existing.id = ${account.id})
        RETURNING namespace
      )
      INSERT INTO ${this.table} (namespace, kind, id, version, payload)
      SELECT ${this.namespace}, 'connection', ${account.id}, ${account.version}, ${account.payload} FROM claimed
      RETURNING id
    `);
    const rows = result.rows ?? result;
    return rows.some((row: { id: string }) => row.id === account.id) ? input.connection : null;
  }

  async commitMcpOAuthSetup(input: McpOAuthSetupCommit): Promise<ConnectionRecord | null> {
    const [state, setup] = await Promise.all([
      this.snapshot<OAuthStateRecord>("oauth_state", input.state),
      this.snapshot<ConnectionSetupSession>("setup", input.setupReference),
    ]);
    if (!state || !setup || !canCommitMcpOAuthSetup(state.value, setup.value, input)) return null;
    const receipt = this.encode("oauth_state", input.state, completedMcpOAuthState(state.value, input.connection.id));
    const completedSetup = this.encode("setup", input.setupReference,
      finishConnectionSetup(setup.value, { status: "completed", connectionId: input.connection.id })!);
    const account = this.encode("connection", input.connection.id, input.connection);
    const link = this.encode("link", input.link.id, input.link);
    if (this.table === connectRecordsSqlite) {
      const rows = await this.db.all(sql`
        WITH eligible AS MATERIALIZED (
          SELECT 1 FROM ${this.table} state INNER JOIN ${this.table} setup ON setup.namespace = state.namespace
          WHERE state.namespace = ${this.namespace} AND state.kind = 'oauth_state' AND state.id = ${input.state}
            AND state.version = ${state.version} AND setup.kind = 'setup' AND setup.id = ${input.setupReference}
            AND setup.version = ${setup.version}
            AND julianday('now') < julianday(${state.value.claimExpiresAt})
            AND julianday('now') < julianday(${state.value.expiresAt})
            AND julianday('now') < julianday(${setup.value.authorizationExpiresAt})
            AND NOT EXISTS (SELECT 1 FROM ${this.table} existing WHERE existing.namespace = ${this.namespace}
              AND ((existing.kind = 'connection' AND existing.id = ${account.id}) OR (existing.kind = 'link' AND existing.id = ${link.id})))
        )
        INSERT INTO ${this.table} (namespace, kind, id, version, payload)
        SELECT ${this.namespace}, 'oauth_state', ${receipt.id}, ${receipt.version}, ${receipt.payload} FROM eligible
        UNION ALL SELECT ${this.namespace}, 'setup', ${completedSetup.id}, ${completedSetup.version}, ${completedSetup.payload} FROM eligible
        UNION ALL SELECT ${this.namespace}, 'connection', ${account.id}, ${account.version}, ${account.payload} FROM eligible
        UNION ALL SELECT ${this.namespace}, 'link', ${link.id}, ${link.version}, ${link.payload} FROM eligible WHERE TRUE
        ON CONFLICT (namespace, kind, id) DO UPDATE SET version = excluded.version, payload = excluded.payload
        RETURNING kind, id
      `);
      return rows.length === 4 ? input.connection : null;
    }
    // Lock both authority records before evaluating the clock. The following
    // UPDATE/INSERT chain is one statement: any failure rolls back all four rows.
    const result = await this.db.execute(sql`
      WITH locked_state AS MATERIALIZED (
        SELECT id, version, ${state.value.claimExpiresAt}::timestamptz AS lease_deadline,
          ${state.value.expiresAt}::timestamptz AS authorization_deadline
        FROM ${this.table} WHERE namespace = ${this.namespace} AND kind = 'oauth_state'
          AND id = ${input.state} AND version = ${state.version} FOR UPDATE
      ), locked_setup AS MATERIALIZED (
        SELECT setup.id, setup.version, ${setup.value.authorizationExpiresAt}::timestamptz AS deadline,
          locked_state.lease_deadline, locked_state.authorization_deadline
        FROM ${this.table} setup CROSS JOIN locked_state
        WHERE setup.namespace = ${this.namespace} AND setup.kind = 'setup'
          AND setup.id = ${input.setupReference} AND setup.version = ${setup.version} FOR UPDATE OF setup
      ), claimed AS (
        UPDATE ${this.table} SET version = ${receipt.version}, payload = ${receipt.payload}
        FROM locked_state, locked_setup
        WHERE namespace = ${this.namespace} AND kind = 'oauth_state' AND ${this.table}.id = locked_state.id
          AND ${this.table}.version = locked_state.version
          AND clock_timestamp() < locked_setup.lease_deadline AND clock_timestamp() < locked_setup.authorization_deadline
          AND clock_timestamp() < locked_setup.deadline
          AND NOT EXISTS (SELECT 1 FROM ${this.table} existing WHERE existing.namespace = ${this.namespace}
            AND ((existing.kind = 'connection' AND existing.id = ${account.id}) OR (existing.kind = 'link' AND existing.id = ${link.id})))
        RETURNING namespace
      ), completed_setup AS (
        UPDATE ${this.table} SET version = ${completedSetup.version}, payload = ${completedSetup.payload}
        WHERE namespace = ${this.namespace} AND kind = 'setup' AND id = ${input.setupReference}
          AND version = ${setup.version} AND EXISTS (SELECT 1 FROM claimed)
        RETURNING namespace
      ), inserted_account AS (
        INSERT INTO ${this.table} (namespace, kind, id, version, payload)
        SELECT ${this.namespace}, 'connection', ${account.id}, ${account.version}, ${account.payload} FROM completed_setup RETURNING namespace
      )
      INSERT INTO ${this.table} (namespace, kind, id, version, payload)
      SELECT ${this.namespace}, 'link', ${link.id}, ${link.version}, ${link.payload} FROM inserted_account RETURNING id
    `);
    const rows = result.rows ?? result;
    return rows.some((row: { id: string }) => row.id === link.id) ? input.connection : null;
  }
  async failMcpOAuthSetup(input: McpOAuthSetupFailure): Promise<ConnectionSetupSession | null> {
    const [state, setup] = await Promise.all([
      this.snapshot<OAuthStateRecord>("oauth_state", input.state),
      this.snapshot<ConnectionSetupSession>("setup", input.setupReference),
    ]);
    if (!state || !setup || !canFailMcpOAuthSetup(state.value, setup.value, input)) return null;
    const failed = finishConnectionSetup(setup.value, { status: "error" })!;
    const receipt = this.encode("oauth_state", input.state, failedMcpOAuthState(state.value));
    const failedSetup = this.encode("setup", input.setupReference, failed);
    if (this.table === connectRecordsSqlite) {
      const rows = await this.db.all(sql`
        WITH eligible AS MATERIALIZED (
          SELECT 1 FROM ${this.table} state INNER JOIN ${this.table} setup ON setup.namespace = state.namespace
          WHERE state.namespace = ${this.namespace} AND state.kind = 'oauth_state' AND state.id = ${input.state}
            AND state.version = ${state.version} AND setup.kind = 'setup' AND setup.id = ${input.setupReference}
            AND setup.version = ${setup.version}
            AND julianday('now') < julianday(${state.value.claimExpiresAt})
            AND julianday('now') < julianday(${state.value.expiresAt})
            AND julianday('now') < julianday(${setup.value.authorizationExpiresAt})
        )
        INSERT INTO ${this.table} (namespace, kind, id, version, payload)
        SELECT ${this.namespace}, 'oauth_state', ${receipt.id}, ${receipt.version}, ${receipt.payload} FROM eligible
        UNION ALL SELECT ${this.namespace}, 'setup', ${failedSetup.id}, ${failedSetup.version}, ${failedSetup.payload} FROM eligible WHERE TRUE
        ON CONFLICT (namespace, kind, id) DO UPDATE SET version = excluded.version, payload = excluded.payload
        RETURNING id
      `);
      return rows.length === 2 ? failed : null;
    }
    const result = await this.db.execute(sql`
      WITH locked_state AS MATERIALIZED (
        SELECT id, version, ${state.value.claimExpiresAt}::timestamptz AS lease_deadline,
          ${state.value.expiresAt}::timestamptz AS authorization_deadline
        FROM ${this.table} WHERE namespace = ${this.namespace} AND kind = 'oauth_state'
          AND id = ${input.state} AND version = ${state.version} FOR UPDATE
      ), locked_setup AS MATERIALIZED (
        SELECT setup.id, setup.version, ${setup.value.authorizationExpiresAt}::timestamptz AS deadline,
          locked_state.lease_deadline, locked_state.authorization_deadline
        FROM ${this.table} setup CROSS JOIN locked_state
        WHERE setup.namespace = ${this.namespace} AND setup.kind = 'setup'
          AND setup.id = ${input.setupReference} AND setup.version = ${setup.version} FOR UPDATE OF setup
      ), denied AS (
        UPDATE ${this.table} SET version = ${receipt.version}, payload = ${receipt.payload}
        FROM locked_state, locked_setup
        WHERE namespace = ${this.namespace} AND kind = 'oauth_state' AND ${this.table}.id = locked_state.id
          AND ${this.table}.version = locked_state.version
          AND clock_timestamp() < locked_setup.lease_deadline AND clock_timestamp() < locked_setup.authorization_deadline
          AND clock_timestamp() < locked_setup.deadline RETURNING namespace
      )
      UPDATE ${this.table} SET version = ${failedSetup.version}, payload = ${failedSetup.payload}
      WHERE namespace = ${this.namespace} AND kind = 'setup' AND id = ${input.setupReference}
        AND version = ${setup.version} AND EXISTS (SELECT 1 FROM denied) RETURNING id
    `);
    const rows = result.rows ?? result;
    return rows.some((row: { id: string }) => row.id === input.setupReference) ? failed : null;
  }

  async consumeOAuthState(state: string): Promise<OAuthStateRecord | null> {
    const [row]: Row[] = await this.db.delete(this.table).where(this.where("oauth_state", state)).returning();
    return row ? this.decode(row) : null;
  }
  claimOAuthState(state: string, claimToken: string, claimExpiresAt: string, now: string): Promise<OAuthStateRecord | null> {
    return this.mutate<OAuthStateRecord>("oauth_state", state, value => {
      if (!value || value.status === "completed" || value.status === "failed" || !(Date.parse(value.expiresAt) > Date.parse(now))) return null;
      if (value.status === "processing" && value.claimExpiresAt && Date.parse(value.claimExpiresAt) > Date.parse(now)) return null;
      return { ...value, status: "processing", claimToken, claimExpiresAt, attempts: (value.attempts ?? 0) + 1 };
    });
  }
  completeOAuthState(state: string, claimToken: string, connectionId: string): Promise<OAuthStateRecord | null> {
    return this.mutate<OAuthStateRecord>("oauth_state", state, value => {
      if (!value || value.claimToken !== claimToken) return null;
      return { ...value, status: "completed", completedConnectionId: connectionId,
        claimToken: undefined, claimExpiresAt: undefined, lastErrorCode: undefined };
    });
  }
  releaseOAuthState(state: string, claimToken: string, errorCode: string): Promise<OAuthStateRecord | null> {
    return this.mutate<OAuthStateRecord>("oauth_state", state, value => {
      if (!value || value.claimToken !== claimToken) return null;
      return { ...value, status: "pending", claimToken: undefined, claimExpiresAt: undefined, lastErrorCode: errorCode };
    });
  }

  async listConnectionLinks(filter: ConnectionLinkListFilter = {}): Promise<ConnectionLink[]> {
    return (await this.list<ConnectionLink>("link")).filter(value =>
      (!filter.connectionId || value.connectionId === filter.connectionId)
      && (!filter.projectId || value.projectId === filter.projectId)
      && (!filter.status || value.status === filter.status));
  }
  getConnectionLink(id: string): Promise<ConnectionLink | null> { return this.get("link", id); }
  upsertConnectionLink(link: ConnectionLink): Promise<ConnectionLink> { return this.put("link", link.id, link); }
  async updateConnectionLink(id: string, patch: Partial<Omit<ConnectionLink, "id" | "createdAt">>): Promise<ConnectionLink> {
    return (await this.mutate<ConnectionLink>("link", id, value => {
      if (!value) throw new ConnectError("connection_not_found", "Connection link not found");
      return { ...value, ...patch, id, createdAt: value.createdAt };
    }))!;
  }

  async saveConnectionSetupSession(session: ConnectionSetupSession): Promise<void> { await this.put("setup", session.id, session); }
  getConnectionSetupSession(id: string): Promise<ConnectionSetupSession | null> { return this.get("setup", id); }
  getConnectionSetupSessionByReference(reference: string): Promise<ConnectionSetupSession | null> { return this.get("setup", reference); }
  async consumeConnectionSetupSession(id: string, consumedAt: string, authorizationExpiresAt?: string): Promise<ConnectionSetupSession | null> {
    let consumed: ConnectionSetupSession | null = null;
    const result = await this.mutate<ConnectionSetupSession>("setup", id, value => {
      if (!value || !canConsumeConnectionSetup(value, consumedAt)) return null;
      consumed = value;
      return { ...value, status: "started", consumedAt, authorizationExpiresAt };
    });
    return result ? consumed : null;
  }

  cancelConnectionSetupSession(id: string, cancelledAt: string): Promise<ConnectionSetupSession | null> {
    return this.mutate<ConnectionSetupSession>("setup", id, value =>
      value && canConsumeConnectionSetup(value, cancelledAt) ? { ...value, status: "cancelled" } : null);
  }

  prepareConnectionSetupCompletion(reference: string, intent: ConnectionSetupCompletionIntent): Promise<ConnectionSetupSession | null> {
    return this.mutate<ConnectionSetupSession>("setup", reference, value => value ? prepareConnectionSetupCompletion(value, intent) : null);
  }

  async reconcileConnectionSetupSession(reference: string): Promise<ConnectionSetupSession | null> {
    const record = await this.snapshot<ConnectionSetupSession>("setup", reference);
    if (!record) return null;
    const intent = record.value.completionIntent;
    if (!intent) return record.value;
    const [connection, link] = await Promise.all([this.getConnection(intent.connection.connectionId), this.getConnectionLink(intent.link.id)]);
    const reconciled = reconcileConnectionSetup(record.value, connection, link);
    if (!reconciled) return record.value;
    // CAS the exact intent snapshot; a terminal receipt or another transition wins.
    if (await this.cas("setup", reference, record.version, reconciled)) return reconciled;
    return this.get<ConnectionSetupSession>("setup", reference);
  }

  finishConnectionSetupSession(reference: string, outcome: ConnectionSetupOutcome, _finishedAt: string): Promise<ConnectionSetupSession | null> {
    return this.mutate<ConnectionSetupSession>("setup", reference, value => value ? finishConnectionSetup(value, outcome) : null);
  }

  listConnectorDefinitions(): Promise<StoredConnectorDefinition[]> { return this.list("definition"); }
  getConnectorDefinition(id: string): Promise<StoredConnectorDefinition | null> { return this.get("definition", id); }
  async createConnectorDefinition(record: StoredConnectorDefinition): Promise<void> {
    const definition = normalizeConnectorDefinition(record.definition);
    const rows = await this.db.insert(this.table).values(this.encode("definition", definition.id, { ...record, definition }))
      .onConflictDoNothing().returning({ id: this.table.id });
    if (rows.length !== 1) throw new ConnectError("invalid_provider", "Connector identity already exists; use a new identity");
  }
  async disableConnectorDefinition(id: string, disabledAt: string): Promise<StoredConnectorDefinition> {
    return (await this.mutate<StoredConnectorDefinition>("definition", id, value => {
      if (!value) throw new ConnectError("provider_not_found", "Connector definition not found");
      return { ...value, disabledAt: value.disabledAt ?? disabledAt };
    }))!;
  }

  async saveConnectionVerification(result: ConnectionVerificationResult): Promise<void> { await this.put("verification", result.connectionId, result); }
  getConnectionVerification(id: string): Promise<ConnectionVerificationResult | null> { return this.get("verification", id); }

  async setSecret(ref: string, secret: StoredConnectionSecret): Promise<void> { await this.put("secret", ref, secret); }
  getSecret(ref: string): Promise<StoredConnectionSecret | null> { return this.get("secret", ref); }
  async deleteSecret(ref: string): Promise<void> { await this.db.delete(this.table).where(this.where("secret", ref)); }
  async getVersioned(ref: string) {
    const result = await this.snapshot<StoredConnectionSecret>("secret", ref);
    return result ? { secret: result.value, version: result.version } : null;
  }
  compareAndSet(ref: string, version: string, secret: StoredConnectionSecret): Promise<boolean> {
    return this.cas("secret", ref, version, secret);
  }
}
