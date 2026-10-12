import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { drizzle as sqliteDrizzle } from "drizzle-orm/better-sqlite3";
import { drizzle as pgDrizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { RunRecord, RunStore } from "@polpo-ai/core/run-store";
import type { RunnerConfig } from "@polpo-ai/core/types";
import { DrizzleRunStore } from "../../../drizzle/src/stores/run-store.js";
import { runsPg, runsSqlite } from "../../../drizzle/src/schema/runs.js";
import { migrateSqliteSchema } from "../../../drizzle/src/sqlite-migrator.js";
import { migratePgSchema } from "../../../drizzle/src/migrator.js";
import { FileRunStore } from "../../../file-stores/src/file-run-store.js";
import { EphemeralRunStore } from "../server/ephemeral-run-store.js";

const databaseUrl = process.env.AGENT_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const initialTime = "2026-10-11T00:00:00.000Z";
function config(runId: string): RunnerConfig {
  return { runId, taskId: "task", agent: { name: "support" }, agentIdentity: { name: "support", incarnation: "original" },
    task: { id: "task", title: "Read", description: "Read", assignTo: "support", status: "in_progress", dependsOn: [],
      expectations: [], metrics: [], retries: 0, maxRetries: 0, createdAt: initialTime, updatedAt: initialTime },
    executionMode: "in-process", cwd: "/workspace", polpoDir: "/workspace/.polpo", outputDir: "/workspace/output" };
}
function record(runId = "run"): RunRecord {
  return { id: runId, taskId: "task", taskExecutionRevision: 7, agentName: "support", pid: 123, status: "running",
    user: "person-a", sessionId: "session-a", startedAt: initialTime, updatedAt: initialTime, configPath: "pending://run",
    activity: { filesCreated: ["existing.txt"], filesEdited: [], toolCalls: 3, totalTokens: 12, lastUpdate: initialTime },
    executionMode: "subprocess", engine: "agent", delivery: "background", config: config(runId),
    resumeState: { context: {}, steps: [], history: [], turn: 3, createdAt: initialTime },
    result: { exitCode: 0, stdout: "checkpoint", stderr: "", duration: 10 } };
}
function deferred() {
  let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() };
}

