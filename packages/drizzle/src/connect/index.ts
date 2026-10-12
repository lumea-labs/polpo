import { sql } from "drizzle-orm";
import type { Dialect } from "../utils.js";
import { DrizzleConnectStores, type ConnectStorageOptions } from "./store.js";
import { connectRecordsPg, connectRecordsSqlite } from "./schema.js";

export { DrizzleConnectStores, type ConnectStorageOptions } from "./store.js";
export { connectRecordsPg, connectRecordsSqlite } from "./schema.js";

/** Additive and opt-in: call before constructing a local Connect host. */
export async function ensureConnectSchema(db: any, dialect: Dialect): Promise<void> {
  const statement = sql`CREATE TABLE IF NOT EXISTS connect_records (
    namespace TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
    version TEXT NOT NULL, payload TEXT NOT NULL,
    PRIMARY KEY (namespace, kind, id)
  )`;
  if (dialect === "sqlite") await db.run(statement);
  else await db.execute(statement);
}

export function createSqliteConnectStores(db: any, options: ConnectStorageOptions): DrizzleConnectStores {
  return new DrizzleConnectStores(db, connectRecordsSqlite, options);
}

export function createPgConnectStores(db: any, options: ConnectStorageOptions): DrizzleConnectStores {
  return new DrizzleConnectStores(db, connectRecordsPg, options);
}
