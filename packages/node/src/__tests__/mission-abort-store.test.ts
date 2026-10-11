import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
import { taskExecutionReference, type TaskApprovalExecutionStore } from "@polpo-ai/core/task-execution";
import type { MissionExecutionCancellationStore, MissionExecutionAbortInput } from "@polpo-ai/core/mission-execution";
import type { TaskStore } from "@polpo-ai/core/task-store";
import type { RunStore } from "@polpo-ai/core/run-store";
import type { Task, ApprovalRequest } from "@polpo-ai/core/types";

type Fixture = { taskStore: TaskStore; runStore: RunStore; atomic: TaskApprovalExecutionStore; missions: MissionExecutionCancellationStore };
const databaseUrl = process.env.AGENT_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
for (const kind of ["file", "sqlite", "pg"] as const) {
  describe.skipIf(kind === "pg" && !databaseUrl)(`${kind} atomic Mission cancellation`, () => {
    let root: string, a: Fixture, b: Fixture, sqliteA: Database.Database, sqliteB: Database.Database;
    let admin: ReturnType<typeof postgres>, clientA: ReturnType<typeof postgres>, clientB: ReturnType<typeof postgres>;
    const namespace = `mission_abort_${randomUUID().replaceAll("-", "")}`;
    const sqlStores = (stores: ReturnType<typeof createSqliteStores>): Fixture => ({ ...stores, atomic: stores.taskExecutionStore, missions: stores.missionExecutionStore });
    beforeAll(async () => {
      if (kind !== "pg") return;
      admin = postgres(databaseUrl!, { max: 1, onnotice: () => undefined });
      clientA = postgres(databaseUrl!, { max: 1, connection: { search_path: namespace }, onnotice: () => undefined });
      clientB = postgres(databaseUrl!, { max: 1, connection: { search_path: namespace }, onnotice: () => undefined });
      await admin.unsafe(`CREATE SCHEMA "${namespace}"`); await migratePgSchema(pgDrizzle(clientA));
    });
    beforeEach(async () => {
      root = mkdtempSync(join(tmpdir(), "polpo-mission-abort-"));
      if (kind === "file") {
        const make = () => { const taskStore = new FileTaskStore(root); return { taskStore, runStore: new FileRunStore(root), atomic: taskStore, missions: taskStore }; };
        a = make(); b = make();
      } else if (kind === "sqlite") {
        sqliteA = new Database(join(root, "project.db")); sqliteB = new Database(join(root, "project.db"));
        await migrateSqliteSchema(sqliteDrizzle(sqliteA)); a = sqlStores(createSqliteStores(sqliteDrizzle(sqliteA))); b = sqlStores(createSqliteStores(sqliteDrizzle(sqliteB)));
      } else {
        await clientA`DELETE FROM tasks`; await clientA`DELETE FROM runs`; await clientA`DELETE FROM mission_executions`; await clientA`DELETE FROM missions`;
        a = sqlStores(createPgStores(pgDrizzle(clientA))); b = sqlStores(createPgStores(pgDrizzle(clientB)));
      }
    });
    afterEach(() => { if (kind === "sqlite") { sqliteA.close(); sqliteB.close(); } rmSync(root, { recursive: true, force: true }); });
    afterAll(async () => {
      if (kind !== "pg") return;
      await Promise.all([clientA.end(), clientB.end()]); await admin.unsafe(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`); await admin.end();
    });
    async function create(label = "Same", sequence = 1) {
      const mission = await a.taskStore.createMission!({ name: label, data: "{}", status: "draft", executionCount: sequence - 1,
        user: "person-a", metadata: { connectionNamespace: "app-a" } });
      const id = randomUUID(), now = new Date().toISOString(), group = sequence > 1 ? `${label} #${sequence}` : label;
      const tasks: Task[] = [0, 1].map(n => ({ id: `${id}-${n}`, title: `${id} task ${n}`, description: "Read", assignTo: "support",
        missionId: mission.id, missionExecutionId: id, group, status: "pending", retries: 0, maxRetries: 2, dependsOn: [],
        expectations: [], metrics: [], createdAt: now, updatedAt: now, user: mission.user, metadata: mission.metadata }));
      const receipt = { executionId: id, missionId: mission.id, idempotencyKey: id, group, sequence, createdAt: now, tasks,
        user: mission.user, metadata: mission.metadata };
      await a.missions.commitMissionExecution({ expected: mission, receipt });
      const claimed = await a.atomic.claimTaskExecution(taskExecutionReference(tasks[0]), `${id}-run`);
      const input: MissionExecutionAbortInput = { missionId: mission.id, executionId: id,
        tasks: await Promise.all(tasks.map(async task => ({ taskId: task.id, snapshot: (await a.taskStore.getTask(task.id))! }))) };
      return { mission, receipt, input, claimed };
    }

    it("cancels only the accepted execution despite equal display labels and survives restart/replay", async () => {
      const target = await create("Same", 2), other = await create("Same #2");
      expect(target.receipt.group).toBe(other.receipt.group);
      expect(await a.missions.abortMissionExecution(target.input)).toMatchObject({ aborted: 2, executionId: target.receipt.executionId,
        missionCancelled: true, killedRunIds: [target.claimed.run.id] });
      expect(await b.runStore.getRun(target.claimed.run.id)).toMatchObject({ status: "killed" });
      expect(await b.taskStore.getMission!(target.mission.id)).toMatchObject({ status: "cancelled" });
      expect(await b.taskStore.getMission!(other.mission.id)).toMatchObject({ status: "active" });
      for (const snapshot of other.input.tasks) expect(await b.taskStore.getTask(snapshot.taskId)).toEqual(snapshot.snapshot);
      const fresh = { ...target.input, tasks: await Promise.all(target.input.tasks.map(async p => ({ taskId: p.taskId, snapshot: (await b.taskStore.getTask(p.taskId))! }))) };
      expect(await b.missions.abortMissionExecution(fresh)).toMatchObject({ aborted: 0, killedRunIds: [] });
    });

    it.each(["claim", "edit", "principal"])("rejects a captured abort after another Task %s without partially cancelling its peers", async change => {
      const f = await create(), second = f.input.tasks[1].snapshot!;
      if (change === "claim") await b.atomic.claimTaskExecution(taskExecutionReference(second), "replacement-run");
      else await b.taskStore.updateTask(second.id, change === "edit" ? { description: "New input" } : { user: "person-b" });
      const changed = await b.taskStore.getTask(second.id);
      await expect(a.missions.abortMissionExecution(f.input)).rejects.toMatchObject({ code: "task_execution_conflict" });
      expect(await a.taskStore.getTask(f.claimed.task.id)).toEqual(f.claimed.task);
      expect(await a.taskStore.getTask(second.id)).toEqual(changed);
      expect(await a.runStore.getRun(f.claimed.run.id)).toMatchObject({ status: "running" });
      expect(await a.taskStore.getMission!(f.mission.id)).toMatchObject({ status: "active" });
    });

    it("invalidates retained approval authority on a terminal Task only once", async () => {
      const f = await create(), task = f.claimed.task;
      const request: ApprovalRequest = { id: "retained-approval", gateId: "human", gateName: "Review", taskId: task.id,
        status: "pending", payload: { task }, requestedAt: task.updatedAt,
        taskExecution: { version: 1, batchId: "retained-batch", hook: "task:spawn", requestIds: ["retained-approval"],
          gates: [{ id: "human", name: "Review", handler: "human", hook: "task:spawn" }], source: task, invocation: { task } } };
      const waiting = await a.atomic.commitTaskApprovalDecision({ expected: taskExecutionReference(task),
        tasks: [{ taskId: task.id, snapshot: task }], approvals: [{ id: request.id, expected: null, next: request }],
        operation: { type: "transition", status: "awaiting_approval" },
        approvalState: { batchId: "retained-batch", phase: "waiting", revision: task.executionRevision! + 1 } });
      const failed = await a.atomic.mutateTaskExecution(taskExecutionReference(waiting.task), { type: "transition", status: "failed" });
      expect(failed.task.approvalState).toBeDefined();
      f.input.tasks[0].snapshot = failed.task;
      await a.missions.abortMissionExecution(f.input);
      const cancelled = (await b.taskStore.getTask(task.id))!;
      expect(cancelled.approvalState).toBeUndefined();
      expect(cancelled.executionRevision).toBe(failed.task.executionRevision! + 1);
      const fresh = { ...f.input, tasks: await Promise.all(f.input.tasks.map(async p => ({ taskId: p.taskId, snapshot: (await b.taskStore.getTask(p.taskId))! }))) };
      expect(await b.missions.abortMissionExecution(fresh)).toMatchObject({ aborted: 0 });
      expect(await a.taskStore.getTask(task.id)).toEqual(cancelled);
    });

    if (kind === "file") it("rejects an invalid stored Task without changing its peers or Mission", async () => {
      const f = await create(), task = f.input.tasks[1].snapshot!;
      writeFileSync(join(root, "tasks", `${task.id}.json`), JSON.stringify({ ...task, status: "unknown-status" }));
      f.input.tasks[1].snapshot = (await a.taskStore.getTask(task.id))!;
      await expect(a.missions.abortMissionExecution(f.input)).rejects.toMatchObject({ code: "task_execution_invalid" });
      for (const p of f.input.tasks) expect(await b.taskStore.getTask(p.taskId)).toEqual(p.snapshot);
      expect(await b.runStore.getRun(f.claimed.run.id)).toMatchObject({ status: "running" });
      expect(await b.taskStore.getMission!(f.mission.id)).toMatchObject({ status: "active" });
    });

    it("cannot be rescheduled by a concurrent completion cleanup", async () => {
      const f = await create();
      const [aborted, finalized] = await Promise.all([
        a.missions.abortMissionExecution(f.input), b.missions.finalizeMissionExecution(f.receipt.executionId, "recurring"),
      ]);
      expect(aborted).toMatchObject({ aborted: 2, missionCancelled: true });
      expect(finalized).toBe(false);
      expect(await b.taskStore.getMission!(f.mission.id)).toMatchObject({ status: "cancelled" });
      expect(await b.missions.finalizeMissionExecution(f.receipt.executionId, "recurring")).toBe(false);
    });

    it("cancels a historical execution without changing the next accepted execution", async () => {
      const f = await create(), id = randomUUID(), now = new Date().toISOString();
      const expected = await b.taskStore.updateMission!(f.mission.id, { status: "recurring" });
      const next = { ...f.receipt, executionId: id, idempotencyKey: id, sequence: 2, group: "Same #2", createdAt: now,
        tasks: f.receipt.tasks.map((task, n) => ({ ...task, id: `${id}-${n}`, title: `${id} task ${n}`,
          missionExecutionId: id, group: "Same #2", createdAt: now, updatedAt: now })) };
      await b.missions.commitMissionExecution({ expected, receipt: next });
      expect(await a.missions.abortMissionExecution(f.input)).toMatchObject({ aborted: 2, missionCancelled: false });
      expect(await b.taskStore.getMission!(f.mission.id)).toMatchObject({ status: "active", executionCount: 2 });
      for (const task of next.tasks) expect(await b.taskStore.getTask(task.id)).toMatchObject({ status: "pending", missionExecutionId: id });
    });

    it("also stops a Run retained by a terminal Task from an older writer", async () => {
      const f = await create(), task = { ...f.claimed.task, status: "done" as const };
      if (kind === "file") writeFileSync(join(root, "tasks", `${task.id}.json`), JSON.stringify(task));
      else if (kind === "sqlite") sqliteA.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(task.id);
      else await clientA`UPDATE tasks SET status = 'done' WHERE id = ${task.id}`;
      f.input.tasks[0].snapshot = (await a.taskStore.getTask(task.id))!;
      expect(await a.missions.abortMissionExecution(f.input)).toMatchObject({ aborted: 1, killedRunIds: [f.claimed.run.id] });
      expect(await b.taskStore.getTask(task.id)).toMatchObject({ status: "done" });
      expect((await b.taskStore.getTask(task.id))?.activeRunId).toBeUndefined();
      expect(await b.runStore.getRun(f.claimed.run.id)).toMatchObject({ status: "killed" });
    });

    it.each(["foreign", "omitted", "duplicate"])("rejects a %s receipt/task selection before changing anything", async change => {
      const f = await create();
      const input = structuredClone(f.input);
      if (change === "foreign") input.missionId = "another-mission";
      else if (change === "omitted") input.tasks.pop();
      else input.tasks.push(input.tasks[0]);
      await expect(a.missions.abortMissionExecution(input)).rejects.toThrow();
      expect(await a.taskStore.getTask(f.claimed.task.id)).toEqual(f.claimed.task);
      expect(await a.runStore.getRun(f.claimed.run.id)).toMatchObject({ status: "running" });
      expect(await a.taskStore.getMission!(f.mission.id)).toMatchObject({ status: "active" });
    });

    if (kind !== "file") it.each(["tasks", "runs", "missions"])("rolls back every cancellation if the %s write is silently ignored", async table => {
      const f = await create();
      if (kind === "sqlite") sqliteA.exec(`CREATE TRIGGER ignore_abort BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(IGNORE); END`);
      else {
        await clientA.unsafe(`CREATE FUNCTION ignore_abort() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`);
        await clientA.unsafe(`CREATE TRIGGER ignore_abort BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION ignore_abort()`);
      }
      try {
        await expect(a.missions.abortMissionExecution(f.input)).rejects.toThrow();
        for (const p of f.input.tasks) expect(await b.taskStore.getTask(p.taskId)).toEqual(p.snapshot);
        expect(await b.runStore.getRun(f.claimed.run.id)).toMatchObject({ status: "running" });
        expect(await b.taskStore.getMission!(f.mission.id)).toMatchObject({ status: "active" });
      } finally {
        if (kind === "sqlite") sqliteA.exec("DROP TRIGGER ignore_abort");
        else { await clientA.unsafe(`DROP TRIGGER ignore_abort ON ${table}`); await clientA.unsafe("DROP FUNCTION ignore_abort()"); }
      }
    });
  });
}
