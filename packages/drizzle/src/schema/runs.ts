import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { pgTable, text as pgText, integer as pgInteger, jsonb, varchar, index as pgIndex } from "drizzle-orm/pg-core";

// ── SQLite schema ──────────────────────────────────────────────────────

export const runsSqlite = sqliteTable("runs", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  pid: integer("pid").notNull().default(0),
  agentName: text("agent_name").notNull(),
  adapterType: text("adapter_type").notNull(),
  sessionId: text("session_id"),
  status: text("status").notNull().default("running"),
  startedAt: text("started_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  activity: text("activity").notNull().default("{}"),
  result: text("result"),
  outcomes: text("outcomes"),
  config: text("config"),
  configPath: text("config_path").notNull(),
  /** Propagated from Task.user at spawn time. Used for per-user run analytics. */
  user: text("user"),
  /** Durable-turns checkpoint (LoopResumeState JSON) — written once per completed turn. */
  resumeState: text("resume_state"),
  executionMode: text("execution_mode"),
  // ── F2: unified Run — columns folded from loop_runs (all nullable/additive) ──
  loopName: text("loop_name"),
  context: text("context"),
  trace: text("trace"),
  error: text("error"),
  approvalRequestId: text("approval_request_id"),
  approval: text("approval"),
  metadata: text("metadata"),
  completedAt: text("completed_at"),
  collectedAt: text("collected_at"),
  /** Execution-engine discriminator: "agent" (chat/task turn-loop) | "graph"
   *  (project-loop). Defaults to "agent" so existing task rows backfill; loop
   *  rows are written "graph" so task queries (getActiveRuns/getTerminalRuns)
   *  can exclude them once the tables merge. */
  engine: text("engine").default("agent"),
  /** Consumption axis (F3, forward-compat only): "stream" | "background". */
  delivery: text("delivery"),
}, (table) => [
  index("idx_runs_status").on(table.status),
  index("idx_runs_task_id").on(table.taskId),
  index("idx_runs_user").on(table.user),
  index("idx_runs_engine").on(table.engine),
]);

// ── PostgreSQL schema ──────────────────────────────────────────────────

export const runsPg = pgTable("runs", {
  id: pgText("id").primaryKey(),
  taskId: pgText("task_id").notNull(),
  pid: pgInteger("pid").notNull().default(0),
  agentName: pgText("agent_name").notNull(),
  adapterType: pgText("adapter_type").notNull(),
  sessionId: pgText("session_id"),
  status: varchar("status", { length: 32 }).notNull().default("running"),
  startedAt: pgText("started_at").notNull(),
  updatedAt: pgText("updated_at").notNull(),
  activity: jsonb("activity").notNull().default({}),
  result: jsonb("result"),
  outcomes: jsonb("outcomes"),
  config: jsonb("config"),
  configPath: pgText("config_path").notNull(),
  /** Propagated from Task.user at spawn time. Used for per-user run analytics. */
  user: pgText("user"),
  /** Durable-turns checkpoint (LoopResumeState JSON) — written once per completed turn. */
  resumeState: jsonb("resume_state"),
  executionMode: pgText("execution_mode"),
  // ── F2: unified Run — columns folded from loop_runs (all nullable/additive) ──
  loopName: pgText("loop_name"),
  context: jsonb("context"),
  trace: jsonb("trace"),
  error: pgText("error"),
  approvalRequestId: pgText("approval_request_id"),
  approval: jsonb("approval"),
  metadata: jsonb("metadata"),
  completedAt: pgText("completed_at"),
  collectedAt: pgText("collected_at"),
  /** Execution-engine discriminator: "agent" (chat/task) | "graph" (project-loop).
   *  Defaults "agent"; loop rows are "graph" so task queries can exclude them. */
  engine: pgText("engine").default("agent"),
  /** Consumption axis (F3, forward-compat only): "stream" | "background". */
  delivery: pgText("delivery"),
}, (table) => [
  pgIndex("idx_pg_runs_status").on(table.status),
  pgIndex("idx_pg_runs_task_id").on(table.taskId),
  pgIndex("idx_pg_runs_user").on(table.user),
  pgIndex("idx_pg_runs_engine").on(table.engine),
]);
