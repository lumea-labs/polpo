import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { drizzle as sqliteDrizzle } from "drizzle-orm/better-sqlite3";
import { drizzle as pgDrizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createSqliteStores, createPgStores, migrateSqliteSchema, migratePgSchema } from "@polpo-ai/drizzle";
import { FileTaskStore, FileRunStore } from "@polpo-ai/file-stores";
import { taskExecutionReference, type ConditionalTaskExecutionStore } from "@polpo-ai/core/task-execution";
import type { TaskStore } from "@polpo-ai/core/task-store";
import type { RunStore } from "@polpo-ai/core/run-store";

type Fixture = { taskStore: TaskStore; runStore: RunStore; executions: ConditionalTaskExecutionStore };
const databaseUrl = process.env.AGENT_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
for (const kind of ["file", "sqlite", "pg"] as const) {
  describe.skipIf(kind === "pg" && !databaseUrl)(`${kind} atomic Task executions`, () => {
    let root: string, a: Fixture, b: Fixture, sqliteA: Database.Database, sqliteB: Database.Database;
    let admin: ReturnType<typeof postgres>, clientA: ReturnType<typeof postgres>, clientB: ReturnType<typeof postgres>;
    const namespace = `task_execution_${randomUUID().replaceAll("-", "")}`;
    const fromSql = (stores: ReturnType<typeof createSqliteStores>): Fixture => ({ ...stores, executions: stores.taskExecutionStore });
    beforeAll(async () => {
      if (kind !== "pg") return;
      admin = postgres(databaseUrl!, { max: 1, onnotice: () => undefined });
      clientA = postgres(databaseUrl!, { max: 1, connection: { search_path: namespace, application_name: `${namespace}_a` }, onnotice: () => undefined });
      clientB = postgres(databaseUrl!, { max: 1, connection: { search_path: namespace, application_name: `${namespace}_b` }, onnotice: () => undefined });
      await admin.unsafe(`CREATE SCHEMA "${namespace}"`);
      await migratePgSchema(pgDrizzle(clientA));
    });
    beforeEach(async () => {
      root = mkdtempSync(join(tmpdir(), "polpo-task-execution-"));
      if (kind === "file") {
        const make = () => { const taskStore = new FileTaskStore(root); return { taskStore, runStore: new FileRunStore(root), executions: taskStore }; };
        a = make(); b = make();
      } else if (kind === "sqlite") {
        sqliteA = new Database(join(root, "project.db")); sqliteB = new Database(join(root, "project.db"));
        await migrateSqliteSchema(sqliteDrizzle(sqliteA));
        a = fromSql(createSqliteStores(sqliteDrizzle(sqliteA))); b = fromSql(createSqliteStores(sqliteDrizzle(sqliteB)));
      } else {
        await clientA`DELETE FROM tasks`; await clientA`DELETE FROM runs`;
        a = fromSql(createPgStores(pgDrizzle(clientA))); b = fromSql(createPgStores(pgDrizzle(clientB)));
      }
    });
    afterEach(() => { if (kind === "sqlite") { sqliteA.close(); sqliteB.close(); } rmSync(root, { recursive: true, force: true }); });
    afterAll(async () => {
      if (kind !== "pg") return;
      await Promise.all([clientA.end(), clientB.end()]);
      await admin.unsafe(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`); await admin.end();
    });
    const create = () => a.taskStore.createTask({ title: "Read Drive", description: "Read the authorized account", assignTo: "support",
      dependsOn: [], expectations: [], metrics: [], maxRetries: 2, user: "person-a", metadata: { connectionNamespace: "app-a" } });

    it.each(["retry", "edit", "delete"] as const)("rejects a decision after dependency %s without changing its target", async change => {
      const task = (await a.taskStore.getTask((await create()).id))!, dependency = await create();
      const guards = [{ taskId: task.id, snapshot: task }, { taskId: dependency.id, snapshot: dependency }];
      if (change === "retry") await b.executions.mutateTaskExecution(taskExecutionReference(dependency), { type: "requeue", countRetry: false, reason: "New input" });
      else if (change === "edit") await b.taskStore.updateTask(dependency.id, { description: "Changed in the same generation" });
      else await b.taskStore.deleteTask(dependency.id);
      await expect(a.executions.mutateTaskExecutionConditionally(taskExecutionReference(task), {
        type: "requeue", countRetry: false, reason: "Delayed absorption", updates: { description: "Stale replacement", dependsOn: [] },
      }, guards)).rejects.toMatchObject({ code: "task_execution_conflict" });
      expect(await a.taskStore.getTask(task.id)).toEqual(task);
    });

    it("publishes complete guarded replacement input and fences a waiting scheduler", async () => {
      const task = (await a.taskStore.getTask((await create()).id))!, dependency = await create();
      const result = await a.executions.mutateTaskExecutionConditionally(taskExecutionReference(task), {
        type: "requeue", countRetry: false, reason: "Absorb", updates: { description: "Complete input", originalDescription: task.description, dependsOn: [], resolutionAttempts: 1 },
      }, [{ taskId: task.id, snapshot: task }, { taskId: dependency.id, snapshot: dependency }]);
      expect(result.task).toMatchObject({ description: "Complete input", originalDescription: task.description, resolutionAttempts: 1, executionRevision: 1 });
      expect(await b.taskStore.getTask(task.id)).toEqual(result.task);
      await expect(b.executions.claimTaskExecution(taskExecutionReference(task), randomUUID())).rejects.toMatchObject({ code: "task_execution_conflict" });
      const claimed = await b.executions.claimTaskExecution(taskExecutionReference(result.task), randomUUID());
      expect(claimed.task.description).toBe("Complete input");
    });

    it("checks missing rows and rejects malformed or duplicate read conditions", async () => {
      const task = (await a.taskStore.getTask((await create()).id))!, dependency = await create();
      const cancel = { type: "cancel" } as const, reference = taskExecutionReference(task);
      await expect(a.executions.mutateTaskExecutionConditionally(reference, cancel, [{ taskId: dependency.id, snapshot: null }]))
        .rejects.toMatchObject({ code: "task_execution_conflict" });
      for (const guards of [[], [{ taskId: "../invalid", snapshot: null }],
        [{ taskId: task.id, snapshot: dependency }], [{ taskId: task.id, snapshot: task }, { taskId: task.id, snapshot: null }]]) {
        await expect(a.executions.mutateTaskExecutionConditionally(reference, cancel, guards)).rejects.toMatchObject({ code: "task_execution_invalid" });
      }
      expect(await a.taskStore.getTask(task.id)).toEqual(task);
      const stopped = await a.executions.mutateTaskExecutionConditionally(reference, cancel, [{ taskId: "not-created", snapshot: null }]);
      expect(stopped.task.status).toBe("failed");
    });

    it("normalizes cleared counters and returns the same state that was persisted", async () => {
      const first = await a.executions.claimTaskExecution(taskExecutionReference(await create()), randomUUID());
      const ref = taskExecutionReference(first.task);
      await a.executions.mutateTaskExecution(ref, { type: "patch", updates: {
        fixAttempts: 2, questionRounds: 3, resolutionAttempts: 1,
      } });
      const result = await b.executions.mutateTaskExecution(ref, { type: "patch", updates: {
        fixAttempts: undefined, questionRounds: undefined, resolutionAttempts: undefined,
        phase: undefined, metadata: undefined, result: undefined,
      } });
      expect(result.task).toMatchObject({ fixAttempts: 0, questionRounds: 0, resolutionAttempts: 0 });
      expect(result.task.phase).toBeUndefined(); expect(result.task.metadata).toBeUndefined();
      expect(result.task).toEqual(await a.taskStore.getTask(first.task.id));
    });

    it("rejects clearing required fields without changing the Task or Run", async () => {
      const first = await a.executions.claimTaskExecution(taskExecutionReference(await create()), randomUUID());
      for (const field of ["title", "description", "assignTo", "dependsOn", "expectations", "metrics", "maxRetries", "createdAt", "updatedAt"]) {
        await expect(b.executions.mutateTaskExecution(taskExecutionReference(first.task), {
          type: "patch", updates: { [field]: undefined },
        })).rejects.toMatchObject({ code: "task_execution_invalid" });
        expect(await a.taskStore.getTask(first.task.id)).toEqual(first.task);
        expect(await a.runStore.getRun(first.run.id)).toEqual(first.run);
      }
    });

    it("gives competing claimers one winner with one initial Run and persisted principal", async () => {
      const task = await create();
      const results = await Promise.allSettled([a, b].map(store => store.executions.claimTaskExecution(taskExecutionReference(task), randomUUID())));
      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
      expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "task_execution_conflict" } });
      const current = (await b.taskStore.getTask(task.id))!;
      expect(current).toMatchObject({ status: "in_progress", executionRevision: 1, user: "person-a", metadata: { connectionNamespace: "app-a" } });
      expect(await b.runStore.getActiveRuns()).toEqual([expect.objectContaining({ id: current.activeRunId, taskId: task.id,
        taskExecutionRevision: 1, agentName: "support", user: "person-a", status: "running", pid: 0 })]);
    });

    it("cancels pending work before a stale scheduler can create a Run", async () => {
      const task = await create(), expected = taskExecutionReference(task), runId = randomUUID();
      await a.executions.mutateTaskExecution(expected, { type: "cancel" });
      await expect(b.executions.claimTaskExecution(expected, runId)).rejects.toMatchObject({ code: "task_execution_conflict" });
      expect(await b.taskStore.getTask(task.id)).toMatchObject({ status: "failed", executionRevision: 1 });
      expect(await b.runStore.getRun(runId)).toBeUndefined();
    });

    it("cancels Task and initial Run together, then fences cancellation and results from a retry", async () => {
      const task = await create();
      const first = await a.executions.claimTaskExecution(taskExecutionReference(task), randomUUID());
      const oldRef = taskExecutionReference(first.task);
      await b.executions.mutateTaskExecution(oldRef, { type: "cancel", reason: "Stopped by operator" });
      const stopped = (await a.taskStore.getTask(task.id))!;
      expect(stopped).toMatchObject({ status: "failed", executionRevision: 2, result: { stderr: "Stopped by operator" } });
      expect(stopped.activeRunId).toBeUndefined();
      expect(await a.runStore.getRun(first.run.id)).toMatchObject({ status: "killed", taskExecutionRevision: 1 });
      const pending = (await a.executions.mutateTaskExecution(taskExecutionReference(stopped), { type: "transition", status: "pending" })).task;
      const second = await b.executions.claimTaskExecution(taskExecutionReference(pending), randomUUID());
      for (const mutation of [{ type: "cancel" }, { type: "patch", updates: { sessionId: "old-session", outcomes: [], result: { exitCode: 0, stdout: "stale", stderr: "", duration: 1 } } },
        { type: "transition", status: "review" }] as const) {
        await expect(a.executions.mutateTaskExecution(oldRef, mutation)).rejects.toMatchObject({ code: "task_execution_conflict" });
      }
      expect(await a.taskStore.getTask(task.id)).toEqual(second.task);
      expect(await a.runStore.getRun(second.run.id)).toEqual(second.run);
    });

    it("invalidates a recovery/fix generation without burning a retry", async () => {
      const first = await a.executions.claimTaskExecution(taskExecutionReference(await create()), randomUUID());
      const pending = (await b.executions.mutateTaskExecution(taskExecutionReference(first.task), {
        type: "requeue", countRetry: false, reason: "Orphan recovery", updates: { description: "Resume", phase: "execution" },
      })).task;
      expect(pending).toMatchObject({ status: "pending", retries: 0, executionRevision: 2, description: "Resume" });
      expect(await a.runStore.getRun(first.run.id)).toMatchObject({ status: "killed" });
      const second = await a.executions.claimTaskExecution(taskExecutionReference(pending), randomUUID());
      await expect(b.executions.mutateTaskExecution(taskExecutionReference(first.task), { type: "patch", updates: { result: { exitCode: 1, stdout: "", stderr: "old", duration: 0 } } }))
        .rejects.toMatchObject({ code: "task_execution_conflict" });
      expect(await b.taskStore.getTask(pending.id)).toEqual(second.task);
    });

    it("publishes counted retry input from review in a single conditional mutation", async () => {
      const first = await a.executions.claimTaskExecution(taskExecutionReference(await create()), randomUUID());
      await a.taskStore.transition(first.task.id, "review");
      const pending = await b.executions.mutateTaskExecution(taskExecutionReference(first.task), {
        type: "requeue", countRetry: true, reason: "Assessment retry", updates: { description: "Complete retry prompt", phase: "execution", outcomes: [] },
      });
      expect(pending.task).toMatchObject({ status: "pending", retries: 1, executionRevision: 2, description: "Complete retry prompt", outcomes: [] });
      expect(pending.task.activeRunId).toBeUndefined();
      expect(await a.runStore.getRun(first.run.id)).toMatchObject({ status: "killed" });
      await expect(a.executions.mutateTaskExecution(taskExecutionReference(first.task), {
        type: "requeue", countRetry: true, reason: "Duplicate retry",
      })).rejects.toMatchObject({ code: "task_execution_conflict" });
      expect(await a.taskStore.getTask(first.task.id)).toEqual(pending.task);
    });

    it("replaces pending escalation input without allowing the previous queued snapshot to claim", async () => {
      const task = await create();
      const next = await a.executions.mutateTaskExecution(taskExecutionReference(task), {
        type: "requeue", countRetry: false, reason: "Escalation timeout", updates: { assignTo: "fallback" },
      });
      expect(next.task).toMatchObject({ status: "pending", executionRevision: 1, retries: 0, assignTo: "fallback" });
      expect(next.run).toBeUndefined();
      await expect(b.executions.claimTaskExecution(taskExecutionReference(task), randomUUID()))
        .rejects.toMatchObject({ code: "task_execution_conflict" });
      await expect(b.executions.mutateTaskExecution(taskExecutionReference(next.task), { type: "requeue", countRetry: true, reason: "No run to retry" }))
        .rejects.toMatchObject({ code: "task_execution_conflict" });
      expect(await b.taskStore.getTask(task.id)).toEqual(next.task);
    });

    it("keeps a completed Run outcome when cancellation occurs during assessment", async () => {
      const first = await a.executions.claimTaskExecution(taskExecutionReference(await create()), randomUUID());
      const result = { exitCode: 0, stdout: "Completed", stderr: "", duration: 1 };
      await a.runStore.completeRun(first.run.id, "completed", result);
      await b.executions.mutateTaskExecution(taskExecutionReference(first.task), { type: "cancel" });
      expect(await a.runStore.getRun(first.run.id)).toMatchObject({ status: "completed", result });
      expect(await a.taskStore.getTask(first.task.id)).toMatchObject({ status: "failed", executionRevision: 2 });
    });

    it("suspends an attempt atomically while preserving the human approval state", async () => {
      const first = await a.executions.claimTaskExecution(taskExecutionReference(await create()), randomUUID());
      const waiting = await b.taskStore.transition(first.task.id, "awaiting_approval");
      expect(waiting).toMatchObject({ status: "awaiting_approval", executionRevision: 2, retries: 0 });
      expect(waiting.activeRunId).toBeUndefined();
      expect(await a.runStore.getRun(first.run.id)).toMatchObject({ status: "killed" });
      await expect(a.executions.mutateTaskExecution(taskExecutionReference(first.task), { type: "requeue", countRetry: false, reason: "Late veto" }))
        .rejects.toMatchObject({ code: "task_execution_conflict" });
      expect(await a.taskStore.getTask(first.task.id)).toEqual(waiting);
    });

    it.each(["done", "failed"] as const)("cancels a still-active Run when the Task is already %s", async status => {
      const first = await a.executions.claimTaskExecution(taskExecutionReference(await create()), randomUUID());
      if (status === "done") await a.taskStore.transition(first.task.id, "review");
      await a.taskStore.transition(first.task.id, status);
      const result = { exitCode: status === "done" ? 0 : 1, stdout: "Original Task result", stderr: "", duration: 2 };
      await a.taskStore.updateTask(first.task.id, { result });
      await b.executions.mutateTaskExecution(taskExecutionReference(first.task), { type: "cancel" });
      expect(await a.taskStore.getTask(first.task.id)).toMatchObject({ status, result, executionRevision: 2 });
      expect((await a.taskStore.getTask(first.task.id))?.activeRunId).toBeUndefined();
      expect(await a.runStore.getRun(first.run.id)).toMatchObject({ status: "killed" });
      await expect(a.executions.mutateTaskExecution(taskExecutionReference(first.task), { type: "patch", updates: { sessionId: "stale" } }))
        .rejects.toMatchObject({ code: "task_execution_conflict" });
    });

    it("preserves attempt identity through full runner registration and ordinary task patches", async () => {
      const first = await a.executions.claimTaskExecution(taskExecutionReference(await create()), randomUUID());
      await a.runStore.upsertRun({ ...first.run, taskId: "wrong-task", taskExecutionRevision: 99, pid: 12 });
      await a.taskStore.updateTask(first.task.id, { executionRevision: 99, activeRunId: "forged", phase: "review" } as never);
      expect(await b.runStore.getRun(first.run.id)).toMatchObject({ taskId: first.task.id, taskExecutionRevision: 1, pid: 12 });
      expect(await b.taskStore.getTask(first.task.id)).toMatchObject({ executionRevision: 1, activeRunId: first.run.id, phase: "review" });
      await b.executions.mutateTaskExecution(taskExecutionReference(first.task), { type: "cancel" });
      expect(await a.runStore.getRun(first.run.id)).toMatchObject({ status: "killed" });
    });

    it("rejects Run ID reuse and untyped execution-authority patches without partial writes", async () => {
      const first = await a.executions.claimTaskExecution(taskExecutionReference(await create()), randomUUID());
      const task = await create();
      await expect(b.executions.claimTaskExecution(taskExecutionReference(task), first.run.id)).rejects.toMatchObject({ code: "task_execution_conflict" });
      expect(await a.taskStore.getTask(task.id)).toMatchObject({ status: "pending" });
      await expect(b.executions.mutateTaskExecution(taskExecutionReference(first.task), { type: "patch", updates: { executionRevision: 99 } } as never))
        .rejects.toMatchObject({ code: "task_execution_invalid" });
      expect(await a.taskStore.getTask(first.task.id)).toEqual(first.task);
    });

    if (kind !== "file") {
      const rejectRunWrite = async (event: "INSERT" | "UPDATE") => {
        if (kind === "sqlite") sqliteA.exec(`CREATE TRIGGER reject_run BEFORE ${event} ON runs BEGIN SELECT RAISE(ABORT, 'fixture Run write failure'); END`);
        else {
          await clientA`CREATE FUNCTION reject_run_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture Run write failure'; END $$`;
          await clientA.unsafe(`CREATE TRIGGER reject_run BEFORE ${event} ON runs FOR EACH ROW EXECUTE FUNCTION reject_run_write()`);
        }
        return async () => {
          if (kind === "sqlite") sqliteA.exec("DROP TRIGGER reject_run");
          else { await clientA`DROP TRIGGER reject_run ON runs`; await clientA`DROP FUNCTION reject_run_write()`; }
        };
      };
      it("rolls back the Task claim when its initial Run cannot be inserted", async () => {
        const task = await create(), runId = randomUUID();
        const cleanup = await rejectRunWrite("INSERT");
        try {
          await expect(a.executions.claimTaskExecution(taskExecutionReference(task), runId)).rejects.toThrow();
          expect(await b.taskStore.getTask(task.id)).toMatchObject({ status: "pending" });
          expect((await b.taskStore.getTask(task.id))?.activeRunId).toBeUndefined();
          expect(await b.runStore.getRun(runId)).toBeUndefined();
        } finally { await cleanup(); }
        expect((await b.executions.claimTaskExecution(taskExecutionReference(task), runId)).task.status).toBe("in_progress");
      });
      it("rolls back Task cancellation when its Run cannot be stopped durably", async () => {
        const first = await a.executions.claimTaskExecution(taskExecutionReference(await create()), randomUUID());
        const cleanup = await rejectRunWrite("UPDATE");
        try {
          await expect(a.executions.mutateTaskExecution(taskExecutionReference(first.task), { type: "cancel" })).rejects.toThrow();
          expect(await b.taskStore.getTask(first.task.id)).toEqual(first.task);
          expect(await b.runStore.getRun(first.run.id)).toMatchObject({ status: "running" });
        } finally { await cleanup(); }
        await b.executions.mutateTaskExecution(taskExecutionReference(first.task), { type: "cancel" });
        expect(await a.taskStore.getTask(first.task.id)).toMatchObject({ status: "failed" });
        expect(await a.runStore.getRun(first.run.id)).toMatchObject({ status: "killed" });
      });
      it("migrates old rows idempotently without inventing an active execution", async () => {
        const task = await create();
        if (kind === "sqlite") {
          sqliteA.exec("ALTER TABLE tasks DROP COLUMN execution_revision; ALTER TABLE tasks DROP COLUMN active_run_id; ALTER TABLE runs DROP COLUMN task_execution_revision");
          await migrateSqliteSchema(sqliteDrizzle(sqliteA)); await migrateSqliteSchema(sqliteDrizzle(sqliteB));
        } else {
          await clientA`ALTER TABLE tasks DROP COLUMN execution_revision`; await clientA`ALTER TABLE tasks DROP COLUMN active_run_id`;
          await clientA`ALTER TABLE runs DROP COLUMN task_execution_revision`;
          await migratePgSchema(pgDrizzle(clientA)); await migratePgSchema(pgDrizzle(clientB));
        }
        const current = (await b.taskStore.getTask(task.id))!;
        expect(taskExecutionReference(current)).toEqual({ taskId: task.id, revision: 0 });
        expect((await a.executions.claimTaskExecution(taskExecutionReference(current), randomUUID())).task.executionRevision).toBe(1);
      });
    }

    if (kind === "file") {
      it.each(["corrupt-json", "wrong-identity"] as const)("does not accept a %s Task file as a missing dependency", async kind => {
        const first = await a.executions.claimTaskExecution(taskExecutionReference(await create()), randomUUID());
        writeFileSync(join(root, "tasks", "broken-dependency.json"), kind === "corrupt-json" ? "{broken"
          : JSON.stringify({ ...first.task, id: "another-id" }));
        await expect(a.executions.mutateTaskExecutionConditionally(taskExecutionReference(first.task), { type: "cancel" }, [
          { taskId: "broken-dependency", snapshot: null },
        ])).rejects.toMatchObject({ code: "task_execution_invalid" });
        expect(await a.taskStore.getTask(first.task.id)).toEqual(first.task);
        expect(await a.runStore.getRun(first.run.id)).toEqual(first.run);
      });
    }

    if (kind === "pg") {
      it.each(["existing", "missing"] as const)("holds the %s dependency condition until commit against a concurrent writer", async kind => {
        const task = (await a.taskStore.getTask((await create()).id))!, dependency = await create();
        let entered!: () => void, release!: () => void;
        const ready = new Promise<void>(resolve => { entered = resolve; }), wait = new Promise<void>(resolve => { release = resolve; });
        const hosted = createPgStores({}, { transaction: execute => pgDrizzle(clientA).transaction(async tx => {
          const result = await execute(tx); entered(); await wait; return result;
        }) }).taskExecutionStore;
        const deciding = hosted.mutateTaskExecutionConditionally(taskExecutionReference(task), { type: "cancel" }, [
          { taskId: task.id, snapshot: task },
          kind === "existing" ? { taskId: dependency.id, snapshot: dependency } : { taskId: "appears-later", snapshot: null },
        ]);
        let writing: Promise<unknown> | undefined;
        try {
          await Promise.race([ready, deciding.then(() => { throw new Error("Decision completed before the transaction barrier"); })]);
          writing = kind === "existing" ? b.taskStore.updateTask(dependency.id, { description: "Concurrent input" })
            : clientB`INSERT INTO tasks (id, title, description, assign_to, created_at, updated_at)
                VALUES ('appears-later', 'New dependency', 'Created concurrently', 'support', ${task.createdAt}, ${task.createdAt})`.then(value => value);
          // Observe a database lock wait, not a timer-based assumption that a
          // promise happened to remain pending on a slow machine.
          await vi.waitFor(async () => {
            const rows = await admin`SELECT count(*)::int AS count FROM pg_stat_activity
              WHERE application_name = ${`${namespace}_b`} AND wait_event_type = 'Lock'`;
            expect(rows[0].count).toBe(1);
          });
        } finally { release(); await deciding; await writing; }
        expect(await a.taskStore.getTask(task.id)).toMatchObject({ status: "failed" });
        if (kind === "existing") expect(await a.taskStore.getTask(dependency.id)).toMatchObject({ description: "Concurrent input" });
        else expect(await a.taskStore.getTask("appears-later")).toBeDefined();
      });

      it("does not deadlock with an existing row-lock writer when asserting absence", async () => {
        const task = await create();
        let entered!: () => void, release!: () => void;
        const ready = new Promise<void>(resolve => { entered = resolve; }), wait = new Promise<void>(resolve => { release = resolve; });
        // Reproduce the Task writer's SELECT FOR UPDATE -> UPDATE lock upgrade.
        const writer = clientB.begin(async tx => {
          await tx`SELECT id FROM tasks WHERE id = ${task.id} FOR UPDATE`;
          entered(); await wait;
          await tx`UPDATE tasks SET description = 'Concurrent edit' WHERE id = ${task.id}`;
        });
        await Promise.race([ready, writer.then(() => { throw new Error("Writer completed before the row-lock barrier"); })]);
        const decision = a.executions.mutateTaskExecutionConditionally(taskExecutionReference(task), { type: "cancel" }, [
          { taskId: task.id, snapshot: task }, { taskId: "not-created", snapshot: null },
        ]).then(value => ({ value }), error => ({ error }));
        try {
          await vi.waitFor(async () => {
            const rows = await admin`SELECT count(*)::int AS count FROM pg_stat_activity
              WHERE application_name = ${`${namespace}_a`} AND wait_event_type = 'Lock'`;
            expect(rows[0].count).toBe(1);
          });
        } finally { release(); }
        await expect(writer).resolves.toBeUndefined();
        expect(await decision).toMatchObject({ error: { code: "task_execution_conflict" } });
        expect(await a.taskStore.getTask(task.id)).toMatchObject({ status: "pending", description: "Concurrent edit" });
      });

      it("uses the hosted transaction provider and does not duplicate a claim after a lost acknowledgement", async () => {
        const task = await create(), runId = randomUUID();
        let committed = false;
        const hosted = createPgStores({ transaction() { throw new Error("HTTP cannot transact"); } }, {
          transaction: async execute => {
            const result = await pgDrizzle(clientB).transaction(execute);
            if (!committed) { committed = true; throw new Error("Commit acknowledgement lost"); }
            return result;
          },
        }).taskExecutionStore;
        await expect(hosted.claimTaskExecution(taskExecutionReference(task), runId)).rejects.toThrow("Commit acknowledgement lost");
        expect(await a.taskStore.getTask(task.id)).toMatchObject({ activeRunId: runId, executionRevision: 1 });
        expect(await a.runStore.getRun(runId)).toMatchObject({ taskId: task.id, status: "running" });
        await expect(hosted.claimTaskExecution(taskExecutionReference(task), runId)).rejects.toMatchObject({ code: "task_execution_conflict" });
        expect(await a.runStore.getActiveRuns()).toHaveLength(1);
      });
    }

    it("generic retry and recovery controls invalidate the active attempt", async () => {
      const first = await a.executions.claimTaskExecution(taskExecutionReference(await create()), randomUUID());
      await a.taskStore.transition(first.task.id, "failed");
      const retry = await b.taskStore.transition(first.task.id, "pending");
      expect(retry).toMatchObject({ executionRevision: 2, retries: 1, status: "pending" });
      expect(await a.runStore.getRun(first.run.id)).toMatchObject({ status: "killed" });
      const second = await b.executions.claimTaskExecution(taskExecutionReference(retry), randomUUID());
      const recovered = await a.taskStore.unsafeSetStatus(first.task.id, "pending", "fixture recovery");
      expect(recovered).toMatchObject({ executionRevision: 4, retries: 1, status: "pending" });
      expect(await b.runStore.getRun(second.run.id)).toMatchObject({ status: "killed" });
    });
  });
}
