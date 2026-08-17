/**
 * Idempotent PostgreSQL schema migrator.
 *
 * ensurePgSchema only runs CREATE TABLE IF NOT EXISTS — it never evolves
 * tables that already exist, so long-lived databases provisioned by older
 * versions silently miss columns added later (the cloud data plane had to
 * maintain its own ADD COLUMN patch list for exactly this reason).
 *
 * migratePgSchema closes that gap: after ensuring tables exist, it walks
 * the ACTUAL Drizzle table definitions (single source of truth — no
 * hand-maintained column list) and issues
 * `ALTER TABLE .. ADD COLUMN IF NOT EXISTS ..` for every column.
 *
 * Columns added to pre-existing tables are nullable by design (existing
 * rows can't satisfy NOT NULL without a default); when the schema defines
 * a simple default it is applied so new rows keep the canonical shape.
 */

import { sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { ensurePgTables, ensurePgIndexes } from "./migrate.js";
import {
  tasksPg, missionsPg, metadataPg, processesPg,
  runsPg, loopRunsPg,
  sessionsPg, messagesPg,
  logSessionsPg, logEntriesPg,
  modelInvocationLogsPg,
  approvalsPg, memoryPg,
  teamsPg, agentsPg,
  vaultPg, playbooksPg, skillsPg,
  conversationChannelsPg, conversationChannelRoutesPg,
} from "./schema/index.js";

const PG_TABLES = [
  tasksPg, missionsPg, metadataPg, processesPg,
  runsPg, loopRunsPg,
  sessionsPg, messagesPg,
  logSessionsPg, logEntriesPg,
  modelInvocationLogsPg,
  approvalsPg, memoryPg,
  teamsPg, agentsPg,
  vaultPg, playbooksPg, skillsPg,
  conversationChannelsPg, conversationChannelRoutesPg,
];

/** Render a Drizzle column default as SQL, or undefined when it can't be
 *  expressed safely (SQL expressions, functions — the column is simply
 *  added without a default in that case). */
function renderDefault(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
  if (Array.isArray(value) || typeof value === "object") {
    return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
  }
  return undefined;
}

/**
 * Ensure all tables exist AND all known columns exist on them.
 * Safe to call on every startup; each statement is executed individually
 * (compatible with both WebSocket and HTTP drivers, e.g. Neon).
 */
export async function migratePgSchema(db: any): Promise<void> {
  // Tables first, columns second, indexes LAST: an index on a column that
  // predates the column's introduction would fail on old databases.
  await ensurePgTables(db);

  for (const table of PG_TABLES) {
    const cfg = getTableConfig(table);
    for (const col of cfg.columns) {
      let ddl = `ALTER TABLE "${cfg.name}" ADD COLUMN IF NOT EXISTS "${col.name}" ${col.getSQLType()}`;
      const def = renderDefault(col.default);
      if (def !== undefined) {
        ddl += ` DEFAULT ${def}`;
      }
      await db.execute(sql.raw(ddl));
    }
  }

  await ensurePgIndexes(db);
}
