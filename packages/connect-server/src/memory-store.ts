import {
  ConnectError,
  canCommitMcpOAuthConnection,
  canCommitMcpOAuthSetup,
  canFailMcpOAuthSetup,
  failedMcpOAuthState,
  completedMcpOAuthState,
  type McpOAuthConnectionCommit,
  type McpOAuthSetupCommit,
  type McpOAuthSetupFailure,
  matchesOAuthReconnect,
  canConsumeConnectionSetup,
  finishConnectionSetup,
  prepareConnectionSetupCompletion,
  reconcileConnectionSetup,
  type ConnectionSetupCompletionIntent,
  type ConnectionSetupOutcome,
  type OAuthReconnectSnapshot,
  type OAuthCredentialReplacement,
  type ConnectStore,
  type ConnectionLink,
  type ConnectionLinkListFilter,
  type ConnectionLinkStore,
  type ConnectionListFilter,
  type ConnectionRecord,
  type ConnectionSetupSession,
  type ConnectionSetupSessionStore,
  type OAuthStateRecord,
} from "@polpo-ai/connect";

export class MemoryConnectStore implements ConnectStore, ConnectionLinkStore, ConnectionSetupSessionStore {
  private readonly connections = new Map<string, ConnectionRecord>();
  private readonly oauthStates = new Map<string, OAuthStateRecord>();
  private readonly links = new Map<string, ConnectionLink>();
  private readonly setupSessions = new Map<string, ConnectionSetupSession>();

  async listConnections(filter: ConnectionListFilter = {}): Promise<ConnectionRecord[]> {
    return [...this.connections.values()].filter((connection) => matchesFilter(connection, filter)).map(clone);
  }

  async getConnection(id: string): Promise<ConnectionRecord | null> {
    const record = this.connections.get(id);
    return record ? clone(record) : null;
  }

  async upsertConnection(record: ConnectionRecord): Promise<ConnectionRecord> {
    this.connections.set(record.id, clone(record));
    return clone(record);
  }

  async updateConnection(id: string, patch: Partial<Omit<ConnectionRecord, "id" | "createdAt">>): Promise<ConnectionRecord> {
    const existing = this.connections.get(id);
    if (!existing) throw new ConnectError("connection_not_found", `Connection not found: ${id}`);
    const updated = { ...existing, ...patch, id, createdAt: existing.createdAt };
    this.connections.set(id, clone(updated));
    return clone(updated);
  }

  async deleteConnection(id: string): Promise<void> {
    this.connections.delete(id);
  }

  async replaceOAuthCredential(expected: OAuthReconnectSnapshot, replacement: OAuthCredentialReplacement): Promise<ConnectionRecord | null> {
    const current = this.connections.get(expected.connectionId);
    if (!current || !matchesOAuthReconnect(current, expected)) return null;
    const next = { ...current, ...clone(replacement) };
    this.connections.set(current.id, next);
    return clone(next);
  }

  async saveOAuthState(record: OAuthStateRecord): Promise<void> {
    this.oauthStates.set(record.state, clone(record));
  }

  async consumeOAuthState(state: string): Promise<OAuthStateRecord | null> {
    const record = this.oauthStates.get(state);
    this.oauthStates.delete(state);
    return record ? clone(record) : null;
  }

  async getOAuthState(state: string): Promise<OAuthStateRecord | null> {
    const record = this.oauthStates.get(state);
    return record ? clone(record) : null;
  }

  async commitMcpOAuthConnection(input: McpOAuthConnectionCommit): Promise<ConnectionRecord | null> {
    const state = this.oauthStates.get(input.state);
    if (!state || !canCommitMcpOAuthConnection(state, input) || this.connections.has(input.connection.id)) return null;
    const connection = clone(input.connection);
    this.connections.set(connection.id, connection);
    this.oauthStates.set(input.state, clone(completedMcpOAuthState(state, connection.id)));
    return clone(connection);
  }

