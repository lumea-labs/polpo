import {
  index as sqliteIndex,
  integer,
  sqliteTable,
  text,
  uniqueIndex as sqliteUniqueIndex,
} from "drizzle-orm/sqlite-core";
import {
  index as pgIndex,
  integer as pgInteger,
  jsonb,
  pgTable,
  text as pgText,
  uniqueIndex as pgUniqueIndex,
} from "drizzle-orm/pg-core";

export const conversationChannelsSqlite = sqliteTable("conversation_channels", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().default(""),
  projectId: text("project_id").notNull(),
  provider: text("provider").notNull(),
  name: text("name").notNull(),
  connectionId: text("connection_id").notNull(),
  externalChannelId: text("external_channel_id").notNull(),
  status: text("status").notNull(),
  settings: text("settings").notNull().default("{}"),
  idempotencyKey: text("idempotency_key").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  sqliteUniqueIndex("uq_conversation_channels_operation").on(
    table.orgId,
    table.projectId,
    table.idempotencyKey,
  ),
  sqliteUniqueIndex("uq_conversation_channels_destination").on(
    table.orgId,
    table.projectId,
    table.provider,
    table.connectionId,
    table.externalChannelId,
  ),
  sqliteIndex("idx_conversation_channels_scope").on(table.orgId, table.projectId),
]);

export const conversationChannelRoutesSqlite = sqliteTable("conversation_channel_routes", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().default(""),
  projectId: text("project_id").notNull(),
  channelId: text("channel_id").notNull().references(
    () => conversationChannelsSqlite.id,
    { onDelete: "cascade" },
  ),
  agentName: text("agent_name").notNull(),
  allowedTools: text("allowed_tools", { mode: "json" }),
  externalChannelId: text("external_channel_id").notNull().default(""),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  priority: integer("priority").notNull().default(100),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  sqliteUniqueIndex("uq_conversation_channel_routes_target").on(
    table.orgId,
    table.projectId,
    table.channelId,
    table.agentName,
    table.externalChannelId,
  ),
  sqliteIndex("idx_conversation_channel_routes_channel").on(table.channelId, table.priority),
]);

export const conversationChannelsPg = pgTable("conversation_channels", {
  id: pgText("id").primaryKey(),
  orgId: pgText("org_id").notNull().default(""),
  projectId: pgText("project_id").notNull(),
  provider: pgText("provider").notNull(),
  name: pgText("name").notNull(),
  connectionId: pgText("connection_id").notNull(),
  externalChannelId: pgText("external_channel_id").notNull(),
  status: pgText("status").notNull(),
  settings: jsonb("settings").notNull().default({}),
  idempotencyKey: pgText("idempotency_key").notNull(),
  createdAt: pgText("created_at").notNull(),
  updatedAt: pgText("updated_at").notNull(),
}, (table) => [
  pgUniqueIndex("uq_pg_conversation_channels_operation").on(
    table.orgId,
    table.projectId,
    table.idempotencyKey,
  ),
  pgUniqueIndex("uq_pg_conversation_channels_destination").on(
    table.orgId,
    table.projectId,
    table.provider,
    table.connectionId,
    table.externalChannelId,
  ),
  pgIndex("idx_pg_conversation_channels_scope").on(table.orgId, table.projectId),
]);

export const conversationChannelRoutesPg = pgTable("conversation_channel_routes", {
  id: pgText("id").primaryKey(),
  orgId: pgText("org_id").notNull().default(""),
  projectId: pgText("project_id").notNull(),
  channelId: pgText("channel_id").notNull().references(
    () => conversationChannelsPg.id,
    { onDelete: "cascade" },
  ),
  agentName: pgText("agent_name").notNull(),
  allowedTools: jsonb("allowed_tools"),
  externalChannelId: pgText("external_channel_id").notNull().default(""),
  enabled: pgInteger("enabled").notNull().default(1),
  priority: pgInteger("priority").notNull().default(100),
  createdAt: pgText("created_at").notNull(),
  updatedAt: pgText("updated_at").notNull(),
}, (table) => [
  pgUniqueIndex("uq_pg_conversation_channel_routes_target").on(
    table.orgId,
    table.projectId,
    table.channelId,
    table.agentName,
    table.externalChannelId,
  ),
  pgIndex("idx_pg_conversation_channel_routes_channel").on(table.channelId, table.priority),
]);
