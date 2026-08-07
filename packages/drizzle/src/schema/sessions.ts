import { sqliteTable, text, index } from "drizzle-orm/sqlite-core";
import { pgTable, text as pgText, jsonb, index as pgIndex } from "drizzle-orm/pg-core";

// ── SQLite schema ──────────────────────────────────────────────────────

export const sessionsSqlite = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  title: text("title"),
  agent: text("agent"),
  /** OpenAI-compat opaque end-user id. Set by integrators, never verified. */
  user: text("user"),
  /** OpenAI-compat metadata. JSON-stringified on SQLite (no native jsonb). */
  metadata: text("metadata"),
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
}, (table) => [
  index("idx_messages_session").on(table.sessionId, table.ts),
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
}, (table) => [
  pgIndex("idx_pg_messages_session").on(table.sessionId, table.ts),
]);
