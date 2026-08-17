import { and, asc, eq } from "drizzle-orm";
import type {
  ChannelManagementScope,
  ChannelManagementStore,
  ChannelProviderId,
  ConversationChannel,
  ConversationChannelQuery,
  ConversationChannelRoute,
  CreateConversationChannelRecord,
  CreateConversationChannelRouteRecord,
  UpdateConversationChannelInput,
} from "@polpo-ai/channels";
import { deserializeJson, serializeJson, type Dialect } from "../utils.js";

type ChannelTables = {
  channels: any;
  routes: any;
};

const orgId = (scope: ChannelManagementScope) => scope.orgId ?? "";
const externalId = (value: string | null | undefined) => value ?? "";

export class DrizzleChannelManagementStore implements ChannelManagementStore {
  constructor(
    private readonly db: any,
    private readonly tables: ChannelTables,
    private readonly dialect: Dialect,
  ) {}

  async createOrReuseChannel(
    scope: ChannelManagementScope,
    input: CreateConversationChannelRecord,
  ): Promise<ConversationChannel> {
    const byOperation = await this.findByOperation(scope, input.idempotencyKey);
    if (byOperation) return byOperation;
    const byDestination = await this.findByDestination(scope, input);
    if (byDestination) return byDestination;

    await this.db.insert(this.tables.channels).values({
      id: input.id,
      orgId: orgId(scope),
      projectId: scope.projectId,
      provider: input.provider,
      name: input.name,
      connectionId: input.connectionId,
      externalChannelId: input.externalChannelId,
      status: input.status,
      settings: serializeJson(input.settings, this.dialect),
      idempotencyKey: input.idempotencyKey,
      createdAt: input.timestamp,
      updatedAt: input.timestamp,
    }).onConflictDoNothing();

    const created = await this.findByOperation(scope, input.idempotencyKey)
      ?? await this.findByDestination(scope, input);
    if (!created) throw new Error("Channel insert did not create or resolve a record");
    return created;
  }

  async getChannel(scope: ChannelManagementScope, id: string): Promise<ConversationChannel | null> {
    const rows = await this.db.select().from(this.tables.channels).where(and(
      eq(this.tables.channels.id, id),
      ...this.scopeConditions(this.tables.channels, scope),
    )).limit(1);
    return rows[0] ? this.channel(rows[0]) : null;
  }

  async listChannels(
    scope: ChannelManagementScope,
    query: ConversationChannelQuery = {},
  ): Promise<ConversationChannel[]> {
    const conditions = this.scopeConditions(this.tables.channels, scope);
    if (query.provider) conditions.push(eq(this.tables.channels.provider, query.provider));
    if (query.status) conditions.push(eq(this.tables.channels.status, query.status));
    if (query.connectionId) conditions.push(eq(this.tables.channels.connectionId, query.connectionId));
    const rows = await this.db.select().from(this.tables.channels)
      .where(and(...conditions))
      .orderBy(asc(this.tables.channels.createdAt), asc(this.tables.channels.id));
    return rows.map((row: any) => this.channel(row));
  }

  async updateChannel(
    scope: ChannelManagementScope,
    id: string,
    patch: Omit<UpdateConversationChannelInput, "status"> & {
      status?: ConversationChannel["status"];
      timestamp: string;
    },
  ): Promise<ConversationChannel | null> {
    const values: Record<string, unknown> = { updatedAt: patch.timestamp };
    if (patch.name !== undefined) values.name = patch.name;
    if (patch.status !== undefined) values.status = patch.status;
    if (patch.settings !== undefined) values.settings = serializeJson(patch.settings, this.dialect);
    await this.db.update(this.tables.channels).set(values).where(and(
      eq(this.tables.channels.id, id),
      ...this.scopeConditions(this.tables.channels, scope),
    ));
    return this.getChannel(scope, id);
  }

  async removeChannel(scope: ChannelManagementScope, id: string): Promise<boolean> {
    const existing = await this.getChannel(scope, id);
    if (!existing) return false;
    await this.db.delete(this.tables.channels).where(and(
      eq(this.tables.channels.id, id),
      ...this.scopeConditions(this.tables.channels, scope),
    ));
    return true;
  }

