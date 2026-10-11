import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { FileTaskStore } from "../file-task-store.js";
import { ProjectFileTransaction } from "../project-file-transaction.js";
import type { Mission, Task } from "@polpo-ai/core/types";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "polpo-mission-admission-")); });
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

async function setup() {
  const store = new FileTaskStore(root);
  const mission = await store.createMission({ name: "Receipt fixture", data: '{"tasks":[]}', status: "recurring", user: "customer-a" });
  return { store, mission };
}
function plan(mission: Mission, key = "occurrence-a") {
  const sequence = (mission.executionCount ?? 0) + 1;
  const group = sequence > 1 ? `${mission.name} #${sequence}` : mission.name;
  const createdAt = new Date().toISOString(), first = randomUUID();
  const task = (id: string, title: string, dependsOn: string[]): Task => ({ id, title, description: title, assignTo: "support",
    missionId: mission.id, group, user: mission.user, dependsOn, status: "pending", retries: 0, maxRetries: 0,
    expectations: [], metrics: [], createdAt, updatedAt: createdAt });
  return { expected: mission, receipt: { executionId: randomUUID(), missionId: mission.id, idempotencyKey: key,
    group, sequence, user: mission.user, createdAt, tasks: [task(first, "First", []), task(randomUUID(), "Second", [first])] } };
}

