import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { pgTable, text as pgText, integer as pgInteger, boolean as pgBoolean, jsonb, index as pgIndex, uniqueIndex as pgUniqueIndex } from "drizzle-orm/pg-core";

// ── SQLite schema ──────────────────────────────────────────────────────

export const sessionsSqlite = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  title: text("title"),
  agent: text("agent"),
  /** OpenAI-compat opaque end-user id. Set by integrators, never verified. */
  user: text("user"),
  /** OpenAI-compat metadata. JSON-stringified on SQLite (no native jsonb). */
  metadata: text("metadata"),
  version: integer("version").notNull().default(0),
  scopeKey: text("scope_key"),
  scopeVersion: text("scope_version"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("idx_sessions_user").on(table.user),
]);

export const messagesSqlite = sqliteTable("messages", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => sessionsSqlite.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  content: text("content").notNull(),
  ts: text("ts").notNull(),
  toolCalls: text("tool_calls"),
  suggestions: text("suggestions"),
  toolCallId: text("tool_call_id"),
  reasoning: text("reasoning"),
  reasoningTruncated: integer("reasoning_truncated", { mode: "boolean" }).notNull().default(false),
  turnId: text("turn_id"),
}, (table) => [
  index("idx_messages_session").on(table.sessionId, table.ts),
  index("idx_messages_turn").on(table.sessionId, table.turnId),
]);

export const canonicalTurnOutboxSqlite = sqliteTable("canonical_turn_outbox", {
  turnId: text("turn_id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => sessionsSqlite.id, { onDelete: "cascade" }),
  event: text("event").notNull(),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("idx_canonical_turn_outbox_status").on(table.status, table.createdAt),
]);

export const sessionContinuationsSqlite = sqliteTable("session_continuations", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => sessionsSqlite.id, { onDelete: "cascade" }),
  idempotencyKey: text("idempotency_key").notNull(),
  fingerprint: text("fingerprint").notNull(),
  toolCallId: text("tool_call_id").notNull(),
  runId: text("run_id").notNull(),
  sessionVersion: integer("session_version").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("uq_session_continuations_key").on(table.sessionId, table.idempotencyKey),
  uniqueIndex("uq_session_continuations_call").on(table.sessionId, table.toolCallId),
]);

export const sessionClientToolSettlementsSqlite = sqliteTable("session_client_tool_settlements", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => sessionsSqlite.id, { onDelete: "cascade" }),
  idempotencyKey: text("idempotency_key").notNull(),
  fingerprint: text("fingerprint").notNull(),
  toolCallId: text("tool_call_id").notNull(),
  sourceAssistantMessageId: text("source_assistant_message_id").notNull(),
  resultMessageId: text("result_message_id").notNull(),
  outcome: text("outcome").notNull(),
  sessionVersion: integer("session_version").notNull(),
  settledAt: text("settled_at").notNull(),
}, (table) => [
  uniqueIndex("uq_session_client_tool_settlements_key").on(table.sessionId, table.idempotencyKey),
  uniqueIndex("uq_session_client_tool_settlements_call").on(table.sessionId, table.toolCallId),
  uniqueIndex("uq_session_client_tool_settlements_result").on(table.resultMessageId),
  index("idx_session_client_tool_settlements_source").on(table.sessionId, table.sourceAssistantMessageId),
]);

// ── PostgreSQL schema ──────────────────────────────────────────────────

export const sessionsPg = pgTable("sessions", {
  id: pgText("id").primaryKey(),
  title: pgText("title"),
  agent: pgText("agent"),
  /** OpenAI-compat opaque end-user id. Set by integrators, never verified. */
  user: pgText("user"),
  /** OpenAI-compat metadata. Native JSONB so we can filter on key/value at SQL level. */
  metadata: jsonb("metadata"),
  version: pgInteger("version").notNull().default(0),
  scopeKey: pgText("scope_key"),
  scopeVersion: pgText("scope_version"),
  createdAt: pgText("created_at").notNull(),
  updatedAt: pgText("updated_at").notNull(),
}, (table) => [
  pgIndex("idx_pg_sessions_user").on(table.user),
]);

export const messagesPg = pgTable("messages", {
  id: pgText("id").primaryKey(),
  sessionId: pgText("session_id").notNull().references(() => sessionsPg.id, { onDelete: "cascade" }),
  role: pgText("role").notNull(),
  content: pgText("content").notNull(),
  ts: pgText("ts").notNull(),
  toolCalls: pgText("tool_calls"),
  suggestions: pgText("suggestions"),
  toolCallId: pgText("tool_call_id"),
  reasoning: pgText("reasoning"),
  reasoningTruncated: pgBoolean("reasoning_truncated").notNull().default(false),
  turnId: pgText("turn_id"),
}, (table) => [
  pgIndex("idx_pg_messages_session").on(table.sessionId, table.ts),
  pgIndex("idx_pg_messages_turn").on(table.sessionId, table.turnId),
]);

export const canonicalTurnOutboxPg = pgTable("canonical_turn_outbox", {
  turnId: pgText("turn_id").primaryKey(),
  sessionId: pgText("session_id").notNull().references(() => sessionsPg.id, { onDelete: "cascade" }),
  event: jsonb("event").notNull(),
  status: pgText("status").notNull().default("pending"),
  attempts: pgInteger("attempts").notNull().default(0),
  createdAt: pgText("created_at").notNull(),
  updatedAt: pgText("updated_at").notNull(),
}, (table) => [
  pgIndex("idx_pg_canonical_turn_outbox_status").on(table.status, table.createdAt),
]);

export const sessionContinuationsPg = pgTable("session_continuations", {
  id: pgText("id").primaryKey(),
  sessionId: pgText("session_id").notNull().references(() => sessionsPg.id, { onDelete: "cascade" }),
  idempotencyKey: pgText("idempotency_key").notNull(),
  fingerprint: pgText("fingerprint").notNull(),
  toolCallId: pgText("tool_call_id").notNull(),
  runId: pgText("run_id").notNull(),
  sessionVersion: pgInteger("session_version").notNull(),
  createdAt: pgText("created_at").notNull(),
}, (table) => [
  pgUniqueIndex("uq_pg_session_continuations_key").on(table.sessionId, table.idempotencyKey),
  pgUniqueIndex("uq_pg_session_continuations_call").on(table.sessionId, table.toolCallId),
]);

export const sessionClientToolSettlementsPg = pgTable("session_client_tool_settlements", {
  id: pgText("id").primaryKey(),
  sessionId: pgText("session_id").notNull().references(() => sessionsPg.id, { onDelete: "cascade" }),
  idempotencyKey: pgText("idempotency_key").notNull(),
  fingerprint: pgText("fingerprint").notNull(),
  toolCallId: pgText("tool_call_id").notNull(),
  sourceAssistantMessageId: pgText("source_assistant_message_id").notNull(),
  resultMessageId: pgText("result_message_id").notNull(),
  outcome: pgText("outcome").notNull(),
  sessionVersion: pgInteger("session_version").notNull(),
  settledAt: pgText("settled_at").notNull(),
}, (table) => [
  pgUniqueIndex("uq_pg_session_client_tool_settlements_key").on(table.sessionId, table.idempotencyKey),
  pgUniqueIndex("uq_pg_session_client_tool_settlements_call").on(table.sessionId, table.toolCallId),
  pgUniqueIndex("uq_pg_session_client_tool_settlements_result").on(table.resultMessageId),
  pgIndex("idx_pg_session_client_tool_settlements_source").on(table.sessionId, table.sourceAssistantMessageId),
]);
