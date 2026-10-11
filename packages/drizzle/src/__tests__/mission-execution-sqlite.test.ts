import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { MissionExecutionStore } from "@polpo-ai/core/mission-store";
import { createSqliteStores, migrateSqliteSchema } from "../index.js";
import { executionPlan } from "./mission-execution-fixture.js";

describe("SQLite Mission execution admission", () => {
  let directory: string, sqlite: Database.Database;
  let stores: ReturnType<typeof createSqliteStores>;
  let executions: MissionExecutionStore;
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "polpo-mission-sqlite-"));
    sqlite = new Database(join(directory, "project.db"));
    const db = drizzle(sqlite);
    await migrateSqliteSchema(db);
    stores = createSqliteStores(db);
    executions = stores.missionExecutionStore;
  });
  afterEach(() => { sqlite.close(); rmSync(directory, { recursive: true, force: true }); });
  const mission = () => stores.missionStore.createMission({ name: "Receipt fixture", data: '{"tasks":[]}', status: "recurring", user: "customer-a" });

  it("atomically commits and replays across reopened adapters and a repeated migration", async () => {
    const original = await mission(), input = executionPlan(original);
    expect(await executions.commitMissionExecution(input)).toEqual({ receipt: input.receipt, created: true });
    sqlite.close();
    sqlite = new Database(join(directory, "project.db"));
    await migrateSqliteSchema(drizzle(sqlite));
    const reopened = createSqliteStores(drizzle(sqlite));
    const persistence = reopened.missionExecutionStore;
    expect(await persistence.getMissionExecution(original.id, "occurrence-a")).toEqual(input.receipt);
    expect(await persistence.commitMissionExecution(executionPlan(original))).toEqual({ receipt: input.receipt, created: false });
    expect(await reopened.taskStore.listTasks()).toHaveLength(2);
    expect(await reopened.missionStore.getMission(original.id)).toMatchObject({ status: "active", executionCount: 1 });
  });

  it.each(["tasks", "mission_executions"])("rolls back every write if %s persistence fails", async (table) => {
    const original = await mission(), input = executionPlan(original);
    const condition = table === "tasks" ? "WHEN NEW.title = 'Second'" : "";
    sqlite.exec(`CREATE TRIGGER reject_write BEFORE INSERT ON ${table} ${condition} BEGIN SELECT RAISE(ABORT, 'fixture storage failure'); END`);
    await expect(executions.commitMissionExecution(input)).rejects.toThrow();
    expect(await stores.taskStore.listTasks()).toEqual([]);
    expect(await stores.missionStore.getMission(original.id)).toMatchObject({ status: "recurring", executionCount: 0 });
    expect(await executions.getMissionExecution(original.id, "occurrence-a")).toBeUndefined();
    sqlite.exec("DROP TRIGGER reject_write");
    expect((await executions.commitMissionExecution(input)).created).toBe(true);
  });

  it("rejects stale and forged principals before creating any tasks", async () => {
    const original = await mission(), input = executionPlan(original);
    input.receipt.tasks[1].user = "customer-b";
    await expect(executions.commitMissionExecution(input)).rejects.toMatchObject({ code: "mission_execution_invalid" });
    await stores.missionStore.updateMission(original.id, { user: "customer-b" });
    await expect(executions.commitMissionExecution(executionPlan(original))).rejects.toMatchObject({ code: "mission_execution_conflict" });
    expect(await stores.taskStore.listTasks()).toEqual([]);
  });

  it("keeps the accepted principal on replay and captures the new principal for a new occurrence", async () => {
    const original = await mission(), input = executionPlan(original);
    await executions.commitMissionExecution(input);
    for (const task of input.receipt.tasks) await stores.taskStore.unsafeSetStatus(task.id, "done", "fixture");
    const next = await stores.missionStore.updateMission(original.id, { status: "recurring", user: "customer-b" });
    expect(await executions.commitMissionExecution(executionPlan(next))).toEqual({ receipt: input.receipt, created: false });
    expect((await executions.commitMissionExecution(executionPlan(next, "occurrence-b"))).receipt).toMatchObject({ sequence: 2, user: "customer-b" });
    expect(await stores.taskStore.listTasks()).toHaveLength(4);
  });

  it("preserves task execution controls when the queue reads admitted tasks", async () => {
    const original = await stores.missionStore.createMission({ name: "Controls", data: '{}', status: "draft", qualityThreshold: 0 });
    const input = executionPlan(original);
    const controls = { executionMode: "subprocess" as const, questionRounds: 0, priority: 0, sideEffects: false,
      sandbox: { isolation: "fresh" as const }, routing: { labels: ["private"] } };
    Object.assign(input.receipt.tasks[0], controls);
    await executions.commitMissionExecution(input);
    expect(await stores.taskStore.getTask(input.receipt.tasks[0].id)).toMatchObject(controls);
    await stores.taskStore.updateTask(input.receipt.tasks[0].id, { executionMode: "in-process", questionRounds: 1 });
    expect(await stores.taskStore.getTask(input.receipt.tasks[0].id)).toMatchObject({ executionMode: "in-process", questionRounds: 1 });
    expect(await executions.getMissionExecution(original.id, "occurrence-a")).toEqual(input.receipt);
  });

  it("does not recreate deleted work on a delayed replay", async () => {
    const original = await mission(), input = executionPlan(original);
    await executions.commitMissionExecution(input);
    await stores.taskStore.deleteTasks(() => true);
    await stores.missionStore.deleteMission(original.id);
    expect(await executions.commitMissionExecution(input)).toEqual({ receipt: input.receipt, created: false });
    expect(await stores.taskStore.listTasks()).toEqual([]);
    expect(await stores.missionStore.getMission(original.id)).toBeUndefined();
  });

  it("rejects an execution identity already used by another Mission", async () => {
    const original = await mission(), input = executionPlan(original);
    await executions.commitMissionExecution(input);
    const other = await stores.missionStore.createMission({ name: "Other", data: '{}', status: "draft" });
    const duplicate = executionPlan(other);
    duplicate.receipt.executionId = input.receipt.executionId;
    duplicate.receipt.tasks.forEach(task => { task.title = `Other ${task.title}`; });
    await expect(executions.commitMissionExecution(duplicate)).rejects.toMatchObject({ code: "mission_execution_conflict" });
    expect(await stores.taskStore.listTasks()).toHaveLength(2);
    expect(await stores.missionStore.getMission(other.id)).toMatchObject({ status: "draft" });
  });
});