for (const kind of ["ephemeral", "file", "sqlite", "pg"] as const) {
  describe.skipIf(kind === "pg" && !databaseUrl)(`${kind} update-only Run configuration`, () => {
    let a: RunStore, b: RunStore, root: string;
    let sqliteA: Database.Database, sqliteB: Database.Database;
    let admin: ReturnType<typeof postgres>, clientA: ReturnType<typeof postgres>, clientB: ReturnType<typeof postgres>;
    const namespace = `run_config_${randomUUID().replaceAll("-", "")}`;
    beforeAll(async () => {
      if (kind !== "pg") return;
      admin = postgres(databaseUrl!, { max: 1, onnotice: () => undefined });
      clientA = postgres(databaseUrl!, { max: 1, connection: { search_path: namespace, application_name: namespace }, onnotice: () => undefined });
      clientB = postgres(databaseUrl!, { max: 1, connection: { search_path: namespace }, onnotice: () => undefined });
      await admin.unsafe(`CREATE SCHEMA "${namespace}"`);
      await migratePgSchema(pgDrizzle(clientA));
    });
    beforeEach(async () => {
      root = mkdtempSync(join(tmpdir(), "polpo-run-config-"));
      if (kind === "ephemeral") a = b = new EphemeralRunStore();
      else if (kind === "file") { a = new FileRunStore(root); b = new FileRunStore(root); }
      else if (kind === "sqlite") {
        sqliteA = new Database(join(root, "project.db")); sqliteB = new Database(join(root, "project.db"));
        await migrateSqliteSchema(sqliteDrizzle(sqliteA));
        a = new DrizzleRunStore(sqliteDrizzle(sqliteA), runsSqlite, "sqlite");
        b = new DrizzleRunStore(sqliteDrizzle(sqliteB), runsSqlite, "sqlite");
      } else {
        await clientA`DELETE FROM runs`;
        a = new DrizzleRunStore(pgDrizzle(clientA), runsPg, "pg");
        b = new DrizzleRunStore(pgDrizzle(clientB), runsPg, "pg");
      }
    });
    afterEach(async () => {
      if (kind === "sqlite") { sqliteA.close(); sqliteB.close(); }
      rmSync(root, { recursive: true, force: true });
    });
    afterAll(async () => {
      if (kind !== "pg") return;
      await Promise.all([clientA.end(), clientB.end()]);
      await admin.unsafe(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`); await admin.end();
    });

    it("updates only config metadata, preserving current execution state", async () => {
      await a.upsertRun(record());
      const oldRead = structuredClone((await a.getRun("run"))!);
      await b.updateActivity("run", { ...oldRead.activity, toolCalls: 9 });
      const before = structuredClone((await b.getRun("run"))!);
      const next = { ...config("run"), sandbox: { isolation: "fresh" as const } };
      expect(await a.updateRunConfig!("run", next, "db://run")).toBe(true);
      const after = (await b.getRun("run"))!;
      expect(after).toEqual({ ...before, config: next, configPath: "db://run", executionMode: next.executionMode, updatedAt: after.updatedAt });
      expect(after.updatedAt).not.toBe(initialTime);
    });
    it("preserves the recorded execution mode when the config leaves it unspecified", async () => {
      await a.upsertRun(record());
      const { executionMode: _executionMode, ...next } = config("run");
      expect(await a.updateRunConfig!("run", next, "db://run")).toBe(true);
      expect(await b.getRun("run")).toMatchObject({ config: next, executionMode: "subprocess" });
    });
    it.each(["missing", "deleted"] as const)("never creates a %s Run", async mode => {
      if (mode === "deleted") { await a.upsertRun(record()); await a.getRun("run"); await b.deleteRun("run"); }
      expect(await a.updateRunConfig!("run", config("run"), "db://run")).toBe(false);
      expect(await b.getRun("run")).toBeUndefined();
    });
    it.each(["completed", "failed", "killed"] as const)("does not touch a %s Run", async status => {
      await a.upsertRun(record());
      await b.completeRun("run", status, { exitCode: 143, stdout: "terminal", stderr: "fixed", duration: 20 });
      await b.markRunCollected!("run");
      const before = structuredClone(await b.getRun("run"));
      expect(await a.updateRunConfig!("run", config("run"), "db://late")).toBe(false);
      expect(await b.getRun("run")).toEqual(before);
    });
    it("preserves a terminal result under concurrent completion and config writes", async () => {
      await a.upsertRun(record());
      const result = { exitCode: 143, stdout: "terminal", stderr: "cancelled", duration: 20 };
      const [updated] = await Promise.all([a.updateRunConfig!("run", config("run"), "db://run"), b.completeRun("run", "killed", result)]);
      expect(typeof updated).toBe("boolean");
      expect(await a.getRun("run")).toMatchObject({ status: "killed", result, taskExecutionRevision: 7, startedAt: initialTime });
      expect(await a.updateRunConfig!("run", config("run"), "db://after-exit")).toBe(false);
    });
    if (kind === "pg") it.each(["completion", "delete"] as const)("checks %s after waiting for a PostgreSQL row lock", async operation => {
      expect(a.updateRunConfig).toBeTypeOf("function");
      await a.upsertRun(record());
      const locked = deferred(), release = deferred();
      const writer = clientB.begin(async tx => {
        if (operation === "delete") await tx.unsafe("DELETE FROM runs WHERE id = 'run'");
        else await tx.unsafe(`UPDATE runs SET status = 'killed', result = '{"exitCode":143,"stdout":"","stderr":"cancelled","duration":1}'::jsonb WHERE id = 'run'`);
        locked.resolve(); await release.promise;
      });
      let pending: Promise<boolean> | undefined;
      try {
        await locked.promise;
        pending = a.updateRunConfig!("run", config("run"), "db://late");
        await vi.waitFor(async () => {
          const rows = await admin`SELECT 1 FROM pg_stat_activity WHERE application_name = ${namespace} AND wait_event_type = 'Lock'`;
          expect(rows).toHaveLength(1);
        });
        release.resolve(); await writer;
        expect(await pending).toBe(false);
        if (operation === "delete") expect(await a.getRun("run")).toBeUndefined();
        else expect(await a.getRun("run")).toMatchObject({ status: "killed", configPath: "pending://run", result: { stderr: "cancelled" } });
      } finally { release.resolve(); await writer; await pending; }
    });
  });
}
