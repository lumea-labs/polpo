import { describe, expect, it, vi } from "vitest";
import { TaskRunner } from "../task-runner.js";
import { HookRegistry } from "../hooks.js";
import type { OrchestratorContext } from "../orchestrator-context.js";
import type { AgentSnapshot } from "../agent-store.js";
import type { Task, RunnerConfig } from "../types.js";

function fixture() {
  const task: Task = { id: "task", title: "Read", description: "Read", assignTo: "support", dependsOn: [], status: "pending",
    expectations: [], metrics: [], retries: 0, maxRetries: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  let snapshot: AgentSnapshot | undefined = { agent: { name: "support", role: "original" }, teamName: "default", revision: { incarnation: "original", version: 0 } };
  const agentStore = { getAgent: vi.fn(async () => ({ name: "support", role: "unversioned" })), getAgentSnapshot: vi.fn(async () => snapshot),
    compareAndSwapAgent: vi.fn(), deleteAgentIfRevision: vi.fn() };
  const spawner = { spawn: vi.fn(async (_config: RunnerConfig) => ({ pid: 123, configPath: "memory://test" })), isAlive: () => false, kill: vi.fn() };
  const runStore = { upsertRun: vi.fn(), updateSpawnInfo: vi.fn(), completeRun: vi.fn(), markRunCollected: vi.fn(),
    getActiveRuns: vi.fn(async (): Promise<any[]> => []), getRunByTaskId: vi.fn() };
  const memoryStore = { get: vi.fn(async () => "") };
  const ctx = { agentStore, spawner, runStore, memoryStore, emitter: { emit: vi.fn() }, hooks: new HookRegistry(),
    taskStore: { transition: vi.fn(), updateTask: vi.fn(), getState: async () => ({ processes: [] }), listTasks: async () => [task], getTask: async () => task },
    config: { settings: { maxRetries: 0, workDir: ".", logLevel: "quiet" }, teams: [] },
    workDir: "/tmp/lifetime-test", agentWorkDir: "/tmp/lifetime-test", polpoDir: "/tmp/lifetime-test/.polpo",
  } as unknown as OrchestratorContext;
  return { task, agentStore, spawner, runStore, memoryStore, runner: new TaskRunner(ctx), replace: (next: AgentSnapshot | undefined) => { snapshot = next; } };
}

describe("TaskRunner agent lifetime", () => {
  it("retries a failed pending cancellation while another pending cancellation remains owned", async () => {
    const f = fixture();
    let releaseA!: () => void, releaseB!: () => void;
    const heldA = new Promise<void>(resolve => { releaseA = resolve; });
    const heldB = new Promise<void>(resolve => { releaseB = resolve; });
    f.spawner.spawn.mockImplementation(async config => {
      await (config.taskId === "a" ? heldA : heldB);
      throw new Error("Preparation cancelled after cleanup");
    });
    const workA = f.runner.spawnForTask({ ...f.task, id: "a" });
    const workB = f.runner.spawnForTask({ ...f.task, id: "b" });
    await vi.waitFor(() => expect(f.spawner.spawn).toHaveBeenCalledTimes(2));
    const runA = f.spawner.spawn.mock.calls.find(([config]) => config.taskId === "a")![0].runId;
    const runB = f.spawner.spawn.mock.calls.find(([config]) => config.taskId === "b")![0].runId;
    let attemptsA = 0;
    const cancelRun = vi.fn(async (runId: string) => {
      if (runId === runA) {
        if (++attemptsA === 1) throw new Error("Cleanup unavailable");
        releaseA();
      } else await heldB;
    });
    Object.assign(f.spawner, { cancelRun });
    Object.assign(f.runStore, { getRun: async () => undefined });
    let error: unknown;
    const first = f.runner.close().catch(value => { error = value; });
    let retry: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(error).toMatchObject({ message: "Cleanup unavailable" }));
      expect(cancelRun.mock.calls).toEqual([[runA], [runB]]);
      retry = f.runner.close();
      await vi.waitFor(() => expect(cancelRun.mock.calls).toEqual([[runA], [runB], [runA]]));
      releaseB();
      await Promise.all([retry, workA, workB]);
    } finally {
      releaseA(); releaseB();
      await Promise.all([first, retry, workA, workB]);
      await f.runner.close();
    }
  });

  it("updates the pre-registered Run through the atomic configuration port before spawning", async () => {
    const f = fixture();
    const updateRunConfig = vi.fn(async () => true);
    Object.assign(f.runStore, { updateRunConfig });
    await f.runner.spawnForTask(f.task);
    const runnerConfig = f.spawner.spawn.mock.calls[0][0];
    expect(f.runStore.upsertRun).toHaveBeenCalledTimes(1);
    expect(updateRunConfig).toHaveBeenCalledExactlyOnceWith(runnerConfig.runId, runnerConfig, `pending://${runnerConfig.runId}`);
  });

  it.each(["missing", "terminal"])("does not spawn or upsert again when the configuration port rejects a %s Run", async () => {
    const f = fixture();
    const updateRunConfig = vi.fn(async () => false);
    Object.assign(f.runStore, { updateRunConfig });
    await f.runner.spawnForTask(f.task);
    expect(updateRunConfig).toHaveBeenCalledTimes(1);
    expect(f.runStore.upsertRun).toHaveBeenCalledTimes(1);
    expect(f.spawner.spawn).not.toHaveBeenCalled();
    expect(f.runStore.completeRun).not.toHaveBeenCalled();
  });

  it("does not fall back to upsert or spawn after a configuration write error", async () => {
    const f = fixture();
    Object.assign(f.runStore, { updateRunConfig: vi.fn(async () => { throw new Error("config write failed"); }) });
    await f.runner.spawnForTask(f.task);
    expect(f.runStore.upsertRun).toHaveBeenCalledTimes(1);
    expect(f.spawner.spawn).not.toHaveBeenCalled();
    expect(f.runStore.completeRun).toHaveBeenCalledWith(expect.any(String), "failed", expect.objectContaining({ stderr: expect.stringContaining("config write failed") }));
  });

  it("retains the legacy registration path only for a store without the optional port", async () => {
    const f = fixture();
    await f.runner.spawnForTask(f.task);
    expect(f.runStore.upsertRun).toHaveBeenCalledTimes(2);
    expect(f.spawner.spawn).toHaveBeenCalledTimes(1);
  });

  it("pins config and identity before asynchronous context loading", async () => {
    const f = fixture();
    f.memoryStore.get.mockImplementationOnce(async () => {
      f.replace({ agent: { name: "support", role: "replacement" }, teamName: "default", revision: { incarnation: "replacement", version: 0 } });
      return "";
    });
    await f.runner.spawnForTask(f.task);
    expect(f.spawner.spawn.mock.calls[0][0]).toMatchObject({ agent: { role: "original" }, agentIdentity: { name: "support", incarnation: "original" } });
    expect(f.agentStore.getAgent).not.toHaveBeenCalled();
  });

  it("does not fall back to a name-only config for a missing snapshot", async () => {
    const f = fixture(); f.replace(undefined);
    await f.runner.spawnForTask(f.task);
    expect(f.spawner.spawn).not.toHaveBeenCalled();
    expect(f.runStore.completeRun).toHaveBeenCalledWith(expect.any(String), "failed", expect.objectContaining({ stderr: expect.stringContaining('No agent "support"') }));
  });

  it.each([undefined, { name: "support", incarnation: "former" }])("does not adopt a recovered checkpoint from another lifetime: %j", async agentIdentity => {
    const f = fixture();
    f.runStore.getActiveRuns.mockResolvedValueOnce([{ id: "old", taskId: "task", pid: 1,
      config: { agentIdentity }, resumeState: { turn: 0, history: [{ role: "user", content: "old" }], context: {}, steps: [], createdAt: new Date().toISOString() } }]);
    await f.runner.recoverOrphanedTasks();
    await f.runner.spawnForTask(f.task);
    expect(f.spawner.spawn).not.toHaveBeenCalled();
    expect(f.runStore.completeRun).toHaveBeenLastCalledWith(expect.any(String), "failed", expect.objectContaining({ stderr: expect.stringMatching(/identity/i) }));
  });

  it("resumes a recovered checkpoint from the same creation identity after config edits", async () => {
    const f = fixture();
    f.replace({ agent: { name: "support", role: "edited" }, teamName: "default", revision: { incarnation: "original", version: 35 } });
    f.runStore.getActiveRuns.mockResolvedValueOnce([{ id: "old", taskId: "task", pid: 1,
      config: { agentIdentity: { name: "support", incarnation: "original" } },
      resumeState: { turn: 0, history: [{ role: "user", content: "old" }], context: {}, steps: [], createdAt: new Date().toISOString() } }]);
    await f.runner.recoverOrphanedTasks(); await f.runner.spawnForTask(f.task);
    expect(f.spawner.spawn.mock.calls[0][0]).toMatchObject({ agentIdentity: { name: "support", incarnation: "original" }, resumeState: { turn: 0 } });
  });
});
