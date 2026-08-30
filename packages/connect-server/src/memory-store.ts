import {
  ConnectError,
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

  async saveOAuthState(record: OAuthStateRecord): Promise<void> {
    this.oauthStates.set(record.state, clone(record));
  }

  async consumeOAuthState(state: string): Promise<OAuthStateRecord | null> {
    const record = this.oauthStates.get(state);
    this.oauthStates.delete(state);
    return record ? clone(record) : null;
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

  async consumeConnectionSetupSession(
    id: string,
    consumedAt: string,
  ): Promise<ConnectionSetupSession | null> {
    const session = this.setupSessions.get(id);
    if (!session || session.consumedAt) return null;
    const consumed = { ...session, consumedAt };
    this.setupSessions.set(id, clone(consumed));
    return clone(session);
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
