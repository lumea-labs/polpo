import type {
  ChannelManagementScope,
  ChannelManagementStore,
  ConversationChannel,
  ConversationChannelQuery,
  ConversationChannelRoute,
  CreateConversationChannelRecord,
  CreateConversationChannelRouteRecord,
  UpdateConversationChannelInput,
} from "./contracts.js";

type ScopedChannel = { scopeKey: string; value: ConversationChannel };
type ScopedRoute = { scopeKey: string; value: ConversationChannelRoute };

function scopeKey(scope: ChannelManagementScope): string {
  return `${scope.orgId ?? ""}\u0000${scope.projectId}`;
}

function channelIdentity(input: {
  connectionId: string;
  externalChannelId: string;
  provider: string;
}): string {
  return `${input.provider}\u0000${input.connectionId}\u0000${input.externalChannelId}`;
}

function cloneChannel(value: ConversationChannel): ConversationChannel {
  return { ...value, settings: structuredClone(value.settings) };
}

function cloneRoute(value: ConversationChannelRoute): ConversationChannelRoute {
  return { ...value };
}

export class InMemoryChannelManagementStore implements ChannelManagementStore {
  private readonly channels = new Map<string, ScopedChannel>();
  private readonly routes = new Map<string, ScopedRoute>();
  private readonly operationChannels = new Map<string, string>();
  private readonly channelIdentities = new Map<string, string>();

  async createOrReuseChannel(
    scope: ChannelManagementScope,
    input: CreateConversationChannelRecord,
  ): Promise<ConversationChannel> {
    const scoped = scopeKey(scope);
    const operationKey = `${scoped}\u0000${input.idempotencyKey}`;
    const existingOperationId = this.operationChannels.get(operationKey);
    if (existingOperationId) {
      const existing = this.channels.get(existingOperationId);
      if (existing?.scopeKey === scoped) return cloneChannel(existing.value);
    }

    const identityKey = `${scoped}\u0000${channelIdentity(input)}`;
    const existingIdentityId = this.channelIdentities.get(identityKey);
    if (existingIdentityId) {
      const existing = this.channels.get(existingIdentityId);
      if (existing?.scopeKey === scoped) {
        this.operationChannels.set(operationKey, existing.value.id);
        return cloneChannel(existing.value);
      }
    }

    const value: ConversationChannel = {
      id: input.id,
      provider: input.provider,
      name: input.name,
      connectionId: input.connectionId,
      externalChannelId: input.externalChannelId,
      status: input.status,
      settings: structuredClone(input.settings),
      createdAt: input.timestamp,
      updatedAt: input.timestamp,
    };
    this.channels.set(value.id, { scopeKey: scoped, value });
    this.operationChannels.set(operationKey, value.id);
    this.channelIdentities.set(identityKey, value.id);
    return cloneChannel(value);
  }

  async getChannel(scope: ChannelManagementScope, id: string): Promise<ConversationChannel | null> {
    const value = this.channels.get(id);
    return value?.scopeKey === scopeKey(scope) ? cloneChannel(value.value) : null;
  }

  async listChannels(
    scope: ChannelManagementScope,
    query: ConversationChannelQuery = {},
  ): Promise<ConversationChannel[]> {
    const scoped = scopeKey(scope);
    return [...this.channels.values()]
      .filter(({ scopeKey: candidate, value }) =>
        candidate === scoped
        && (query.provider === undefined || value.provider === query.provider)
        && (query.status === undefined || value.status === query.status)
        && (query.connectionId === undefined || value.connectionId === query.connectionId))
      .map(({ value }) => cloneChannel(value))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async updateChannel(
    scope: ChannelManagementScope,
    id: string,
    patch: Omit<UpdateConversationChannelInput, "status"> & {
      timestamp: string;
      status?: ConversationChannel["status"];
    },
  ): Promise<ConversationChannel | null> {
    const current = this.channels.get(id);
    if (!current || current.scopeKey !== scopeKey(scope)) return null;
    let settings = current.value.settings;
    if (patch.settings !== undefined) {
      const { identityResolver, ...rest } = structuredClone(patch.settings);
      const { identityResolver: _currentResolver, ...currentRest } = current.value.settings;
      settings = {
        ...currentRest,
        ...rest,
        ...(identityResolver === undefined
          ? (_currentResolver ? { identityResolver: _currentResolver } : {})
          : identityResolver === null
            ? {}
            : { identityResolver }),
      };
    }
    const value: ConversationChannel = {
      ...current.value,
      ...(patch.name === undefined ? {} : { name: patch.name }),
      settings,
      ...(patch.status === undefined ? {} : { status: patch.status }),
      updatedAt: patch.timestamp,
    };
    this.channels.set(id, { ...current, value });
    return cloneChannel(value);
  }

  async removeChannel(scope: ChannelManagementScope, id: string): Promise<boolean> {
    const current = this.channels.get(id);
    if (!current || current.scopeKey !== scopeKey(scope)) return false;
    for (const [routeId, route] of this.routes) {
      if (route.scopeKey === current.scopeKey && route.value.channelId === id) {
        this.routes.delete(routeId);
      }
    }
    this.channels.delete(id);
    for (const [key, value] of this.operationChannels) {
      if (value === id) this.operationChannels.delete(key);
    }
    for (const [key, value] of this.channelIdentities) {
      if (value === id) this.channelIdentities.delete(key);
    }
    return true;
  }

  async listRoutes(
    scope: ChannelManagementScope,
    channelId: string,
  ): Promise<ConversationChannelRoute[]> {
    const scoped = scopeKey(scope);
    return [...this.routes.values()]
      .filter(({ scopeKey: candidate, value }) => candidate === scoped && value.channelId === channelId)
      .map(({ value }) => cloneRoute(value))
      .sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt));
  }

  async upsertRoute(
    scope: ChannelManagementScope,
    input: CreateConversationChannelRouteRecord,
  ): Promise<ConversationChannelRoute> {
    const scoped = scopeKey(scope);
    const existing = [...this.routes.values()].find(({ scopeKey: candidate, value }) =>
      candidate === scoped
      && value.channelId === input.channelId
      && value.agentName === input.agentName
      && value.externalChannelId === input.externalChannelId);
    if (existing) {
      const value: ConversationChannelRoute = {
        ...existing.value,
        enabled: input.enabled,
        priority: input.priority,
        updatedAt: input.timestamp,
      };
      this.routes.set(value.id, { scopeKey: scoped, value });
      return cloneRoute(value);
    }
    const value: ConversationChannelRoute = {
      id: input.id,
      channelId: input.channelId,
      agentName: input.agentName,
      externalChannelId: input.externalChannelId,
      enabled: input.enabled,
      priority: input.priority,
      createdAt: input.timestamp,
      updatedAt: input.timestamp,
    };
    this.routes.set(value.id, { scopeKey: scoped, value });
    return cloneRoute(value);
  }

  async removeRoute(scope: ChannelManagementScope, routeId: string): Promise<boolean> {
    const current = this.routes.get(routeId);
    if (!current || current.scopeKey !== scopeKey(scope)) return false;
    return this.routes.delete(routeId);
  }
}
