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
