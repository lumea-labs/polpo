import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileTaskStore, FileRunStore } from "@polpo-ai/file-stores";
import { taskExecutionReference } from "@polpo-ai/core/task-execution";
import type { RunnerConfig } from "@polpo-ai/core/types";
import type { SpawnResult } from "@polpo-ai/core/spawner";
import { Orchestrator } from "../core/orchestrator.js";
import { savePolpoConfig } from "../core/config.js";

const roots: string[] = [];
const shells: Orchestrator[] = [];
afterEach(async () => {
  for (const shell of shells.splice(0)) await shell.gracefulStop(0);
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "polpo-shutdown-recovery-")); roots.push(root);
  const directory = join(root, ".polpo");
  savePolpoConfig(directory, { project: "shutdown", teams: [], settings: {
    maxRetries: 0, workDir: ".", logLevel: "quiet", maxQuestionRounds: 0,
    approvalGates: [{ id: "complete", name: "Review output", hook: "task:complete", handler: "human" }],
  } });
  const tasks = new FileTaskStore(directory), runs = new FileRunStore(directory);
  const spawner = { spawn: vi.fn(async (_config: RunnerConfig): Promise<SpawnResult> => { throw new Error("Unexpected redispatch"); }),
    cancelRun: vi.fn(), kill: vi.fn(), isAlive: vi.fn(() => true) };
  const assess = vi.fn(async () => ({ passed: true, checks: [], metrics: [], timestamp: new Date().toISOString() }));
  async function start() {
    const shell = new Orchestrator({ workDir: root, store: tasks, runStore: runs, spawner, assessFn: assess });
    await shell.initInteractive("shutdown", { name: "default", agents: [{ name: "support" }] });
    shells.push(shell);
    return shell;
  }
  const shell = await start();
  const task = await tasks.createTask({ title: "Read Drive", description: "Read the selected account", assignTo: "support",
    dependsOn: [], expectations: [{ type: "file_exists", paths: ["result.txt"] }], metrics: [], maxRetries: 0 });
  const first = await tasks.claimTaskExecution(taskExecutionReference(task), "original-run");
  const result = { exitCode: 0, stdout: "Saved output", stderr: "", duration: 1 };
  return { shell, start, tasks, runs, first, result, spawner, assess };
}