describe("file Mission execution admission", () => {
  it("refuses entity identifiers that traverse into other project files", async () => {
    const { store, mission } = await setup();
    await expect(store.getTask(`../missions/${mission.id}`)).rejects.toThrow("Invalid stored entity identifier");
    await expect(store.getMission("../_meta")).rejects.toThrow("Invalid stored entity identifier");
  });
  it("commits tasks, Mission activation/counter and a restart-stable receipt together", async () => {
    const { store, mission } = await setup(), input = plan(mission);
    const result = await store.commitMissionExecution(input);
    expect(result.created).toBe(true);
    expect(result.receipt).toEqual(input.receipt);
    const reopened = new FileTaskStore(root);
    expect(await reopened.getMission(mission.id)).toMatchObject({ status: "active", executionCount: 1, user: "customer-a" });
    expect((await reopened.listTasks()).sort((a, b) => a.title.localeCompare(b.title))).toEqual(input.receipt.tasks);
    expect(await reopened.getMissionExecution(mission.id, "occurrence-a")).toEqual(input.receipt);
    expect(await reopened.getMissionExecutionById(input.receipt.executionId)).toEqual(input);
    const replay = await reopened.commitMissionExecution(plan(mission));
    expect(replay).toEqual({ created: false, receipt: input.receipt });
    expect(await reopened.listTasks()).toHaveLength(2);
  });

  it("preserves the original receipt after recurring completion and an edited principal", async () => {
    const { store, mission } = await setup(), input = plan(mission);
    await store.commitMissionExecution(input);
    for (const task of input.receipt.tasks) await store.unsafeSetStatus(task.id, "done", "fixture completion");
    const next = await store.updateMission(mission.id, { status: "recurring", user: "customer-b" });
    expect(await store.commitMissionExecution(plan(next))).toEqual({ created: false, receipt: input.receipt });
    const second = await store.commitMissionExecution(plan(next, "occurrence-b"));
    expect(second.receipt).toMatchObject({ sequence: 2, user: "customer-b" });
    expect(await store.listTasks()).toHaveLength(4);
  });

  it("rejects a stale principal or a conflicting active title without partial task creation", async () => {
    const { store, mission } = await setup();
    const changed = await store.updateMission(mission.id, { user: "customer-b" });
    await expect(store.commitMissionExecution(plan(mission))).rejects.toMatchObject({ code: "mission_execution_conflict" });
    expect(await store.listTasks()).toEqual([]);
    const existing = plan(changed).receipt.tasks[0];
    await store.createTask(existing);
    await expect(store.commitMissionExecution(plan(changed))).rejects.toMatchObject({ code: "mission_execution_conflict" });
    expect(await store.listTasks()).toHaveLength(1);
    expect(await store.getMission(mission.id)).toMatchObject({ status: "recurring", user: "customer-b" });
    expect(await store.getMissionExecution(mission.id, "occurrence-a")).toBeUndefined();
  });

  it("rejects a task principal that differs from its captured Mission", async () => {
    const { store, mission } = await setup(), input = plan(mission);
    input.receipt.tasks[1].user = "customer-b";
    await expect(store.commitMissionExecution(input)).rejects.toMatchObject({ code: "mission_execution_invalid" });
    expect(await store.listTasks()).toEqual([]);
  });

  it("replays an acknowledged-lost commit instead of creating tasks again", async () => {
    const { store, mission } = await setup(), input = plan(mission);
    const original = ProjectFileTransaction.prototype.finish;
    const spy = vi.spyOn(ProjectFileTransaction.prototype, "finish").mockImplementationOnce(function (this: ProjectFileTransaction) {
      original.call(this);
      throw new Error("fixture acknowledgement lost after durable commit");
    });
    await expect(store.commitMissionExecution(input)).rejects.toThrow("acknowledgement lost");
    spy.mockRestore();
    const reopened = new FileTaskStore(root);
    expect(await reopened.commitMissionExecution(plan(mission))).toEqual({ created: false, receipt: input.receipt });
    expect(await reopened.listTasks()).toHaveLength(2);
  });

  it("does not recreate deleted work when a delayed delivery replays", async () => {
    const { store, mission } = await setup(), input = plan(mission);
    await store.commitMissionExecution(input);
    await store.deleteTasks(() => true);
    await store.deleteMission(mission.id);
    const reopened = new FileTaskStore(root);
    expect(await reopened.commitMissionExecution(input)).toEqual({ receipt: input.receipt, created: false });
    expect(await reopened.listTasks()).toEqual([]);
    expect(await reopened.getMission(mission.id)).toBeUndefined();
  });

  it.each(["corrupt candidate", "unknown conflict", "wrong identity"])("refuses to overwrite or ignore an unreadable task (%s)", async kind => {
    const { store, mission } = await setup(), input = plan(mission);
    const id = kind === "unknown conflict" ? "other" : input.receipt.tasks[0].id;
    const raw = kind === "wrong identity" ? JSON.stringify({ ...input.receipt.tasks[0], id: "different-id", status: "done" }) : "broken JSON";
    const path = join(root, "tasks", `${id}.json`);
    writeFileSync(path, raw);
    await expect(store.commitMissionExecution(input)).rejects.toMatchObject({ code: "mission_execution_conflict" });
    expect(readFileSync(path, "utf8")).toBe(raw);
    expect(readdirSync(join(root, "tasks"))).toEqual([`${id}.json`]);
    expect(await store.getMission(mission.id)).toMatchObject({ status: "recurring" });
    expect(await store.getMissionExecution(mission.id, "occurrence-a")).toBeUndefined();
  });

  it("rejects sparse task dependencies before persisting an unreadable receipt", async () => {
    const { store, mission } = await setup(), input = plan(mission);
    input.receipt.tasks[0].dependsOn = new Array(1);
    await expect(store.commitMissionExecution(input)).rejects.toMatchObject({ code: "mission_execution_invalid" });
    expect(await store.listTasks()).toEqual([]);
    expect(await store.getMissionExecution(mission.id, "occurrence-a")).toBeUndefined();
  });

  it("keeps execution identities unique across different Missions", async () => {
    const { store, mission } = await setup(), input = plan(mission);
    await store.commitMissionExecution(input);
    const other = await store.createMission({ name: "Other Mission", data: '{}', status: "draft" });
    const duplicate = plan(other);
    duplicate.receipt.executionId = input.receipt.executionId;
    duplicate.receipt.tasks.forEach(task => { task.title = `Other ${task.title}`; });
    await expect(store.commitMissionExecution(duplicate)).rejects.toMatchObject({ code: "mission_execution_conflict" });
    expect(await store.listTasks()).toHaveLength(2);
    expect(await store.getMission(other.id)).toMatchObject({ status: "draft" });
    expect(await store.getMissionExecution(other.id, "occurrence-a")).toBeUndefined();
  });
});
