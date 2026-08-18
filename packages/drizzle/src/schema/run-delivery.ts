import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import {
  bigint,
  index as pgIndex,
  integer as pgInteger,
  jsonb,
  pgTable,
  text as pgText,
  uniqueIndex as pgUniqueIndex,
} from "drizzle-orm/pg-core";

export const runEventSequencesSqlite = sqliteTable("run_event_sequences", {
  runId: text("run_id").primaryKey(),
  lastSequence: integer("last_sequence").notNull(),
});

export const runStreamEventsSqlite = sqliteTable("run_stream_events", {
  runId: text("run_id").notNull(),
  sequence: integer("sequence").notNull(),
  eventId: text("event_id").notNull(),
  schemaVersion: integer("schema_version").notNull(),
  type: text("type").notNull(),
  data: text("data").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("uq_run_stream_events_sequence").on(table.runId, table.sequence),
  uniqueIndex("uq_run_stream_events_event_id").on(table.runId, table.eventId),
  index("idx_run_stream_events_cursor").on(table.runId, table.sequence),
]);

export const runExecutionLeasesSqlite = sqliteTable("run_execution_leases", {
  runId: text("run_id").primaryKey(),
  owner: text("owner").notNull(),
  token: text("token").notNull(),
  expiresAt: text("expires_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("idx_run_execution_leases_expiry").on(table.expiresAt),
]);

export const runEventSequencesPg = pgTable("run_event_sequences", {
  runId: pgText("run_id").primaryKey(),
  lastSequence: bigint("last_sequence", { mode: "number" }).notNull(),
});

export const runStreamEventsPg = pgTable("run_stream_events", {
  runId: pgText("run_id").notNull(),
  sequence: bigint("sequence", { mode: "number" }).notNull(),
  eventId: pgText("event_id").notNull(),
  schemaVersion: pgInteger("schema_version").notNull(),
  type: pgText("type").notNull(),
  data: jsonb("data").notNull(),
  createdAt: pgText("created_at").notNull(),
}, (table) => [
  pgUniqueIndex("uq_pg_run_stream_events_sequence").on(table.runId, table.sequence),
  pgUniqueIndex("uq_pg_run_stream_events_event_id").on(table.runId, table.eventId),
  pgIndex("idx_pg_run_stream_events_cursor").on(table.runId, table.sequence),
]);

export const runExecutionLeasesPg = pgTable("run_execution_leases", {
  runId: pgText("run_id").primaryKey(),
  owner: pgText("owner").notNull(),
  token: pgText("token").notNull(),
  expiresAt: pgText("expires_at").notNull(),
  updatedAt: pgText("updated_at").notNull(),
}, (table) => [
  pgIndex("idx_pg_run_execution_leases_expiry").on(table.expiresAt),
]);