  async commitMcpOAuthSetup(input: McpOAuthSetupCommit): Promise<ConnectionRecord | null> {
    const state = this.oauthStates.get(input.state), setup = this.setupSessions.get(input.setupReference);
    if (!state || !setup || !canCommitMcpOAuthSetup(state, setup, input)
      || this.connections.has(input.connection.id) || this.links.has(input.link.id)
      || [...this.links.values()].some(link => link.connectionId === input.connection.id && link.projectId === input.link.projectId)) return null;
    this.connections.set(input.connection.id, clone(input.connection));
    this.links.set(input.link.id, clone(input.link));
    this.setupSessions.set(setup.id, clone(finishConnectionSetup(setup, { status: "completed", connectionId: input.connection.id })!));
    this.oauthStates.set(input.state, clone(completedMcpOAuthState(state, input.connection.id)));
    return clone(input.connection);
  }

  async failMcpOAuthSetup(input: McpOAuthSetupFailure): Promise<ConnectionSetupSession | null> {
    const state = this.oauthStates.get(input.state), setup = this.setupSessions.get(input.setupReference);
    if (!state || !setup || !canFailMcpOAuthSetup(state, setup, input)) return null;
    const failed = finishConnectionSetup(setup, { status: "error" })!;
    this.setupSessions.set(setup.id, clone(failed));
    this.oauthStates.set(input.state, clone(failedMcpOAuthState(state)));
    return clone(failed);
  }

  async claimOAuthState(
    state: string,
    claimToken: string,
    claimExpiresAt: string,
    now: string,
  ): Promise<OAuthStateRecord | null> {
    const record = this.oauthStates.get(state);
    if (!record || record.status === "completed" || record.status === "failed" || !(Date.parse(record.expiresAt) > Date.parse(now))) return null;
    if (
      record.status === "processing"
      && record.claimExpiresAt
      && new Date(record.claimExpiresAt).getTime() > new Date(now).getTime()
    ) return null;
    const claimed: OAuthStateRecord = {
      ...record,
      status: "processing",
      claimToken,
      claimExpiresAt,
      attempts: (record.attempts ?? 0) + 1,
    };
    this.oauthStates.set(state, clone(claimed));
    return clone(claimed);
  }

  async completeOAuthState(
    state: string,
    claimToken: string,
    connectionId: string,
  ): Promise<OAuthStateRecord | null> {
    const record = this.oauthStates.get(state);
    if (!record || record.claimToken !== claimToken) return null;
    const completed: OAuthStateRecord = {
      ...record,
      status: "completed",
      completedConnectionId: connectionId,
      claimToken: undefined,
      claimExpiresAt: undefined,
      lastErrorCode: undefined,
    };
    this.oauthStates.set(state, clone(completed));
    return clone(completed);
  }

  async releaseOAuthState(
    state: string,
    claimToken: string,
    errorCode: string,
  ): Promise<OAuthStateRecord | null> {
    const record = this.oauthStates.get(state);
    if (!record || record.claimToken !== claimToken) return null;
    const released: OAuthStateRecord = {
      ...record,
      status: "pending",
      claimToken: undefined,
      claimExpiresAt: undefined,
      lastErrorCode: errorCode,
    };
    this.oauthStates.set(state, clone(released));
    return clone(released);
  }

  async listConnectionLinks(filter: ConnectionLinkListFilter = {}): Promise<ConnectionLink[]> {
    return [...this.links.values()].filter((link) =>
      (!filter.connectionId || link.connectionId === filter.connectionId)
      && (!filter.projectId || link.projectId === filter.projectId)
      && (!filter.status || link.status === filter.status))
      .map(clone);
  }

  async getConnectionLink(id: string): Promise<ConnectionLink | null> {
    const link = this.links.get(id);
    return link ? clone(link) : null;
  }

