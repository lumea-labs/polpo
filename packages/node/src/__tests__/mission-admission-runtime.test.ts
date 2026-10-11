import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileTaskStore } from "@polpo-ai/file-stores";
import { MissionExecutor } from "@polpo-ai/core/mission-executor";
import { TaskManager } from "@polpo-ai/core/task-manager";
import { AgentManager } from "@polpo-ai/core/agent-manager";
import { HookRegistry } from "@polpo-ai/core/hooks";
import { OrchestratorEngine, Scheduler } from "@polpo-ai/core";
import { TaskRunner } from "@polpo-ai/core/task-runner";
import type { OrchestratorContext } from "@polpo-ai/core/orchestrator-context";
import { InMemoryCheckpointStore, InMemoryDelayStore } from "../../../core/src/in-memory-stores.js";
import { TypedEmitter } from "../core/events.js";
import { createMockStores, createTestAgent, InMemoryRunStore } from "./fixtures.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "polpo-mission-runtime-")); });
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

function fixture(extra: Partial<OrchestratorContext> = {}) {
  const teams = [{ name: "main", agents: [createTestAgent({ name: "support" })] }];
  const store = new FileTaskStore(root);
  const ctx = { taskStore: store, ...createMockStores(teams), emitter: new TypedEmitter(), hooks: new HookRegistry(),
    runStore: new InMemoryRunStore(), config: { version: "1", project: "fixture", teams, tasks: [], settings: { maxRetries: 2 } },
    workDir: root, agentWorkDir: root, polpoDir: root,
    checkpointStore: new InMemoryCheckpointStore(), delayStore: new InMemoryDelayStore(), ...extra } as OrchestratorContext;
  const taskManager = new TaskManager(ctx), agentManager = new AgentManager(ctx);
  const executor = new MissionExecutor(ctx, taskManager, agentManager);
  return { store, ctx, executor, taskManager, agentManager };
}
const document = () => ({ tasks: [
  { title: "First", description: "First task", assignTo: "support" },
  { title: "Second", description: "Second task", assignTo: "support", dependsOn: ["First"] },
] });

