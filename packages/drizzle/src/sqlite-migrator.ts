/**
 * Idempotent SQLite schema migrator — twin of the PostgreSQL migrator.
 *
 * DDL is derived from the ACTUAL Drizzle table definitions (single source
 * of truth: schema/*.ts — columns, composite primary keys, and indexes),
 * replacing the hand-maintained CREATE TABLE copies that used to live in
 * the node shell and in tests (and had already drifted).
 *
 * - ensureSqliteTables: CREATE TABLE IF NOT EXISTS for every table
 * - migrateSqliteSchema: tables → ADD COLUMN for anything missing
 *   (PRAGMA table_info diff; SQLite has no ADD COLUMN IF NOT EXISTS)
 *   → indexes last (an index on a column that predates the column's
 *   introduction would fail on old databases)
 */

import { sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import {
  tasksSqlite, missionsSqlite, metadataSqlite, processesSqlite,
  runsSqlite, loopRunsSqlite,
  runEventSequencesSqlite, runStreamEventsSqlite, runExecutionLeasesSqlite,
  runCancellationRequestsSqlite,
  sessionsSqlite, messagesSqlite, sessionContinuationsSqlite,
  canonicalTurnOutboxSqlite,
  logSessionsSqlite, logEntriesSqlite,
  modelInvocationLogsSqlite,
  approvalsSqlite, memorySqlite,
  teamsSqlite, agentsSqlite,
  vaultSqlite, playbooksSqlite, skillsSqlite,
  conversationChannelsSqlite, conversationChannelRoutesSqlite,
} from "./schema/index.js";

const SQLITE_TABLES = [
  tasksSqlite, missionsSqlite, metadataSqlite, processesSqlite,
  runsSqlite, loopRunsSqlite,
  runEventSequencesSqlite, runStreamEventsSqlite, runExecutionLeasesSqlite,
  runCancellationRequestsSqlite,
  sessionsSqlite, messagesSqlite, sessionContinuationsSqlite,
  canonicalTurnOutboxSqlite,
  logSessionsSqlite, logEntriesSqlite,
  modelInvocationLogsSqlite,
  approvalsSqlite, memorySqlite,
  teamsSqlite, agentsSqlite,
  vaultSqlite, playbooksSqlite, skillsSqlite,
  conversationChannelsSqlite, conversationChannelRoutesSqlite,
];

/** Render a Drizzle column default as SQL, or undefined when it can't be
 *  expressed safely (SQL expressions/functions — column added without one). */
function renderDefault(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
  if (Array.isArray(value) || typeof value === "object") {
    return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
  }
  return undefined;
}

function columnDdl(col: any, inlinePrimary: boolean): string {
  let ddl = `"${col.name}" ${col.getSQLType()}`;
  if (inlinePrimary && col.primary) ddl += " PRIMARY KEY";
  if (col.notNull && !col.primary) ddl += " NOT NULL";
  if (col.isUnique && !col.primary) ddl += " UNIQUE";
  const def = renderDefault(col.default);
  if (def !== undefined) ddl += ` DEFAULT ${def}`;
  return ddl;
}

/** Ensure all SQLite tables exist (CREATE TABLE IF NOT EXISTS). */
export async function ensureSqliteTables(db: any): Promise<void> {
  for (const table of SQLITE_TABLES) {
    const cfg = getTableConfig(table);
    const composite = cfg.primaryKeys.length > 0;
    const parts = cfg.columns.map((col) => columnDdl(col, !composite));
    if (composite) {
      const pkCols = cfg.primaryKeys[0].columns.map((c: any) => `"${c.name}"`).join(", ");
      parts.push(`PRIMARY KEY (${pkCols})`);
    }
    for (const uc of cfg.uniqueConstraints ?? []) {
      const cols = uc.columns.map((c: any) => `"${c.name}"`).join(", ");
      parts.push(`UNIQUE (${cols})`);
    }
    for (const fk of cfg.foreignKeys ?? []) {
      const ref = fk.reference();
      const cols = ref.columns.map((c: any) => `"${c.name}"`).join(", ");
      const fTable = getTableConfig(ref.foreignTable).name;
      const fCols = ref.foreignColumns.map((c: any) => `"${c.name}"`).join(", ");
      let clause = `FOREIGN KEY (${cols}) REFERENCES "${fTable}" (${fCols})`;
      if (fk.onDelete) clause += ` ON DELETE ${fk.onDelete.toUpperCase()}`;
      if (fk.onUpdate) clause += ` ON UPDATE ${fk.onUpdate.toUpperCase()}`;
      parts.push(clause);
    }
    await db.run(sql.raw(`CREATE TABLE IF NOT EXISTS "${cfg.name}" (${parts.join(", ")})`));
  }
}

/** Ensure all SQLite indexes exist — derived from the Drizzle index defs. */
export async function ensureSqliteIndexes(db: any): Promise<void> {
  for (const table of SQLITE_TABLES) {
    const cfg = getTableConfig(table);
    for (const idx of cfg.indexes) {
      const name = idx.config.name;
      const cols = idx.config.columns.map((c: any) => `"${c.name}"`).join(", ");
      const unique = idx.config.unique ? "UNIQUE " : "";
      await db.run(sql.raw(`CREATE ${unique}INDEX IF NOT EXISTS "${name}" ON "${cfg.name}" (${cols})`));
    }
  }
}

/**
 * Ensure all tables exist AND all known columns exist on them, then ensure
 * indexes. Safe to call on every startup. Columns added to pre-existing
 * tables are nullable by design (existing rows); simple schema defaults
 * are applied.
 */
export async function migrateSqliteSchema(db: any): Promise<void> {
  await ensureSqliteTables(db);

  for (const table of SQLITE_TABLES) {
    const cfg = getTableConfig(table);
    const rows: any[] = await db.all(sql.raw(`PRAGMA table_info("${cfg.name}")`));
    const present = new Set(rows.map((r) => r.name));
    for (const col of cfg.columns) {
      if (present.has(col.name)) continue;
      let ddl = `ALTER TABLE "${cfg.name}" ADD COLUMN "${col.name}" ${col.getSQLType()}`;
      const def = renderDefault(col.default);
      if (def !== undefined) ddl += ` DEFAULT ${def}`;
      await db.run(sql.raw(ddl));
    }
  }

  await ensureSqliteIndexes(db);
}
