import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileTaskStore, FileRunStore } from "@polpo-ai/file-stores";
import { MissionExecutor } from "@polpo-ai/core/mission-executor";
import { TaskManager } from "@polpo-ai/core/task-manager";
import { AgentManager } from "@polpo-ai/core/agent-manager";
import { HookRegistry } from "@polpo-ai/core/hooks";
import { OrchestratorEngine, Scheduler } from "@polpo-ai/core";
import { ApprovalManager } from "@polpo-ai/core/approval-manager";
import type { ApprovalStore } from "@polpo-ai/core/approval-store";
import { TaskRunner } from "@polpo-ai/core/task-runner";
import type { OrchestratorContext } from "@polpo-ai/core/orchestrator-context";
import { InMemoryCheckpointStore, InMemoryDelayStore } from "../../../core/src/in-memory-stores.js";
import { TypedEmitter } from "../core/events.js";
import { createMockStores, createTestAgent } from "./fixtures.js";
import { taskExecutionReference } from "@polpo-ai/core/task-execution";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "polpo-mission-runtime-")); });
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

function fixture(extra: Partial<OrchestratorContext> = {}) {
  const teams = [{ name: "main", agents: [createTestAgent({ name: "support" })] }];
  const store = new FileTaskStore(root);
  const ctx = { taskStore: store, ...createMockStores(teams), emitter: new TypedEmitter(), hooks: new HookRegistry(),
    runStore: new FileRunStore(root), config: { version: "1", project: "fixture", teams, tasks: [], settings: { maxRetries: 2 } },
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
  it.each([
    { mode: "resolver-rejection", changed: "task" }, { mode: "missing-dependency", changed: "task" },
    { mode: "resolver-rejection", changed: "dependency" }, { mode: "missing-dependency", changed: "dependency" },
  ] as const)("does not cancel stale $mode analysis after $changed changes", async ({ mode, changed }) => {
    const cancelRun = vi.fn();
    const f = fixture({ spawner: { spawn: vi.fn(), kill: vi.fn(), isAlive: () => true, cancelRun } });
    await f.executor.ready;
    const dependency = changed === "dependency" ? await f.taskManager.createTask({ title: "Dependency", description: "Original input", assignTo: "support" }) : undefined;
    if (dependency) await f.taskManager.forceFailTask(dependency.id);
    const task = await f.taskManager.createTask({ title: "Blocked", description: "Wait", assignTo: "support", dependsOn: [dependency?.id ?? "missing"] });
    const changedId = dependency?.id ?? task.id;
    let replacement: Awaited<ReturnType<typeof f.store.claimTaskExecution>>;
    const retry = async () => {
      await f.taskManager.killTask(changedId);
      const pending = await f.store.transition(changedId, "pending");
      replacement = await f.store.claimTaskExecution(taskExecutionReference(pending), "replacement-run");
    };
    let reject!: (error: Error) => void, finished!: () => void;
    const resolving = new Promise<void>((_, fail) => { reject = fail; });
    const fallbackFinished = new Promise<void>(resolve => { finished = resolve; });
    const forceFail = f.taskManager.applyTaskExecutionDecision.bind(f.taskManager);
    vi.spyOn(f.taskManager, "applyTaskExecutionDecision").mockImplementation(async (...args) => {
      try { return await forceFail(...args); } finally { finished(); }
    });
    const engine = new OrchestratorEngine({ ctx: f.ctx, taskManager: f.taskManager, agentManager: f.agentManager,
      missionExecutor: f.executor, assessmentOrchestrator: { handleResult: async () => {}, retryOrFail: async () => {} },
      taskRunner: { collectResults: async () => {}, enforceHealthChecks: async () => { if (mode === "missing-dependency") await retry(); },
        spawnForTask: vi.fn(), syncProcessesFromRunStore: async () => {}, recoverOrphanedTasks: async () => 0 },
      ...(mode === "resolver-rejection" ? { deadlockResolver: { isResolving: () => false,
        analyzeBlockedTasks: () => ({ resolvable: [task], unresolvable: [] }), resolveDeadlock: () => resolving } } : {}),
    });
    const allDone = await engine.tick();
    if (mode === "resolver-rejection") { await retry(); reject(new Error("fixture delayed analysis failure")); await fallbackFinished; }
    expect(await f.store.getTask(changedId)).toEqual(replacement!.task);
    if (dependency) expect(await f.store.getTask(task.id)).toEqual(task);
    expect(await f.ctx.runStore.getRun(replacement!.run.id)).toMatchObject({ status: "running" });
    expect(cancelRun).not.toHaveBeenCalled();
    expect(allDone).toBe(false);
  });

  it.each([
    { hook: "mission:execute", fails: false }, { hook: "mission:execute", fails: true },
    { hook: "schedule:trigger", fails: false }, { hook: "schedule:trigger", fails: true },
  ] as const)("awaits real $hook approval persistence and stays blocked (failure=$fails)", async ({ hook, fails }) => {
    const f = fixture(); await f.executor.ready;
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const requests: unknown[] = [];
    vi.spyOn(console, "error").mockImplementation(() => {});
    f.ctx.config.settings.approvalGates = [{ id: "human", name: "Approve execution", hook, handler: "human" }];
    const approvals = new ApprovalManager(f.ctx, { list: async () => [], upsert: async (request: unknown) => {
      entered(); await released;
      if (fails) throw new Error("fixture approval unavailable");
      requests.push(request);
    } } as unknown as ApprovalStore);
    await approvals.init();
    const when = new Date(Date.now() + 60_000).toISOString();
    const mission = await f.executor.createMission({ data: JSON.stringify(document()),
      ...(hook === "schedule:trigger" ? { status: "scheduled", schedule: when } : {}) });
    const scheduler = new Scheduler(f.ctx, { checkIntervalMs: 0 });
    scheduler.setExecutor((id, options) => f.executor.executeMission(id, options));
    await scheduler.init();
    if (hook === "schedule:trigger") vi.spyOn(Date, "now").mockReturnValue(Date.parse(when) + 1);
    let settled = false;
    const operation = (hook === "mission:execute" ? f.executor.executeMission(mission.id) : scheduler.check())
      .then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
    try {
      await waiting;
      expect(settled).toBe(false); expect(await f.store.listTasks()).toEqual([]);
      release(); await operation;
      expect(settled).toBe(true); expect(await f.store.listTasks()).toEqual([]);
      expect(requests).toHaveLength(fails ? 0 : 1);
      expect((await f.store.getMission(mission.id))?.executionCount ?? 0).toBe(0);
    } finally { release(); await operation; scheduler.dispose(); approvals.dispose(); }
  });

  it("reads persisted gate identities and current resumable work without starting or mutating a runtime", async () => {
    const f = fixture(); await f.executor.ready;
    const identities = [];
    for (const [name, suffix, count] of [["Same:label", "a", 1], ["Same:label #2", "b", 0]] as const) {
      const mission = await f.executor.createMission({ name, data: JSON.stringify({
        tasks: [{ title: `First ${suffix}`, description: "First", assignTo: "support" },
          { title: `Second ${suffix}`, description: "Wait", assignTo: "support", dependsOn: [`First ${suffix}`] }],
        checkpoints: [{ name: "review:wait", afterTasks: [`First ${suffix}`], blocksTasks: [`Second ${suffix}`] }],
        delays: [{ name: "cool:down", afterTasks: [`First ${suffix}`], blocksTasks: [`Second ${suffix}`], duration: "PT1H" }],
      }) });
      await f.store.updateMission(mission.id, { executionCount: count });
      const execution = await f.executor.executeMission(mission.id);
      const [first, blocked] = execution.tasks;
      await f.store.unsafeSetStatus(first.id, "done", "fixture");
      const tasks = await f.store.listTasks();
      await f.executor.getBlockingCheckpoint(execution.executionId!, blocked.title, blocked.id, tasks);
      await f.executor.getBlockingDelay(execution.executionId!, blocked.title, blocked.id, tasks);
      identities.push({ missionId: mission.id, executionId: execution.executionId, group: execution.group });
    }
    const before = { tasks: await f.store.listTasks(), missions: await f.store.listMissions(),
      checkpoints: await f.ctx.checkpointStore!.load(), delays: await f.ctx.delayStore!.load() };
    const { createMissionRuntimeInspector } = await import("@polpo-ai/core");
    // Expose only read ports: there is no spawner, scheduler, emitter or write method.
    const input = { taskStore: { listTasks: () => f.store.listTasks() }, missionStore: { listMissions: () => f.store.listMissions() },
      missionExecutionStore: { getMissionExecutionById: (id: string) => f.store.getMissionExecutionById(id) },
      checkpointStore: { load: () => f.ctx.checkpointStore!.load() }, delayStore: { load: () => f.ctx.delayStore!.load() } };
    const reader = createMissionRuntimeInspector(input);
    const inspect = async () => ({ checkpoints: await reader.getActiveCheckpoints(), delays: await reader.getActiveDelays(),
      resumableMissions: await reader.getResumableMissions() });
    const result = await inspect();
    expect(result.checkpoints).toEqual(identities.map(identity => expect.objectContaining({ ...identity, checkpointName: "review:wait" })));
    expect(result.delays).toEqual(identities.map(identity => expect.objectContaining({ ...identity, delayName: "cool:down" })));
    expect(result.resumableMissions.map((mission: { id: string }) => mission.id).sort()).toEqual(identities.map(identity => identity.missionId).sort());
    expect({ tasks: await f.store.listTasks(), missions: await f.store.listMissions(),
      checkpoints: await f.ctx.checkpointStore!.load(), delays: await f.ctx.delayStore!.load() }).toEqual(before);
    vi.spyOn(input.missionExecutionStore, "getMissionExecutionById").mockRejectedValueOnce(new Error("fixture unavailable"));
    await expect(inspect()).rejects.toThrow("fixture unavailable");
    expect(await inspect()).toEqual(result);
    const taskRead = vi.spyOn(input.taskStore, "listTasks").mockRejectedValue(new Error("unrelated invalid task"));
    expect(await reader.getActiveCheckpoints()).toEqual(result.checkpoints);
    expect(await reader.getActiveDelays()).toEqual(result.delays);
    expect(taskRead).not.toHaveBeenCalled();
  });

  it("captures application metadata outside the authored document and preserves it on replay and restart", async () => {
    const f = fixture(); await f.executor.ready;
    const metadata = { connectionNamespace: "app-a" };
    const doc = { tasks: [{ title: "Scoped", description: "Read account", assignTo: "support",
      metadata: { connectionNamespace: "forged" }, user: "forged" }] };
    const mission = await f.executor.createMission({ data: JSON.stringify(doc), user: "customer-a", metadata });
    metadata.connectionNamespace = "mutated";
    expect((await f.executor.getMission(mission.id))).toMatchObject({ metadata: { connectionNamespace: "app-a" } });
    const accepted = await f.executor.executeMission(mission.id, { idempotencyKey: "delivery" });
    expect(accepted.tasks[0]).toMatchObject({ user: "customer-a", metadata: { connectionNamespace: "app-a" } });
    await f.store.updateMission(mission.id, { metadata: { connectionNamespace: "app-b" } });
    const restarted = fixture(); await restarted.executor.ready;
    expect(await restarted.executor.executeMission(mission.id, { idempotencyKey: "delivery" })).toEqual(accepted);
    const task = (await restarted.store.getTask(accepted.tasks[0].id))!;
    await expect(restarted.executor.prepareTaskExecution(task)).resolves.toBeUndefined();
    await expect(restarted.executor.prepareTaskExecution({ ...task, metadata: { connectionNamespace: "app-b" } }))
      .rejects.toMatchObject({ code: "mission_execution_invalid" });
  });

  it("does not advertise historical failed tasks or empty failed Missions as resumable", async () => {
    const f = fixture(); await f.executor.ready;
    const mission = await f.executor.createMission({ data: JSON.stringify(document()) });
    const old = await f.executor.executeMission(mission.id);
    for (const task of old.tasks) await f.store.unsafeSetStatus(task.id, "failed", "fixture old failure");
    await f.executor.cleanupCompletedGroups(await f.store.listTasks());
    const current = await f.executor.executeMission(mission.id);
    for (const task of current.tasks) await f.store.unsafeSetStatus(task.id, "done", "fixture current success");
    await f.store.createMission({ name: "Empty", data: "{}", status: "failed" });
    expect(await f.executor.getResumableMissions()).toEqual([]);
    const { createMissionRuntimeInspector, currentMissionExecutionTasks } = await import("@polpo-ai/core");
    const reader = createMissionRuntimeInspector({ taskStore: f.store, missionStore: f.store, missionExecutionStore: f.store,
      checkpointStore: f.ctx.checkpointStore!, delayStore: f.ctx.delayStore! });
    expect(await reader.getResumableMissions()).toEqual([]);
    // A task cannot borrow another accepted task's receipt to become current.
    const saved = (await f.store.getMission(mission.id))!;
    await expect(currentMissionExecutionTasks(saved, [{ ...old.tasks[0], missionExecutionId: current.executionId }], f.store))
      .rejects.toMatchObject({ code: "mission_execution_invalid" });
    await expect(currentMissionExecutionTasks(saved, [{ ...current.tasks[0], missionId: undefined }], f.store))
      .rejects.toMatchObject({ code: "mission_execution_invalid" });
    // Unrelated broken work must not make a gate-only inspection fail.
    await f.store.updateTask(current.tasks[0].id, { missionExecutionId: "missing-receipt" });
    expect(await reader.getActiveCheckpoints()).toEqual([]);
    expect(await reader.getActiveDelays()).toEqual([]);
    await expect(reader.getResumableMissions()).rejects.toMatchObject({ code: "mission_execution_invalid" });
  });

  it("keeps display labels and stable execution identity in gate lists and events after restart", async () => {
    const f = fixture(); await f.executor.ready;
    const doc = { ...document(),
      checkpoints: [{ name: "review:approved", afterTasks: ["First"], blocksTasks: ["Second"] }],
      delays: [{ name: "cool:down", afterTasks: ["First"], blocksTasks: ["Second"], duration: "PT1M" }] };
    const a = await f.executor.createMission({ name: "Same:label", data: JSON.stringify(doc) });
    await f.store.updateMission(a.id, { executionCount: 1 });
    const b = await f.executor.createMission({ name: "Same:label #2", data: JSON.stringify(doc).replaceAll("First", "Other first").replaceAll("Second", "Other second") });
    const accepted = [];
    const events: Array<{ event: string; data: unknown }> = [];
    for (const event of ["checkpoint:reached", "delay:started"] as const) f.ctx.emitter.on(event, data => events.push({ event, data }));
    for (const mission of [a, b]) {
      const execution = await f.executor.executeMission(mission.id);
      accepted.push({ missionId: mission.id, executionId: execution.executionId, group: execution.group });
      await f.store.unsafeSetStatus(execution.tasks[0].id, "done", "fixture completion");
      const tasks = await f.store.listTasks();
      await f.executor.getBlockingCheckpoint(execution.executionId!, execution.tasks[1].title, execution.tasks[1].id, tasks);
      await f.executor.getBlockingDelay(execution.executionId!, execution.tasks[1].title, execution.tasks[1].id, tasks);
    }
    const restarted = fixture({ checkpointStore: f.ctx.checkpointStore, delayStore: f.ctx.delayStore });
    await restarted.executor.ready;
    expect(restarted.executor.getActiveCheckpoints()).toEqual(accepted.map(identity => expect.objectContaining({ ...identity, checkpointName: "review:approved" })));
    expect(restarted.executor.getActiveDelays()).toEqual(accepted.map(identity => expect.objectContaining({ ...identity, delayName: "cool:down" })));
    expect(events).toEqual(accepted.flatMap(identity => [
      { event: "checkpoint:reached", data: expect.objectContaining({ ...identity, checkpointName: "review:approved" }) },
      { event: "delay:started", data: expect.objectContaining({ ...identity, delayName: "cool:down" }) },
    ]));
    const resumed = vi.fn(), expired = vi.fn();
    restarted.ctx.emitter.on("checkpoint:resumed", resumed);
    restarted.ctx.emitter.on("delay:expired", expired);
    await restarted.executor.resumeCheckpointByMissionId(a.id, "review:approved");
    expect(resumed).toHaveBeenCalledWith({ ...accepted[0], checkpointName: "review:approved" });
    expect(restarted.executor.getActiveCheckpoints()).toEqual([expect.objectContaining(accepted[1])]);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
    const tasks = await restarted.store.listTasks();
    const blocked = tasks.find(task => task.missionId === a.id && task.title === "Second")!;
    await restarted.executor.getBlockingDelay(accepted[0].executionId!, blocked.title, blocked.id, tasks);
    expect(expired).toHaveBeenCalledWith({ ...accepted[0], delayName: "cool:down" });
    expect(restarted.executor.getActiveDelays()).toEqual([expect.objectContaining(accepted[1])]);
  });

  it("keeps the same public delay identity across a deferred receipt recovery and expiry", async () => {
    const f = fixture(); await f.executor.ready;
    const mission = await f.executor.createMission({ name: "Readable", data: JSON.stringify({ ...document(),
      delays: [{ name: "wait", afterTasks: ["First"], blocksTasks: ["Second"], duration: "PT1M" }] }) });
    const execution = await f.executor.executeMission(mission.id);
    await f.store.unsafeSetStatus(execution.tasks[0].id, "done", "fixture completion");
    await f.executor.getBlockingDelay(execution.executionId!, "Second", execution.tasks[1].id, await f.store.listTasks());
    const restarted = fixture({ checkpointStore: f.ctx.checkpointStore, delayStore: f.ctx.delayStore });
    vi.spyOn(restarted.store, "getMissionExecutionById").mockRejectedValueOnce(new Error("fixture receipt outage"));
    await restarted.executor.ready;
    const identity = { missionId: mission.id, executionId: execution.executionId, group: execution.group, delayName: "wait" };
    expect(restarted.executor.getActiveDelays()).toEqual([expect.objectContaining(identity)]);
    const expired = vi.fn(); restarted.ctx.emitter.on("delay:expired", expired);
    const tasks = await restarted.store.listTasks();
    const task = tasks.find(task => task.title === "Second")!;
    await restarted.executor.prepareTaskExecution(task);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
    await restarted.executor.getBlockingDelay(execution.executionId!, task.title, task.id, tasks);
    expect(expired).toHaveBeenCalledWith(identity);
    expect(restarted.executor.getActiveDelays()).toEqual([]);
  });

  it("validates every task hook before creating tasks or incrementing the counter", async () => {
    const f = fixture(); await f.executor.ready;
    vi.spyOn(f.ctx.hooks, "runBefore").mockImplementation(async (name, data: any) => ({ data, cancelled: name === "task:create" && data.title === "Second", cancelReason: "fixture denial" }));
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

  it("preserves accepted caller context when a spawn hook replaces task fields", async () => {
    const spawn = vi.fn(async (_config: import("@polpo-ai/core/types").RunnerConfig) => ({ pid: -1, configPath: "memory://hook" }));
    const f = fixture({ spawner: { spawn, kill: vi.fn(), isAlive: () => true } });
    await f.executor.ready;
    const mission = await f.executor.createMission({ data: JSON.stringify(document()), user: "customer-a", metadata: { connectionNamespace: "app-a" } });
    const accepted = await f.executor.executeMission(mission.id);
    vi.spyOn(f.ctx.hooks, "runBefore").mockImplementation(async (name, data: any) => {
      if (name === "task:spawn") { data.task.user = "customer-b"; data.task.metadata = { connectionNamespace: "app-b" }; }
      return { data, cancelled: false };
    });
    const runner = new TaskRunner(f.ctx);
    runner.setMissionExecutionPreparer(task => f.executor.prepareTaskExecution(task));
    await runner.spawnForTask(accepted.tasks[0]);
    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn.mock.calls[0][0].task).toMatchObject({ user: "customer-a", metadata: { connectionNamespace: "app-a" } });
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
    vi.spyOn(f.ctx.hooks, "runBefore").mockImplementation(async (name, data: any) => ({
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
