import { ConnectError, type ConnectStore, type ConnectionListFilter, type ConnectionRecord, type OAuthStateRecord } from "@polpo-ai/connect";

export class MemoryConnectStore implements ConnectStore {
  private readonly connections = new Map<string, ConnectionRecord>();
  private readonly oauthStates = new Map<string, OAuthStateRecord>();

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
}

function matchesFilter(connection: ConnectionRecord, filter: ConnectionListFilter): boolean {
  if (filter.providerId && connection.providerId !== filter.providerId) return false;
  if (filter.projectId && connection.projectId !== filter.projectId) return false;
  if (filter.orgId && connection.orgId !== filter.orgId) return false;
  if (filter.status && connection.status !== filter.status) return false;
  if (filter.owner && (connection.owner?.type !== filter.owner.type || connection.owner.id !== filter.owner.id)) return false;
  return true;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
