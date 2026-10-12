import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { drizzle as sqliteDrizzle } from "drizzle-orm/better-sqlite3";
import { drizzle as pgDrizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createSqliteStores, createPgStores, migrateSqliteSchema, migratePgSchema } from "@polpo-ai/drizzle";
import { FileTaskStore, FileRunStore, FileApprovalStore } from "@polpo-ai/file-stores";
import { taskExecutionReference } from "@polpo-ai/core/task-execution";
import { taskApprovalContract, approvalRequest, approvalDecision } from "./helpers/task-approval-contract.js";

const databaseUrl = process.env.AGENT_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
for (const kind of ["file", "sqlite", "pg"] as const) {
  describe.skipIf(kind === "pg" && !databaseUrl)(`${kind} joint approval persistence`, () => {
    const namespace = `task_approval_${randomUUID().replaceAll("-", "")}`;
    let directory: string, sqliteA: Database.Database, sqliteB: Database.Database;
    let admin: ReturnType<typeof postgres>, a: ReturnType<typeof postgres>, b: ReturnType<typeof postgres>;
    let first: any, second: any;
    beforeAll(async () => {
      if (kind !== "pg") return;
      admin = postgres(databaseUrl!, { max: 1, onnotice: () => undefined });
      a = postgres(databaseUrl!, { max: 1, connection: { search_path: namespace }, onnotice: () => undefined });
      b = postgres(databaseUrl!, { max: 1, connection: { search_path: namespace, application_name: `${namespace}_b` }, onnotice: () => undefined });
      await admin.unsafe(`CREATE SCHEMA "${namespace}"`);
      await migratePgSchema(pgDrizzle(a));
    });
    beforeEach(async () => {
      directory = mkdtempSync(join(tmpdir(), "polpo-task-approvals-"));
      if (kind === "file") {
        const stores = () => {
          const taskStore = new FileTaskStore(directory);
          return { taskStore, taskExecutionStore: taskStore, runStore: new FileRunStore(directory), approvalStore: new FileApprovalStore(directory) };
        };
        first = stores(); second = stores();
      } else if (kind === "sqlite") {
        sqliteA = new Database(join(directory, "project.db")); sqliteB = new Database(join(directory, "project.db"));
        await migrateSqliteSchema(sqliteDrizzle(sqliteA));
        first = createSqliteStores(sqliteDrizzle(sqliteA)); second = createSqliteStores(sqliteDrizzle(sqliteB));
      } else {
        await a`DELETE FROM approvals`; await a`DELETE FROM tasks`; await a`DELETE FROM runs`;
        first = createPgStores(pgDrizzle(a)); second = createPgStores(pgDrizzle(b));
      }
    });
    afterEach(() => {
      if (kind === "sqlite") { sqliteA.close(); sqliteB.close(); }
      rmSync(directory, { recursive: true, force: true });
    });
    afterAll(async () => {
      if (kind !== "pg") return;
      await Promise.all([a.end(), b.end()]);
      await admin.unsafe(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`); await admin.end();
    });
    taskApprovalContract(async () => ({ ...first, other: second }));

    async function setup() {
      const task = await first.taskStore.createTask({ title: "Review", description: "Work", assignTo: "support", dependsOn: [], expectations: [], metrics: [], maxRetries: 1 });
      const claimed = await first.taskExecutionStore.claimTaskExecution(taskExecutionReference(task), "run");
      const request = approvalRequest(claimed.task);
      return { ...claimed, request, input: approvalDecision(claimed.task, null, request) };
    }
    if (kind !== "file") {
      it("does not treat corrupt stored payload as an omitted approval input", async () => {
        const f = await setup(), request = { ...f.request, payload: undefined };
        await first.approvalStore.upsert(request);
        if (kind === "sqlite") sqliteA.prepare("UPDATE approvals SET payload = ? WHERE id = ?").run("not-json", request.id);
        else await a`UPDATE approvals SET payload = ${JSON.stringify("not-json")}::jsonb WHERE id = ${request.id}`;
        await expect(second.approvalStore.get(request.id)).rejects.toThrow("Invalid stored approval payload");
        await expect(first.taskExecutionStore.commitTaskApprovalDecision(approvalDecision(f.task, request, { ...request, status: "approved" })))
          .rejects.toThrow("Invalid stored approval payload");
        expect(await second.taskStore.getTask(f.task.id)).toEqual(f.task);
        expect(await second.runStore.getRun(f.run.id)).toEqual(f.run);
      });

      it.each(["tasks", "runs", "approvals"].flatMap(table => ["error", "ignored"].map(effect => ({ table, effect }))))
        ("rolls back the entire decision on $table write $effect", async ({ table, effect }) => {
        const f = await setup(), operation = table === "approvals" ? "INSERT" : "UPDATE";
        if (kind === "sqlite") sqliteA.exec(`CREATE TRIGGER reject_approval BEFORE ${operation} ON ${table} BEGIN SELECT ${effect === "error" ? "RAISE(ABORT, 'fixture storage failure')" : "RAISE(IGNORE)"}; END`);
        else {
          await a.unsafe(`CREATE FUNCTION reject_approval() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${effect === "error" ? "RAISE EXCEPTION 'fixture storage failure'" : "RETURN NULL"}; END $$`);
          await a.unsafe(`CREATE TRIGGER reject_approval BEFORE ${operation} ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_approval()`);
        }
        try {
          await expect(first.taskExecutionStore.commitTaskApprovalDecision(f.input)).rejects.toThrow();
          expect(await second.taskStore.getTask(f.task.id)).toEqual(f.task);
          expect(await second.runStore.getRun(f.run.id)).toEqual(f.run);
          expect(await second.approvalStore.list()).toEqual([]);
        } finally {
          if (kind === "sqlite") sqliteA.exec("DROP TRIGGER reject_approval");
          else { await a.unsafe(`DROP TRIGGER reject_approval ON ${table}`); await a`DROP FUNCTION reject_approval()`; }
        }
      });

      it.each(["claim", "resolution"])("rolls back an ignored %s write", async operation => {
        const f = await setup();
        let task = f.task, run = f.run;
        let input = f.input;
        if (operation === "claim") {
          task = (await first.taskExecutionStore.mutateTaskExecution(taskExecutionReference(task), { type: "requeue", countRetry: false, reason: "fixture" })).task;
          run = await first.runStore.getRun(run.id);
          input = approvalDecision(task, null, f.request);
          input.operation = { type: "claim", runId: "next-run" };
        } else {
          task = (await first.taskExecutionStore.commitTaskApprovalDecision(input)).task;
          run = await first.runStore.getRun(run.id);
          input = approvalDecision(task, f.request, { ...f.request, status: "approved" });
          input.operation = { type: "requeue", countRetry: false, reason: "Approved" };
        }
        const table = operation === "claim" ? "runs" : "approvals", verb = operation === "claim" ? "INSERT" : "UPDATE";
        if (kind === "sqlite") sqliteA.exec(`CREATE TRIGGER ignore_write BEFORE ${verb} ON ${table} BEGIN SELECT RAISE(IGNORE); END`);
        else {
          await a`CREATE FUNCTION ignore_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`;
          await a.unsafe(`CREATE TRIGGER ignore_write BEFORE ${verb} ON ${table} FOR EACH ROW EXECUTE FUNCTION ignore_write()`);
        }
        try {
          await expect(first.taskExecutionStore.commitTaskApprovalDecision(input)).rejects.toThrow();
          expect(await second.taskStore.getTask(task.id)).toEqual(task);
          expect(await second.runStore.getRun(run.id)).toEqual(run);
          expect(await second.runStore.getRun("next-run")).toBeUndefined();
          expect(await second.approvalStore.list()).toEqual(operation === "claim" ? [] : [f.request]);
        } finally {
          if (kind === "sqlite") sqliteA.exec("DROP TRIGGER ignore_write");
          else { await a.unsafe(`DROP TRIGGER ignore_write ON ${table}`); await a`DROP FUNCTION ignore_write()`; }
        }
      });
    }
    if (kind === "pg") {
  it("uses the supplied transaction provider and leaves a recoverable commit after lost acknowledgement", async () => {
    const f = await setup();
    const hosted = createPgStores({}, { transaction: async execute => {
      await pgDrizzle(a).transaction(execute); throw new Error("fixture acknowledgement lost");
    } });
    await expect(hosted.taskExecutionStore.commitTaskApprovalDecision(f.input)).rejects.toThrow("acknowledgement lost");
    expect(await second.taskStore.getTask(f.task.id)).toMatchObject({ status: "awaiting_approval", executionRevision: 2 });
    expect(await second.runStore.getRun(f.run.id)).toMatchObject({ status: "killed" });
    expect(await second.approvalStore.get(f.request.id)).toEqual(f.request);
    await expect(second.taskExecutionStore.commitTaskApprovalDecision(f.input)).rejects.toMatchObject({ code: "task_execution_conflict" });
  });

  it("refuses a driver which cannot transact", async () => {
    const f = await setup();
    await expect(createPgStores({}).taskExecutionStore.commitTaskApprovalDecision(f.input))
      .rejects.toMatchObject({ code: "task_execution_unsupported" });
    expect(await second.taskStore.getTask(f.task.id)).toEqual(f.task);
    expect(await second.approvalStore.list()).toEqual([]);
  });

  it("protects an absent approval assertion from an independent plain upsert until commit", async () => {
    const f = await setup();
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const paused = createPgStores({}, { transaction: execute => pgDrizzle(a).transaction(async tx => {
      const result = await execute(tx); entered(); await released; return result;
    }) });
    const deciding = paused.taskExecutionStore.commitTaskApprovalDecision(f.input);
    let writer: Promise<void> | undefined;
    try {
      await Promise.race([ready, deciding.then(() => { throw new Error("Missing transaction barrier"); })]);
      writer = second.approvalStore.upsert({ ...f.request, status: "rejected" });
      const deadline = Date.now() + 3_000;
      let blocked = false;
      while (Date.now() < deadline) {
        const rows = await admin`SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name = ${`${namespace}_b`} AND wait_event_type = 'Lock'`;
        if (rows[0].count > 0) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      expect(blocked).toBe(true);
      release(); await deciding; await writer;
      expect(await second.taskStore.getTask(f.task.id)).toMatchObject({ status: "awaiting_approval" });
      expect(await second.approvalStore.get(f.request.id)).toMatchObject({ status: "rejected" });
    } finally { release(); await deciding; await writer; }
  });
    }
  });
}
