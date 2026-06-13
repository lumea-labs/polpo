import { sqliteTable, text, index } from "drizzle-orm/sqlite-core";
import { pgTable, text as pgText, jsonb, varchar, index as pgIndex } from "drizzle-orm/pg-core";

export const loopRunsSqlite = sqliteTable("loop_runs", {
  id: text("id").primaryKey(),
  loopName: text("loop_name").notNull(),
  agentName: text("agent_name"),
  sessionId: text("session_id"),
  user: text("user"),
  status: text("status").notNull().default("running"),
  context: text("context").notNull().default("{}"),
  trace: text("trace").notNull().default("[]"),
  error: text("error"),
  approvalRequestId: text("approval_request_id"),
  approval: text("approval"),
  metadata: text("metadata"),
  startedAt: text("started_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  completedAt: text("completed_at"),
}, (table) => [
  index("idx_loop_runs_status").on(table.status),
  index("idx_loop_runs_loop_name").on(table.loopName),
  index("idx_loop_runs_agent_name").on(table.agentName),
  index("idx_loop_runs_session_id").on(table.sessionId),
  index("idx_loop_runs_user").on(table.user),
]);

export const loopRunsPg = pgTable("loop_runs", {
  id: pgText("id").primaryKey(),
  loopName: pgText("loop_name").notNull(),
  agentName: pgText("agent_name"),
  sessionId: pgText("session_id"),
  user: pgText("user"),
  status: varchar("status", { length: 32 }).notNull().default("running"),
  context: jsonb("context").notNull().default({}),
  trace: jsonb("trace").notNull().default([]),
  error: pgText("error"),
  approvalRequestId: pgText("approval_request_id"),
  approval: jsonb("approval"),
  metadata: jsonb("metadata"),
  startedAt: pgText("started_at").notNull(),
  updatedAt: pgText("updated_at").notNull(),
  completedAt: pgText("completed_at"),
}, (table) => [
  pgIndex("idx_pg_loop_runs_status").on(table.status),
  pgIndex("idx_pg_loop_runs_loop_name").on(table.loopName),
  pgIndex("idx_pg_loop_runs_agent_name").on(table.agentName),
  pgIndex("idx_pg_loop_runs_session_id").on(table.sessionId),
  pgIndex("idx_pg_loop_runs_user").on(table.user),
]);
