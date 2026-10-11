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
  const mission = () => stores.missionStore.createMission({ name: "Receipt fixture", data: '{"tasks":[]}', status: "recurring", user: "customer-a", metadata: { connectionNamespace: "app-a" } });

  it("atomically commits and replays across reopened adapters and a repeated migration", async () => {
    const original = await mission(), input = executionPlan(original);
    expect(await executions.commitMissionExecution(input)).toEqual({ receipt: input.receipt, created: true });
    sqlite.close();
    sqlite = new Database(join(directory, "project.db"));
    await migrateSqliteSchema(drizzle(sqlite));
    const reopened = createSqliteStores(drizzle(sqlite));
    const persistence = reopened.missionExecutionStore;
    expect(await persistence.getMissionExecution(original.id, "occurrence-a")).toEqual(input.receipt);
    expect(await persistence.getMissionExecutionById(input.receipt.executionId)).toEqual(input);
    expect(await persistence.commitMissionExecution(executionPlan(original))).toEqual({ receipt: input.receipt, created: false });
    expect(await reopened.taskStore.listTasks()).toEqual(input.receipt.tasks.map(task => expect.objectContaining({ id: task.id, metadata: { connectionNamespace: "app-a" } })));
    expect(await reopened.missionStore.getMission(original.id)).toMatchObject({ status: "active", executionCount: 1, metadata: { connectionNamespace: "app-a" } });
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

  it("adds metadata columns to existing databases without inventing a namespace for old rows", async () => {
    const original = await stores.missionStore.createMission({ name: "Old", data: "{}", status: "draft" });
    sqlite.exec("ALTER TABLE tasks DROP COLUMN metadata; ALTER TABLE missions DROP COLUMN metadata");
    await migrateSqliteSchema(drizzle(sqlite));
    await migrateSqliteSchema(drizzle(sqlite));
    expect((await stores.missionStore.getMission(original.id))?.metadata).toBeUndefined();
    const updated = await stores.missionStore.updateMission(original.id, { metadata: { connectionNamespace: "app-a" } });
    const input = executionPlan(updated);
    await executions.commitMissionExecution(input);
    expect((await stores.taskStore.getTask(input.receipt.tasks[0].id))?.metadata).toEqual({ connectionNamespace: "app-a" });
  });

  it("rejects forged and stale metadata, but replays the accepted namespace after an edit", async () => {
    const original = await mission(), input = executionPlan(original);
    input.receipt.tasks[0].metadata = { connectionNamespace: "app-b" };
    await expect(executions.commitMissionExecution(input)).rejects.toMatchObject({ code: "mission_execution_invalid" });
    await stores.missionStore.updateMission(original.id, { metadata: { connectionNamespace: "app-b" } });
    await expect(executions.commitMissionExecution(executionPlan(original))).rejects.toMatchObject({ code: "mission_execution_conflict" });
    expect(await stores.taskStore.listTasks()).toEqual([]);
    const current = (await stores.missionStore.getMission(original.id))!;
    const accepted = await executions.commitMissionExecution(executionPlan(current));
    await stores.missionStore.updateMission(original.id, { metadata: { connectionNamespace: "app-c" } });
    expect(await executions.commitMissionExecution(executionPlan(original))).toEqual({ ...accepted, created: false });
    expect(accepted.receipt.metadata).toEqual({ connectionNamespace: "app-b" });
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
  it("finalizes only terminal work belonging to the current execution", async () => {
    const original = await mission(), input = executionPlan(original);
    input.receipt.tasks.forEach(task => { task.missionExecutionId = input.receipt.executionId; });
    input.runtime = { volatileAgents: [{ name: "helper", role: "Accepted" }] };
    await executions.commitMissionExecution(input);
    expect(await executions.getMissionExecutionById(input.receipt.executionId)).toEqual(input);
    expect(await stores.taskStore.getTask(input.receipt.tasks[0].id)).toMatchObject({ missionExecutionId: input.receipt.executionId });
    expect(await executions.finalizeMissionExecution(input.receipt.executionId, "recurring")).toBe(false);
    for (const task of input.receipt.tasks) await stores.taskStore.unsafeSetStatus(task.id, "done", "fixture");
    expect(await executions.finalizeMissionExecution(input.receipt.executionId, "recurring")).toBe(true);
    const next = (await stores.missionStore.getMission(original.id))!;
    await executions.commitMissionExecution(executionPlan(next, "second"));
    expect(await executions.finalizeMissionExecution(input.receipt.executionId, "completed")).toBe(false);
    expect(await stores.missionStore.getMission(original.id)).toMatchObject({ status: "active", executionCount: 2 });
  });

});
