/**
 * migratePgSchema — evolves pre-existing tables to the current schema.
 *
 * Simulates a database provisioned by an OLDER version (tasks table with a
 * subset of today's columns), runs the migrator, and verifies every column
 * from the canonical Drizzle definition exists and the stores work.
 *
 * Requires TEST_DATABASE_URL (default: postgresql://postgres:postgres@localhost:5432/polpo_test).
 * Skipped when no PG connection is available — CI provides a container.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { createPgStores } from "../index.js";
import { migratePgSchema } from "../migrator.js";
import { tasksPg } from "../schema/index.js";

const BASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/polpo_test";
// Dedicated database: this suite drops/recreates tables to simulate an old
// deployment, and must not race the stores-pg suite on the shared test DB.
const MIGRATOR_DB = "polpo_test_migrator";
const DATABASE_URL = BASE_URL.replace(/\/[^/]+$/, `/${MIGRATOR_DB}`);

let canConnect = false;
try {
  const admin = postgres(BASE_URL, { max: 1, connect_timeout: 3 });
  await admin`SELECT 1`;
  const exists = await admin`SELECT 1 FROM pg_database WHERE datname = ${MIGRATOR_DB}`;
  if (exists.length === 0) {
    await admin.unsafe(`CREATE DATABASE ${MIGRATOR_DB}`);
  }
  await admin.end();
  const probe = postgres(DATABASE_URL, { max: 1, connect_timeout: 3 });
  await probe`SELECT 1`;
  await probe.end();
  canConnect = true;
} catch {
  canConnect = false;
}

describe.skipIf(!canConnect)("migratePgSchema", () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    client = postgres(DATABASE_URL, { max: 4 });
    db = drizzle(client);

    // Simulate a v-old database: drop everything, then create a degraded
    // tasks table with only the original column subset.
    await db.execute(sql.raw(`DROP TABLE IF EXISTS conversation_channel_routes, conversation_channels, log_entries, messages, approvals, runs, loop_runs, tasks, missions, processes, metadata, sessions, log_sessions, memory, agents, teams, vault, playbooks, skills CASCADE`));
    await db.execute(sql.raw(`CREATE TABLE tasks (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      description TEXT NOT NULL,
      assign_to   TEXT NOT NULL,
      status      VARCHAR(32) NOT NULL DEFAULT 'pending',
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    )`));
  });

  afterAll(async () => {
    await client?.end();
  });

  it("adds every missing column from the canonical Drizzle schema", async () => {
    await migratePgSchema(db);

    const rows = await db.execute(sql.raw(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'tasks'`,
    ));
    const list: any[] = Array.isArray(rows) ? rows : (rows as any).rows;
    const present = new Set(list.map((r: any) => r.column_name));

    const expected = getTableConfig(tasksPg).columns.map((c) => c.name);
    expect(expected.length).toBeGreaterThan(10);
    for (const col of expected) {
      expect(present.has(col), `missing column: ${col}`).toBe(true);
    }
  }, 15_000);

  it("is idempotent — a second run changes nothing and does not throw", async () => {
    await migratePgSchema(db);
    await migratePgSchema(db);
  }, 15_000);

  it("stores work against the migrated legacy table", async () => {
    const stores = createPgStores(db);
    const now = new Date().toISOString();
    const created = await stores.taskStore.createTask({
      title: "post-migration task",
      description: "written through the store after column backfill",
      assignTo: "agent-1",
      status: "pending",
      expectations: [],
      dependsOn: [],
      createdAt: now,
      updatedAt: now,
    } as any);

    const task = await stores.taskStore.getTask(created.id);
    expect(task).toBeTruthy();
    expect(task!.title).toBe("post-migration task");
  }, 15_000);
});