describe("durable Mission execution through the real OSS executor", () => {
  it("validates every task hook before creating tasks or incrementing the counter", async () => {
    const f = fixture(); await f.executor.ready;
    vi.spyOn(f.ctx.hooks, "runBeforeSync").mockImplementation((name, data: any) => ({ data, cancelled: name === "task:create" && data.title === "Second", cancelReason: "fixture denial" }));
    const mission = await f.executor.createMission({ data: JSON.stringify(document()), user: "customer-a" });
    await expect(f.executor.executeMission(mission.id, { idempotencyKey: "delivery" })).rejects.toThrow("fixture denial");
    expect(await f.store.listTasks()).toEqual([]);
    expect((await f.store.getMission(mission.id))?.executionCount ?? 0).toBe(0);
    expect(await f.store.getMissionExecution(mission.id, "delivery")).toBeUndefined();
  });

  it("deduplicates independent executors and preserves the original user after an edit", async () => {
    const a = fixture(), b = fixture(); await Promise.all([a.executor.ready, b.executor.ready]);
    const mission = await a.executor.createMission({ data: JSON.stringify(document()), user: "customer-a" });
    const [first, retry] = await Promise.all([a.executor, b.executor].map(exec => exec.executeMission(mission.id, { idempotencyKey: "delivery" })));
    expect(first).toEqual(retry);
    expect(first.executionId).toBeTruthy();
    expect(first.tasks.every(task => task.missionExecutionId === first.executionId && task.user === "customer-a")).toBe(true);
    await a.store.updateMission(mission.id, { user: "customer-b", data: '{"tasks":[]}' });
    expect(await b.executor.executeMission(mission.id, { idempotencyKey: "delivery" })).toEqual(first);
    expect(await a.store.listTasks()).toHaveLength(2);
  });

  it("retains forward dependencies and rejects missing dependencies before writing", async () => {
    const f = fixture(); await f.executor.ready;
    const doc = document(); doc.tasks.reverse();
    const mission = await f.executor.createMission({ data: JSON.stringify(doc) });
    const result = await f.executor.executeMission(mission.id, { idempotencyKey: "delivery" });
    const first = result.tasks.find(task => task.title === "First")!;
    expect(result.tasks.find(task => task.title === "Second")?.dependsOn).toEqual([first.id]);
    const invalid = await f.executor.createMission({ data: JSON.stringify({ tasks: [{ title: "Third", description: "Invalid", assignTo: "support", dependsOn: ["missing"] }] }) });
    await expect(f.executor.executeMission(invalid.id, { idempotencyKey: "invalid" })).rejects.toThrow(/dependency/i);
    expect(await f.store.listTasks()).toHaveLength(2);
  });

  it("recovers accepted gates and recurring origin from the receipt after setup failure and a Mission edit", async () => {
    const f = fixture(); await f.executor.ready;
    vi.spyOn(f.ctx.agentStore, "createAgent").mockRejectedValueOnce(new Error("fixture interrupted setup"));
    const doc = { ...document(), checkpoints: [{ name: "review", afterTasks: ["First"], blocksTasks: ["Second"] }],
      delays: [{ name: "cooldown", afterTasks: ["First"], blocksTasks: ["Second"], duration: "PT1M" }],
      qualityGates: [{ name: "quality", afterTasks: ["First"], blocksTasks: ["Second"], minScore: 4 }],
      team: [{ name: "helper", role: "Original role" }] };
    const mission = await f.executor.createMission({ data: JSON.stringify(doc), status: "recurring", user: "customer-a" });
    await expect(f.executor.executeMission(mission.id, { idempotencyKey: "delivery" })).rejects.toThrow("fixture interrupted setup");
    const receipt = (await f.store.getMissionExecution(mission.id, "delivery"))!;
    expect(receipt).toBeDefined();
    await f.store.updateMission(mission.id, { data: JSON.stringify(document()), user: "customer-b" });
    const resumed = fixture(); await resumed.executor.ready;
    await resumed.executor.prepareTaskExecution(receipt.tasks[0]);
    expect(resumed.executor.getCheckpoints(receipt.group)).toEqual(doc.checkpoints);
    expect(resumed.executor.getDelays(receipt.group)).toEqual(doc.delays);
    expect(resumed.executor.getQualityGates(receipt.group)).toEqual(doc.qualityGates);
    expect(await resumed.ctx.agentStore.getAgent("helper")).toMatchObject({ role: "Original role" });
    for (const task of receipt.tasks) await resumed.store.unsafeSetStatus(task.id, "done", "fixture completion");
    await resumed.executor.cleanupCompletedGroups(await resumed.store.listTasks());
    expect(await resumed.store.getMission(mission.id)).toMatchObject({ status: "recurring" });
  });

  it("rejects a task whose user no longer matches its accepted execution", async () => {
    const f = fixture(); await f.executor.ready;
    const mission = await f.executor.createMission({ data: JSON.stringify(document()), user: "customer-a" });
    const receipt = await f.executor.executeMission(mission.id, { idempotencyKey: "delivery" });
    await expect(f.executor.prepareTaskExecution({ ...receipt.tasks[0], user: "customer-b" })).rejects.toThrow(/execution/i);
  });

  it("holds dispatch and deadlock repair while accepted runtime setup is unavailable", async () => {
    const f = fixture(); await f.executor.ready;
    const mission = await f.executor.createMission({ data: JSON.stringify(document()) });
    await f.executor.executeMission(mission.id, { idempotencyKey: "delivery" });
    vi.spyOn(f.executor, "prepareTaskExecution").mockRejectedValue(new Error("fixture temporary outage"));
    const spawn = vi.fn(), repair = vi.fn();
    const engine = new OrchestratorEngine({ ctx: f.ctx, taskManager: f.taskManager, agentManager: f.agentManager, missionExecutor: f.executor,
      taskRunner: { collectResults: async () => {}, enforceHealthChecks: async () => {}, spawnForTask: spawn,
        syncProcessesFromRunStore: async () => {}, recoverOrphanedTasks: async () => 0 },
      assessmentOrchestrator: { handleResult: async () => {}, retryOrFail: async () => {} },
      deadlockResolver: { isResolving: () => false, analyzeBlockedTasks: repair, resolveDeadlock: async () => {} } });
    await engine.tick();
    expect(spawn).not.toHaveBeenCalled(); expect(repair).not.toHaveBeenCalled();
    expect((await f.store.listTasks()).every(task => task.status === "pending")).toBe(true);
    const unprepared = new TaskRunner(f.ctx);
    await expect(unprepared.spawnForTask((await f.store.listTasks())[0])).rejects.toThrow(/prepared before dispatch/);
  });

  it("keeps runtime gates separate when two execution labels happen to coincide", async () => {
    const f = fixture(); await f.executor.ready;
    const first = await f.executor.createMission({ name: "Same", data: JSON.stringify({ ...document(), checkpoints: [{ name: "first-review", afterTasks: ["First"], blocksTasks: ["Second"] }] }) });
    await f.store.updateMission(first.id, { executionCount: 1 });
    const a = await f.executor.executeMission(first.id, { idempotencyKey: "one" });
    const otherDoc = { tasks: [{ title: "Other first", description: "First", assignTo: "support" }, { title: "Other second", description: "Second", assignTo: "support", dependsOn: ["Other first"] }],
      checkpoints: [{ name: "other-review", afterTasks: ["Other first"], blocksTasks: ["Other second"] }] };
    const other = await f.executor.createMission({ name: "Same #2", data: JSON.stringify(otherDoc) });
    const b = await f.executor.executeMission(other.id, { idempotencyKey: "two" });
    expect(a.group).toBe(b.group);
    expect(f.executor.getCheckpoints(a.executionId!)[0].name).toBe("first-review");
    expect(f.executor.getCheckpoints(b.executionId!)[0].name).toBe("other-review");
    expect(() => f.executor.getCheckpoints(a.group)).toThrow(/Ambiguous/);
    for (const task of a.tasks) await f.store.unsafeSetStatus(task.id, "done", "fixture completion");
    await f.executor.cleanupCompletedGroups(await f.store.listTasks());
    expect(await f.store.getMission(first.id)).toMatchObject({ status: "completed" });
    expect(await f.store.getMission(other.id)).toMatchObject({ status: "active" });
  });

  it("does not finalize a newer recurring execution from historical terminal tasks after restart", async () => {
    const f = fixture(); await f.executor.ready;
    const mission = await f.executor.createMission({ data: JSON.stringify(document()), status: "recurring" });
    const first = await f.executor.executeMission(mission.id, { idempotencyKey: "first" });
    for (const task of first.tasks) await f.store.unsafeSetStatus(task.id, "done", "fixture completion");
    await f.executor.cleanupCompletedGroups(await f.store.listTasks());
    await f.executor.executeMission(mission.id, { idempotencyKey: "second" });
    const resumed = fixture(); await resumed.executor.ready;
    await resumed.executor.cleanupCompletedGroups(await resumed.store.listTasks());
    expect(await resumed.store.getMission(mission.id)).toMatchObject({ status: "active", executionCount: 2 });
  });

  it("restores accepted definitions when a terminal task is explicitly retried after cleanup", async () => {
    const f = fixture(); await f.executor.ready;
    const doc = { ...document(), checkpoints: [{ name: "review", afterTasks: ["First"], blocksTasks: ["Second"] }] };
    const mission = await f.executor.createMission({ data: JSON.stringify(doc) });
    const execution = await f.executor.executeMission(mission.id, { idempotencyKey: "delivery" });
    for (const task of execution.tasks) await f.store.unsafeSetStatus(task.id, "failed", "fixture failure");
    await f.executor.cleanupCompletedGroups(await f.store.listTasks());
    const retried = await f.store.transition(execution.tasks[1].id, "pending");
    await f.executor.prepareTaskExecution(retried);
    expect(f.executor.getCheckpoints(execution.executionId!)).toEqual(doc.checkpoints);
  });

  it("replays a concurrent winner even when it commits between receipt lookup and preflight", async () => {
    const a = fixture(), b = fixture(); await Promise.all([a.executor.ready, b.executor.ready]);
    const mission = await a.executor.createMission({ data: JSON.stringify(document()) });
    const lookup = b.store.getMissionExecution.bind(b.store);
    let winner: Awaited<ReturnType<typeof a.executor.executeMission>>;
    vi.spyOn(b.store, "getMissionExecution").mockImplementationOnce(async (...args) => {
      const absent = await lookup(...args);
      winner = await a.executor.executeMission(mission.id, { idempotencyKey: "delivery" });
      return absent;
    });
    expect(await b.executor.executeMission(mission.id, { idempotencyKey: "delivery" })).toEqual(winner!);
    expect(await a.store.listTasks()).toHaveLength(2);
  });

  it("deletes execution gates and volatile agents without deleting another Mission with the same label", async () => {
    const f = fixture(); await f.executor.ready;
    const doc = { ...document(), team: [{ name: "helper", role: "Original" }],
      checkpoints: [{ name: "review", afterTasks: ["First"], blocksTasks: ["Second"] }] };
    const mission = await f.executor.createMission({ name: "Same", data: JSON.stringify(doc) });
    const execution = await f.executor.executeMission(mission.id, { idempotencyKey: "delivery" });
    const other = await f.store.createTask({ ...execution.tasks[0], title: "Unrelated", missionId: "other", missionExecutionId: undefined });
    await f.store.unsafeSetStatus(execution.tasks[0].id, "done", "fixture completion");
    await f.executor.getBlockingCheckpoint(execution.executionId!, "Second", execution.tasks[1].id, await f.store.listTasks());
    expect(f.executor.getActiveCheckpoints()).toHaveLength(1);
    await f.executor.deleteMission(mission.id);
    expect(await f.ctx.agentStore.getAgent("helper")).toBeUndefined();
    expect(f.executor.getCheckpoints(execution.executionId!)).toEqual([]);
    expect(f.executor.getActiveCheckpoints()).toEqual([]);
    expect(await f.store.getTask(other.id)).toBeDefined();
  });

  it("resumes the latest numbered execution using its accepted agent definitions", async () => {
    const f = fixture(); await f.executor.ready;
    const doc = { ...document(), team: [{ name: "helper", role: "Original" }] };
    const mission = await f.executor.createMission({ data: JSON.stringify(doc) });
    await f.store.updateMission(mission.id, { executionCount: 1 });
    const execution = await f.executor.executeMission(mission.id, { idempotencyKey: "delivery" });
    for (const task of execution.tasks) await f.store.unsafeSetStatus(task.id, "failed", "fixture failure");
    await f.executor.cleanupCompletedGroups(await f.store.listTasks());
    await f.store.updateMission(mission.id, { data: JSON.stringify({ ...doc, team: [{ name: "helper", role: "Edited" }] }) });
    expect((await f.executor.getResumableMissions()).map(mission => mission.id)).toContain(mission.id);
    expect(await f.executor.resumeMission(mission.id, { retryFailed: true })).toMatchObject({ retried: 2 });
    expect(await f.ctx.agentStore.getAgent("helper")).toMatchObject({ role: "Original", missionGroup: execution.executionId });
  });

  it("keeps checkpoints attached to tasks renamed by a planning hook, including after restart", async () => {
    const f = fixture(); await f.executor.ready;
    vi.spyOn(f.ctx.hooks, "runBeforeSync").mockImplementation((name, data: any) => ({
      data: name === "task:create" ? { ...data, title: `Renamed ${data.title}` } : data, cancelled: false,
    }));
    const mission = await f.executor.createMission({ data: JSON.stringify({ ...document(),
      checkpoints: [{ name: "review", afterTasks: ["First"], blocksTasks: ["Second"] }] }) });
    const execution = await f.executor.executeMission(mission.id, { idempotencyKey: "delivery" });
    await f.store.unsafeSetStatus(execution.tasks[0].id, "done", "fixture completion");
    const resumed = fixture(); await resumed.executor.ready;
    await resumed.executor.prepareTaskExecution(execution.tasks[1]);
    expect(await resumed.executor.getBlockingCheckpoint(execution.executionId!, "Renamed Second", execution.tasks[1].id,
      await resumed.store.listTasks())).toMatchObject({ checkpoint: { name: "review" } });
  });

  it("does not let a delayed cleanup finalize a newer execution", async () => {
    const a = fixture(); await a.executor.ready;
    const mission = await a.executor.createMission({ data: JSON.stringify(document()), status: "recurring" });
    const first = await a.executor.executeMission(mission.id, { idempotencyKey: "first" });
    for (const task of first.tasks) await a.store.unsafeSetStatus(task.id, "done", "fixture completion");
    const b = fixture(); await b.executor.ready;
    const finalize = a.store.finalizeMissionExecution.bind(a.store);
    vi.spyOn(a.store, "finalizeMissionExecution").mockImplementationOnce(async (...args) => {
      await b.executor.cleanupCompletedGroups(await b.store.listTasks());
      await b.executor.executeMission(mission.id, { idempotencyKey: "second" });
      return finalize(...args);
    });
    await a.executor.cleanupCompletedGroups(await a.store.listTasks());
    expect(await a.store.getMission(mission.id)).toMatchObject({ status: "active", executionCount: 2 });
  });

  it("retries cleanup when its durable finalization fails", async () => {
    const f = fixture(); await f.executor.ready;
    const mission = await f.executor.createMission({ data: JSON.stringify(document()) });
    const execution = await f.executor.executeMission(mission.id, { idempotencyKey: "delivery" });
    for (const task of execution.tasks) await f.store.unsafeSetStatus(task.id, "done", "fixture completion");
    vi.spyOn(f.store, "finalizeMissionExecution").mockRejectedValueOnce(new Error("fixture finalize unavailable"));
    await expect(f.executor.cleanupCompletedGroups(await f.store.listTasks())).rejects.toThrow("fixture finalize unavailable");
    await f.executor.cleanupCompletedGroups(await f.store.listTasks());
    expect(await f.store.getMission(mission.id)).toMatchObject({ status: "completed" });
  });

  it("recovers an unavailable receipt without poisoning executor readiness", async () => {
    const f = fixture(); await f.executor.ready;
    const mission = await f.executor.createMission({ data: JSON.stringify(document()) });
    const execution = await f.executor.executeMission(mission.id, { idempotencyKey: "delivery" });
    vi.spyOn(FileTaskStore.prototype, "getMissionExecutionById").mockRejectedValueOnce(new Error("fixture recovery unavailable"));
    const resumed = fixture();
    await expect(resumed.executor.ready).resolves.toBeUndefined();
    await expect(resumed.executor.prepareTaskExecution(execution.tasks[0])).resolves.toBeUndefined();
  });

  it("awaits local scheduled admission and retries its original occurrence after an asynchronous failure", async () => {
    const f = fixture(); await f.executor.ready;
    const when = new Date(Date.now() + 60_000).toISOString();
    const mission = await f.executor.createMission({ data: JSON.stringify(document()), status: "scheduled", schedule: when });
    const scheduler = new Scheduler(f.ctx, { checkIntervalMs: 0 });
    const execute = vi.fn().mockRejectedValueOnce(new Error("fixture asynchronous failure"))
      .mockImplementation((id, options) => f.executor.executeMission(id, options));
    scheduler.setExecutor(execute);
    await scheduler.init();
    const now = Date.parse(when) + 1;
    vi.spyOn(Date, "now").mockReturnValue(now);
    await scheduler.check();
    expect(await f.store.listTasks()).toEqual([]);
    await scheduler.check();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0]).toEqual([mission.id, { idempotencyKey: `schedule:${mission.id}:${when}` }]);
    expect(execute.mock.calls[1]).toEqual(execute.mock.calls[0]);
    expect(await f.store.listTasks()).toHaveLength(2);
    scheduler.dispose();
  });

  it("resumes a numbered execution checkpoint through its Mission ID", async () => {
    const f = fixture(); await f.executor.ready;
    const mission = await f.executor.createMission({ data: JSON.stringify({ ...document(),
      checkpoints: [{ name: "review", afterTasks: ["First"], blocksTasks: ["Second"] }] }) });
    await f.store.updateMission(mission.id, { executionCount: 1 });
    const execution = await f.executor.executeMission(mission.id, { idempotencyKey: "delivery" });
    await f.store.unsafeSetStatus(execution.tasks[0].id, "done", "fixture completion");
    expect(await f.executor.getBlockingCheckpoint(execution.executionId!, "Second", execution.tasks[1].id, await f.store.listTasks())).toBeDefined();
    expect(await f.executor.resumeCheckpointByMissionId(mission.id, "review")).toBe(true);
    expect(await f.store.getMission(mission.id)).toMatchObject({ status: "active" });
    expect(await f.executor.getBlockingCheckpoint(execution.executionId!, "Second", execution.tasks[1].id, await f.store.listTasks())).toBeUndefined();
  });

  it("retries rejected finalization when a task retries and finishes between cleanup passes", async () => {
    const f = fixture(); await f.executor.ready;
    const mission = await f.executor.createMission({ data: JSON.stringify({ ...document(), team: [{ name: "helper" }] }) });
    const execution = await f.executor.executeMission(mission.id, { idempotencyKey: "delivery" });
    for (const task of execution.tasks) await f.store.unsafeSetStatus(task.id, "failed", "fixture failure");
    const finalize = f.store.finalizeMissionExecution.bind(f.store);
    vi.spyOn(f.store, "finalizeMissionExecution").mockImplementationOnce(async (...args) => {
      await f.store.transition(execution.tasks[0].id, "pending");
      const rejected = await finalize(...args);
      await f.store.unsafeSetStatus(execution.tasks[0].id, "done", "fixture retry completed");
      return rejected;
    });
    await f.executor.cleanupCompletedGroups(await f.store.listTasks());
    expect(await f.ctx.agentStore.getAgent("helper")).toBeDefined();
    expect(await f.store.getMission(mission.id)).toMatchObject({ status: "active" });
    await f.executor.cleanupCompletedGroups(await f.store.listTasks());
    expect(await f.store.getMission(mission.id)).toMatchObject({ status: "failed" });
    expect(await f.ctx.agentStore.getAgent("helper")).toBeUndefined();
  });
});