  async upsertConnectionLink(link: ConnectionLink): Promise<ConnectionLink> {
    this.links.set(link.id, clone(link));
    return clone(link);
  }

  async updateConnectionLink(
    id: string,
    patch: Partial<Omit<ConnectionLink, "id" | "createdAt">>,
  ): Promise<ConnectionLink> {
    const existing = this.links.get(id);
    if (!existing) throw new ConnectError("connection_not_found", `Connection link not found: ${id}`);
    const updated = { ...existing, ...patch, id, createdAt: existing.createdAt };
    this.links.set(id, clone(updated));
    return clone(updated);
  }

  async saveConnectionSetupSession(session: ConnectionSetupSession): Promise<void> {
    this.setupSessions.set(session.id, clone(session));
  }

  async getConnectionSetupSession(id: string): Promise<ConnectionSetupSession | null> {
    const session = this.setupSessions.get(id);
    return session ? clone(session) : null;
  }

  getConnectionSetupSessionByReference(reference: string): Promise<ConnectionSetupSession | null> {
    return this.getConnectionSetupSession(reference);
  }

  async consumeConnectionSetupSession(
    id: string,
    consumedAt: string,
    authorizationExpiresAt?: string,
  ): Promise<ConnectionSetupSession | null> {
    const session = this.setupSessions.get(id);
    if (!session || !canConsumeConnectionSetup(session, consumedAt)) return null;
    const consumed = { ...session, status: "started" as const, consumedAt, authorizationExpiresAt };
    this.setupSessions.set(id, clone(consumed));
    return clone(session);
  }

  async cancelConnectionSetupSession(id: string, cancelledAt: string): Promise<ConnectionSetupSession | null> {
    const session = this.setupSessions.get(id);
    if (!session || !canConsumeConnectionSetup(session, cancelledAt)) return null;
    const cancelled = { ...session, status: "cancelled" as const };
    this.setupSessions.set(id, clone(cancelled));
    return clone(cancelled);
  }

  async prepareConnectionSetupCompletion(reference: string, intent: ConnectionSetupCompletionIntent): Promise<ConnectionSetupSession | null> {
    const session = this.setupSessions.get(reference);
    const prepared = session ? prepareConnectionSetupCompletion(session, intent) : null;
    if (!prepared) return null;
    this.setupSessions.set(reference, clone(prepared));
    return clone(prepared);
  }

  async reconcileConnectionSetupSession(reference: string): Promise<ConnectionSetupSession | null> {
    const session = this.setupSessions.get(reference);
    if (!session) return null;
    const intent = session.completionIntent;
    const reconciled = intent ? reconcileConnectionSetup(session,
      this.connections.get(intent.connection.connectionId) ?? null, this.links.get(intent.link.id) ?? null) : null;
    if (reconciled) this.setupSessions.set(reference, clone(reconciled));
    return clone(reconciled ?? session);
  }

  async finishConnectionSetupSession(reference: string, outcome: ConnectionSetupOutcome, _finishedAt: string): Promise<ConnectionSetupSession | null> {
    const session = this.setupSessions.get(reference);
    const finished = session ? finishConnectionSetup(session, outcome) : null;
    if (!finished) return null;
    this.setupSessions.set(reference, clone(finished));
    return clone(finished);
  }
}

function matchesFilter(connection: ConnectionRecord, filter: ConnectionListFilter): boolean {
  if (filter.providerId && connection.providerId !== filter.providerId) return false;
  if (filter.projectId && connection.projectId !== filter.projectId) return false;
  if (filter.orgId && connection.orgId !== filter.orgId) return false;
  if (filter.status && connection.status !== filter.status) return false;
  if (filter.owner && (
    connection.owner?.type !== filter.owner.type
    || connection.owner.id !== filter.owner.id
    || (filter.owner.type === "external_user"
      && (connection.owner.type !== "external_user" || connection.owner.namespace !== filter.owner.namespace))
  )) return false;
  return true;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