  async listRoutes(
    scope: ChannelManagementScope,
    channelId: string,
  ): Promise<ConversationChannelRoute[]> {
    const rows = await this.db.select().from(this.tables.routes).where(and(
      eq(this.tables.routes.channelId, channelId),
      ...this.scopeConditions(this.tables.routes, scope),
    )).orderBy(asc(this.tables.routes.priority), asc(this.tables.routes.createdAt));
    return rows.map((row: any) => this.route(row));
  }

  async upsertRoute(
    scope: ChannelManagementScope,
    input: CreateConversationChannelRouteRecord,
  ): Promise<ConversationChannelRoute> {
    const target = and(
      ...this.scopeConditions(this.tables.routes, scope),
      eq(this.tables.routes.channelId, input.channelId),
      eq(this.tables.routes.agentName, input.agentName),
      eq(this.tables.routes.externalChannelId, externalId(input.externalChannelId)),
    );
    const existing = await this.db.select().from(this.tables.routes).where(target).limit(1);
    if (existing[0]) {
      await this.db.update(this.tables.routes).set({
        enabled: this.dialect === "sqlite" ? input.enabled : input.enabled ? 1 : 0,
        priority: input.priority,
        updatedAt: input.timestamp,
      }).where(eq(this.tables.routes.id, existing[0].id));
      return this.route({
        ...existing[0],
        enabled: input.enabled,
        priority: input.priority,
        updatedAt: input.timestamp,
      });
    }
    await this.db.insert(this.tables.routes).values({
      id: input.id,
      orgId: orgId(scope),
      projectId: scope.projectId,
      channelId: input.channelId,
      agentName: input.agentName,
      externalChannelId: externalId(input.externalChannelId),
      enabled: this.dialect === "sqlite" ? input.enabled : input.enabled ? 1 : 0,
      priority: input.priority,
      createdAt: input.timestamp,
      updatedAt: input.timestamp,
    }).onConflictDoNothing();
    const rows = await this.db.select().from(this.tables.routes).where(target).limit(1);
    if (!rows[0]) throw new Error("Channel route insert did not create or resolve a record");
    return this.route(rows[0]);
  }

  async removeRoute(scope: ChannelManagementScope, routeId: string): Promise<boolean> {
    const conditions = and(
      eq(this.tables.routes.id, routeId),
      ...this.scopeConditions(this.tables.routes, scope),
    );
    const existing = await this.db.select({ id: this.tables.routes.id })
      .from(this.tables.routes).where(conditions).limit(1);
    if (!existing[0]) return false;
    await this.db.delete(this.tables.routes).where(conditions);
    return true;
  }

  private scopeConditions(table: any, scope: ChannelManagementScope): any[] {
    return [
      eq(table.orgId, orgId(scope)),
      eq(table.projectId, scope.projectId),
    ];
  }

  private async findByOperation(
    scope: ChannelManagementScope,
    idempotencyKey: string,
  ): Promise<ConversationChannel | null> {
    const rows = await this.db.select().from(this.tables.channels).where(and(
      ...this.scopeConditions(this.tables.channels, scope),
      eq(this.tables.channels.idempotencyKey, idempotencyKey),
    )).limit(1);
    return rows[0] ? this.channel(rows[0]) : null;
  }

  private async findByDestination(
    scope: ChannelManagementScope,
    input: { connectionId: string; externalChannelId: string; provider: ChannelProviderId },
  ): Promise<ConversationChannel | null> {
    const rows = await this.db.select().from(this.tables.channels).where(and(
      ...this.scopeConditions(this.tables.channels, scope),
      eq(this.tables.channels.provider, input.provider),
      eq(this.tables.channels.connectionId, input.connectionId),
      eq(this.tables.channels.externalChannelId, input.externalChannelId),
    )).limit(1);
    return rows[0] ? this.channel(rows[0]) : null;
  }

  private channel(row: any): ConversationChannel {
    return {
      id: row.id,
      provider: row.provider,
      name: row.name,
      connectionId: row.connectionId,
      externalChannelId: row.externalChannelId,
      status: row.status,
      settings: deserializeJson(row.settings, {}, this.dialect),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private route(row: any): ConversationChannelRoute {
    return {
      id: row.id,
      channelId: row.channelId,
      agentName: row.agentName,
      externalChannelId: row.externalChannelId || null,
      enabled: row.enabled === true || row.enabled === 1,
      priority: row.priority,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