describe("Node shutdown and execution-bound recovery", () => {
  it("preserves successful output across shutdown and restart until normal completion consent", async () => {
    const f = await fixture();
    await f.runs.completeRun(f.first.run.id, "completed", f.result);
    await f.shell.gracefulStop(0);
    expect(await f.tasks.getTask(f.first.task.id)).toMatchObject({ status: "in_progress", activeRunId: f.first.run.id });
    expect((await f.runs.getRun(f.first.run.id))?.collectedAt).toBeUndefined();
    const restarted = await f.start();
    expect(await f.tasks.getTask(f.first.task.id)).toMatchObject({ status: "in_progress", executionRevision: 1 });
    await restarted.tick();
    expect(await f.tasks.getTask(f.first.task.id)).toMatchObject({ status: "awaiting_approval", result: { stdout: "Saved output" } });
    const requests = await restarted.engine.getPendingApprovals();
    expect(requests).toHaveLength(1);
    expect(f.assess).toHaveBeenCalledOnce();
    expect(f.spawner.spawn).not.toHaveBeenCalled();
    await restarted.engine.approveRequest(requests[0].id);
    expect(await f.tasks.getTask(f.first.task.id)).toMatchObject({ status: "done" });
  });

  it("leaves a real failed result for normal retry policy after restart", async () => {
    const f = await fixture();
    await f.runs.completeRun(f.first.run.id, "failed", { ...f.result, exitCode: 1, stderr: "Provider rejected operation" });
    await f.shell.gracefulStop(0);
    expect((await f.runs.getRun(f.first.run.id))?.collectedAt).toBeUndefined();
    const restarted = await f.start();
    await restarted.tick();
    expect(await f.tasks.getTask(f.first.task.id)).toMatchObject({ status: "failed" });
    expect(f.spawner.spawn).not.toHaveBeenCalled();
  });

  it("does not apply an old successful Run to its replacement Task attempt", async () => {
    const f = await fixture();
    await f.runs.completeRun(f.first.run.id, "completed", f.result);
    const pending = (await f.tasks.mutateTaskExecution(taskExecutionReference(f.first.task), {
      type: "requeue", countRetry: false, reason: "Operator replaced the work",
    })).task;
    const next = await f.tasks.claimTaskExecution(taskExecutionReference(pending), "replacement-run");
    await f.shell.gracefulStop(0);
    expect(await f.tasks.getTask(f.first.task.id)).toEqual(next.task);
    expect(await f.runs.getRun(next.run.id)).toEqual(next.run);
  });

  it("never signals a persisted PID or marks an unowned Run killed during shutdown", async () => {
    const f = await fixture();
    await f.runs.updateSpawnInfo(f.first.run.id, 31337, "foreign://owner");
    const run = await f.runs.getRun(f.first.run.id);
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    await f.shell.gracefulStop(0);
    expect(kill).not.toHaveBeenCalled();
    expect(f.spawner.kill).not.toHaveBeenCalled();
    expect(await f.runs.getRun(f.first.run.id)).toEqual(run);
  });

  it("preserves completion that races the orphan liveness snapshot", async () => {
    const f = await fixture();
    f.spawner.isAlive.mockReturnValue(false);
    const active = f.runs.getActiveRuns.bind(f.runs);
    vi.spyOn(f.runs, "getActiveRuns").mockImplementationOnce(async () => {
      const snapshot = await active();
      await f.runs.completeRun(f.first.run.id, "completed", f.result);
      return snapshot;
    });
    await f.shell.engine.recoverOrphanedTasks();
    expect(await f.tasks.getTask(f.first.task.id)).toEqual(f.first.task);
    expect((await f.runs.getRun(f.first.run.id))?.collectedAt).toBeUndefined();
    await f.shell.tick();
    expect(await f.tasks.getTask(f.first.task.id)).toMatchObject({ status: "awaiting_approval" });
  });

  it("does not requeue a replacement that wins during orphan recovery", async () => {
    const f = await fixture();
    await f.runs.completeRun(f.first.run.id, "killed", { ...f.result, exitCode: 1 });
    await f.runs.markRunCollected(f.first.run.id);
    const list = f.tasks.listTasks.bind(f.tasks);
    let replacement = f.first;
    vi.spyOn(f.tasks, "listTasks").mockImplementationOnce(async () => {
      const snapshot = await list();
      const pending = (await f.tasks.mutateTaskExecution(taskExecutionReference(f.first.task), {
        type: "requeue", countRetry: false, reason: "Other supervisor",
      })).task;
      replacement = await f.tasks.claimTaskExecution(taskExecutionReference(pending), "other-supervisor");
      return snapshot;
    });
    await f.shell.engine.recoverOrphanedTasks();
    expect(await f.tasks.getTask(f.first.task.id)).toEqual(replacement.task);
    expect(await f.runs.getRun(replacement.run.id)).toEqual(replacement.run);
  });

  it.each(["running", "completed"])("awaits actual local exit even with a %s Run row", async status => {
    const f = await fixture();
    await f.tasks.mutateTaskExecution(taskExecutionReference(f.first.task), { type: "requeue", countRetry: false, reason: "Dispatch fixture" });
    let exit!: () => void;
    f.spawner.spawn.mockResolvedValue({ pid: 42, configPath: "local://owned", onExit: callback => { exit = callback; } });
    await f.shell.tick();
    const task = (await f.tasks.getTask(f.first.task.id))!;
    if (status === "completed") await f.runs.completeRun(task.activeRunId!, "completed", f.result);
    const closeStore = vi.spyOn(f.tasks, "close");
    let closed = false;
    const closing = f.shell.gracefulStop(2000).then(() => { closed = true; });
    try {
      await vi.waitFor(() => expect(f.spawner.cancelRun).toHaveBeenCalledWith(task.activeRunId));
      expect(closed).toBe(false);
      expect(closeStore).not.toHaveBeenCalled();
      expect(f.spawner.kill).not.toHaveBeenCalled();
      exit(); await closing;
      expect(closeStore).toHaveBeenCalledOnce();
      if (status === "completed") expect((await f.runs.getRun(task.activeRunId!))?.collectedAt).toBeUndefined();
    } finally { exit(); await closing; }
  });

  it("drains assessment already in progress before closing its stores", async () => {
    const f = await fixture(), entered = deferred(), release = deferred();
    await f.runs.completeRun(f.first.run.id, "completed", f.result);
    f.assess.mockImplementationOnce(async () => {
      entered.resolve(); await release.promise;
      return { passed: true, checks: [], metrics: [], timestamp: new Date().toISOString() };
    });
    const tick = f.shell.tick();
    await entered.promise;
    const closeStore = vi.spyOn(f.tasks, "close");
    const closing = f.shell.gracefulStop(2000);
    try {
      await new Promise(resolve => setImmediate(resolve));
      expect(closeStore).not.toHaveBeenCalled();
      release.resolve(); await tick; await closing;
      expect(await f.tasks.getTask(f.first.task.id)).toMatchObject({ status: "awaiting_approval" });
      expect(closeStore).toHaveBeenCalledOnce();
      await expect(f.shell.tick()).rejects.toThrow("closed");
    } finally { release.resolve(); await tick; await closing; }
  });

  it("owns and cancels a spawn which returns after shutdown begins", async () => {
    const f = await fixture(), entered = deferred(), release = deferred();
    await f.tasks.mutateTaskExecution(taskExecutionReference(f.first.task), { type: "requeue", countRetry: false, reason: "Dispatch fixture" });
    let exit!: () => void;
    f.spawner.spawn.mockImplementation(async () => {
      entered.resolve(); await release.promise;
      return { pid: 42, configPath: "local://late", onExit: callback => { exit = callback; } };
    });
    const tick = f.shell.tick();
    await entered.promise;
    const closeStore = vi.spyOn(f.tasks, "close");
    const closing = f.shell.gracefulStop(2000);
    try {
      const task = (await f.tasks.getTask(f.first.task.id))!;
      await vi.waitFor(() => expect(f.spawner.cancelRun).toHaveBeenCalledWith(task.activeRunId));
      expect(await f.runs.getRun(task.activeRunId!)).toMatchObject({ status: "killed" });
      expect(closeStore).not.toHaveBeenCalled();
      release.resolve();
      await vi.waitFor(() => expect(exit).toBeTypeOf("function"));
      expect(closeStore).not.toHaveBeenCalled();
      exit(); await tick; await closing;
      expect(closeStore).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await vi.waitFor(() => expect(exit).toBeTypeOf("function"));
      exit(); await tick; await closing;
    }
  });

  it("retries cancellation of an exact pending spawn after cleanup notification fails", async () => {
    const f = await fixture(), entered = deferred(), release = deferred();
    await f.tasks.mutateTaskExecution(taskExecutionReference(f.first.task), { type: "requeue", countRetry: false, reason: "Dispatch fixture" });
    f.spawner.spawn.mockImplementation(async () => {
      entered.resolve(); await release.promise;
      throw new Error("Preparation cancelled after cleanup");
    });
    f.spawner.cancelRun.mockRejectedValueOnce(new Error("Cleanup unavailable"))
      .mockImplementation(async () => { release.resolve(); });
    const tick = f.shell.tick();
    await entered.promise;
    const task = (await f.tasks.getTask(f.first.task.id))!;
    const closeStore = vi.spyOn(f.tasks, "close");
    const first = f.shell.gracefulStop(2000).then(() => undefined, error => error as Error);
    try {
      expect(await first).toMatchObject({ message: "Cleanup unavailable" });
      expect(f.spawner.cancelRun).toHaveBeenCalledExactlyOnceWith(task.activeRunId);
      expect(await f.runs.getRun(task.activeRunId!)).toMatchObject({ status: "killed", result: { stderr: "Killed during shutdown" } });
      expect((await f.runs.getRun(task.activeRunId!))?.collectedAt).toBeUndefined();
      expect(closeStore).not.toHaveBeenCalled();
      await f.shell.gracefulStop(2000);
      await tick;
      expect(f.spawner.cancelRun.mock.calls).toEqual([[task.activeRunId], [task.activeRunId]]);
      expect((await f.runs.getRun(task.activeRunId!))?.collectedAt).toBeTruthy();
      expect(closeStore).toHaveBeenCalledOnce();
      expect(f.assess).not.toHaveBeenCalled();
      expect(f.spawner.kill).not.toHaveBeenCalled();
    } finally { release.resolve(); await tick; await first; await f.shell.gracefulStop(2000); }
  });

  it("keeps a timed-out drain owned until post-exit persistence finishes", async () => {
    const f = await fixture(), entered = deferred(), release = deferred();
    await f.tasks.mutateTaskExecution(taskExecutionReference(f.first.task), { type: "requeue", countRetry: false, reason: "Dispatch fixture" });
    let exit!: () => void;
    f.spawner.spawn.mockResolvedValue({ pid: 42, configPath: "local://owned", onExit: callback => { exit = callback; } });
    await f.shell.tick();
    const read = f.runs.getRun.bind(f.runs);
    vi.spyOn(f.runs, "getRun").mockImplementationOnce(async id => {
      entered.resolve(); await release.promise; return read(id);
    });
    const closeStore = vi.spyOn(f.tasks, "close");
    const first = f.shell.gracefulStop(150).then(() => undefined, error => error as Error);
    let retry: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(f.spawner.cancelRun).toHaveBeenCalled());
      exit(); await entered.promise;
      expect(await first).toMatchObject({ message: expect.stringContaining("stores remain open") });
      let closed = false;
      retry = f.shell.gracefulStop(2000).then(() => { closed = true; });
      await new Promise(resolve => setImmediate(resolve));
      expect(closed).toBe(false);
      expect(closeStore).not.toHaveBeenCalled();
      release.resolve(); await retry;
      expect(closeStore).toHaveBeenCalledOnce();
    } finally { release.resolve(); exit(); await first; await retry; }
  });

  it("retains the interrupted preparation receipt until its acknowledgement succeeds", async () => {
    const f = await fixture(), entered = deferred(), release = deferred();
    await f.tasks.mutateTaskExecution(taskExecutionReference(f.first.task), { type: "requeue", countRetry: false, reason: "Dispatch fixture" });
    f.spawner.spawn.mockImplementation(async () => {
      entered.resolve(); await release.promise;
      throw new Error("Preparation cancelled after cleanup");
    });
    f.spawner.cancelRun.mockImplementation(async () => { release.resolve(); });
    const tick = f.shell.tick(); await entered.promise;
    const task = (await f.tasks.getTask(f.first.task.id))!;
    vi.spyOn(f.runs, "markRunCollected").mockRejectedValueOnce(new Error("Acknowledgement unavailable"));
    const closeStore = vi.spyOn(f.tasks, "close");
    try {
      await expect(f.shell.gracefulStop(2000)).rejects.toThrow("Acknowledgement unavailable");
      await tick;
      expect(closeStore).not.toHaveBeenCalled();
      expect((await f.runs.getRun(task.activeRunId!))?.collectedAt).toBeUndefined();
      await f.shell.gracefulStop(2000);
      expect((await f.runs.getRun(task.activeRunId!))?.collectedAt).toBeTruthy();
      expect(f.spawner.cancelRun).toHaveBeenCalledExactlyOnceWith(task.activeRunId);
      expect(closeStore).toHaveBeenCalledOnce();
      await f.start();
      expect(await f.tasks.getTask(task.id)).toMatchObject({ status: "pending", retries: 0 });
    } finally { release.resolve(); await tick; await f.shell.gracefulStop(2000); }
  });

  it("does not assess shutdown interruption from an already-running collection query", async () => {
    const f = await fixture(), entered = deferred(), release = deferred();
    await f.tasks.mutateTaskExecution(taskExecutionReference(f.first.task), { type: "requeue", countRetry: false, reason: "Dispatch fixture" });
    let exit!: () => void;
    f.spawner.spawn.mockResolvedValue({ pid: 42, configPath: "local://owned", onExit: callback => { exit = callback; } });
    await f.shell.tick();
    const task = (await f.tasks.getTask(f.first.task.id))!;
    const terminal = f.runs.getTerminalRuns.bind(f.runs);
    vi.spyOn(f.runs, "getTerminalRuns").mockImplementationOnce(async () => {
      entered.resolve(); await release.promise; return terminal();
    });
    const tick = f.shell.tick(); await entered.promise;
    const closing = f.shell.gracefulStop(2000);
    try {
      await vi.waitFor(() => expect(f.spawner.cancelRun).toHaveBeenCalled());
      release.resolve(); await tick;
      expect(await f.tasks.getTask(task.id)).toEqual(task);
      expect(f.assess).not.toHaveBeenCalled();
      exit(); await closing;
    } finally { release.resolve(); exit?.(); await tick; await closing; }
  });

  it("keeps stores open when shutdown times out and permits a later verified drain", async () => {
    const f = await fixture();
    await f.tasks.mutateTaskExecution(taskExecutionReference(f.first.task), { type: "requeue", countRetry: false, reason: "Dispatch fixture" });
    let exit!: () => void;
    f.spawner.spawn.mockResolvedValue({ pid: 42, configPath: "local://owned", onExit: callback => { exit = callback; } });
    await f.shell.tick();
    const closeStore = vi.spyOn(f.tasks, "close");
    try {
      await expect(f.shell.gracefulStop(10)).rejects.toThrow("stores remain open");
      expect(closeStore).not.toHaveBeenCalled();
      exit(); await f.shell.gracefulStop(2000);
      expect(closeStore).toHaveBeenCalledOnce();
    } finally { exit(); }
  });

  it("retries interrupted Run acknowledgement after its owner has exited", async () => {
    const f = await fixture();
    await f.tasks.mutateTaskExecution(taskExecutionReference(f.first.task), { type: "requeue", countRetry: false, reason: "Dispatch fixture" });
    let exit!: () => void;
    f.spawner.spawn.mockResolvedValue({ pid: 42, configPath: "local://owned", onExit: callback => { exit = callback; } });
    await f.shell.tick();
    const task = (await f.tasks.getTask(f.first.task.id))!;
    vi.spyOn(f.runs, "markRunCollected").mockRejectedValueOnce(new Error("Acknowledgement unavailable"));
    const closeStore = vi.spyOn(f.tasks, "close");
    const first = f.shell.gracefulStop(2000).then(() => undefined, error => error as Error);
    try {
      await vi.waitFor(() => expect(f.spawner.cancelRun).toHaveBeenCalled());
      exit();
      expect(await first).toMatchObject({ message: "Acknowledgement unavailable" });
      expect(closeStore).not.toHaveBeenCalled();
      await f.shell.gracefulStop(2000);
      expect((await f.runs.getRun(task.activeRunId!))?.collectedAt).toBeTruthy();
      await f.start();
      expect(await f.tasks.getTask(task.id)).toMatchObject({ status: "pending", retries: 0 });
    } finally { exit(); await first; }
  });

});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
