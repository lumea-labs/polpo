import { sqliteTable, text, primaryKey } from "drizzle-orm/sqlite-core";
import { pgTable, text as pgText, primaryKey as pgPrimaryKey } from "drizzle-orm/pg-core";

/** The host selects the namespace; every payload is encrypted, including PKCE state. */
export const connectRecordsSqlite = sqliteTable("connect_records", {
  namespace: text("namespace").notNull(),
  kind: text("kind").notNull(),
  id: text("id").notNull(),
  version: text("version").notNull(),
  payload: text("payload").notNull(),
}, table => [primaryKey({ columns: [table.namespace, table.kind, table.id] })]);

export const connectRecordsPg = pgTable("connect_records", {
  namespace: pgText("namespace").notNull(),
  kind: pgText("kind").notNull(),
  id: pgText("id").notNull(),
  version: pgText("version").notNull(),
  payload: pgText("payload").notNull(),
}, table => [pgPrimaryKey({ columns: [table.namespace, table.kind, table.id] })]);
