#!/usr/bin/env node

/**
 * Detached subprocess runner.
 * Spawned by the orchestrator for each agent task.
 * Lifecycle:
 *   1. Read --config <path> from args (or --run-id <id> --db <url> in DB mode)
 *   2. Open own RunStore connection (Drizzle SQLite or PG)
 *   3. Delegate the run lifecycle to executeRun() (shared with the
 *      InProcessSpawner — see run-lifecycle.ts)
 *   4. Cleanup & exit
 *
 * Exit code contract (unchanged — this file is the cloud sandbox entry,
 * `polpo-ai/dist/core/runner.js`):
 *   - exit 1: bad CLI args, unreadable config, engine spawn failure, fatal error
 *   - exit 0: everything else — task-level failures are persisted on the
 *     run record (status failed/killed), not surfaced as a process error
 */

import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { FileRunStore } from "@polpo-ai/file-stores";
import type { RunStore } from "@polpo-ai/core/run-store";
import type { LogStore } from "@polpo-ai/core/log-store";
import type { RunnerConfig } from "@polpo-ai/core/types";
import type { VaultStore } from "@polpo-ai/core/vault-store";
import type { MemoryStore } from "@polpo-ai/core/memory-store";
import { NodeFileSystem } from "../adapters/node-filesystem.js";
import { NodeShell } from "../adapters/node-shell.js";
import { executeRun } from "./run-lifecycle.js";

function readConfigFromFile(): RunnerConfig {
  const idx = process.argv.indexOf("--config");
  if (idx < 0 || !process.argv[idx + 1]) {
    console.error("Usage: runner --config <path> | --run-id <id> --db <url>");
    process.exit(1);
  }
  const configPath = process.argv[idx + 1];
  const raw = readFileSync(configPath, "utf-8");
  try {
    return JSON.parse(raw) as RunnerConfig;
  } catch (err) {
    console.error(`Failed to parse runner config at ${configPath}:`, err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

/**
 * DB mode: read RunnerConfig from database via RunStore.
 * Usage: runner --run-id <id> --db <postgres-url>
 */
async function readConfigFromDb(): Promise<RunnerConfig> {
  const runIdIdx = process.argv.indexOf("--run-id");
  const dbIdx = process.argv.indexOf("--db");
  if (runIdIdx < 0 || dbIdx < 0 || !process.argv[runIdIdx + 1] || !process.argv[dbIdx + 1]) {
    console.error("Usage: runner --run-id <id> --db <postgres-url>");
    process.exit(1);
  }
  const runId = process.argv[runIdIdx + 1];
  const dbUrl = process.argv[dbIdx + 1];

  const { createPgStores } = await import("@polpo-ai/drizzle");
  const postgres = (await import("postgres")).default;
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const sql = postgres(dbUrl);
  const db = drizzle(sql);
  const store = createPgStores(db).runStore;

  const run = await store.getRun(runId);
  if (!run?.config) {
    console.error(`Run ${runId} not found or has no config in DB`);
    await sql.end();
    process.exit(1);
  }

  await sql.end();
  return run.config;
}

interface RunnerStores {
  runStore: RunStore;
  logStore?: LogStore;
  vaultStore?: VaultStore;
  memoryStore?: MemoryStore;
}

async function createStores(config: RunnerConfig): Promise<RunnerStores> {
  if (config.storage === "postgres" && config.databaseUrl) {
    const { createPgStores } = await import("@polpo-ai/drizzle");
    const postgres = (await import("postgres")).default;
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const sql = postgres(config.databaseUrl);
    const db = drizzle(sql);
    const stores = createPgStores(db);
    return { runStore: stores.runStore, logStore: stores.logStore, vaultStore: stores.vaultStore, memoryStore: stores.memoryStore };
  }
  if (config.storage === "sqlite") {
    const { createSqliteStores } = await import("@polpo-ai/drizzle");
    const { createRequire } = await import("node:module");
    const req = createRequire(import.meta.url);
    const Database = req("better-sqlite3");
    const dbPath = join(config.polpoDir, "state.db");
    const sqlite = new Database(dbPath);
    sqlite.exec("PRAGMA journal_mode = WAL");
    sqlite.exec("PRAGMA synchronous = NORMAL");
    sqlite.exec("PRAGMA foreign_keys = ON");
    const { drizzle } = await import("drizzle-orm/better-sqlite3");
    const db = drizzle(sqlite);
    const { migrateSqliteSchema } = await import("@polpo-ai/drizzle");
    await migrateSqliteSchema(db);
    const stores = createSqliteStores(db);
    return { runStore: stores.runStore, logStore: stores.logStore, vaultStore: stores.vaultStore, memoryStore: stores.memoryStore };
  }
  return { runStore: new FileRunStore(config.polpoDir) };
}

async function main(): Promise<void> {
  const isDbMode = process.argv.includes("--run-id");
  const config = isDbMode ? await readConfigFromDb() : readConfigFromFile();

  // Apply provider overrides from the config (custom baseUrl endpoints).
  // The runner never reads polpo.json, so without this custom-provider
  // agents resolve against the static provider map and fail.
  if (config.providers && Object.keys(config.providers).length > 0) {
    const { setProviderOverrides } = await import("@polpo-ai/llm");
    setProviderOverrides(config.providers);
  }
  const { runStore, logStore, vaultStore, memoryStore } = await createStores(config);

  // SIGTERM handler: graceful kill (executeRun marks the run "killed")
  const abort = new AbortController();
  process.on("SIGTERM", () => abort.abort());

  const configPath = isDbMode
    ? `db://${config.runId}`
    : join(process.argv[process.argv.indexOf("--config") + 1]);

  const outcome = await executeRun(config, {
    runStore,
    // The runner owns a private LogStore instance, so a per-run session is
    // simply startSession() on it (postgres/sqlite only — file mode keeps
    // the JSONL activity log as the sole transcript side-channel).
    createLogSession: logStore
      ? async () => {
          const sessionId = await logStore.startSession();
          return { sessionId, append: (entry) => logStore.append(entry) };
        }
      : undefined,
    vaultStore,
    memoryStore,
    // Runner is a subprocess — creates its own fs/shell instances
    fs: new NodeFileSystem(),
    shell: new NodeShell(),
    pid: process.pid,
    configPath,
    signal: abort.signal,
  });

  // Engine spawn failure is the one lifecycle path that exits non-zero.
  if (outcome.spawnError) {
    await runStore.close();
    process.exit(1);
  }

  // Cleanup config file (only in file mode, not DB mode)
  if (!isDbMode) {
    try { unlinkSync(configPath); } catch { /* already gone */ }
  }

  await runStore.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("Runner fatal error:", err);
  process.exit(1);
});
