import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileTaskStore, FileRunStore } from "@polpo-ai/file-stores";
import { TaskManager } from "@polpo-ai/core/task-manager";
import { taskExecutionReference } from "@polpo-ai/core/task-execution";
import type { OrchestratorContext } from "@polpo-ai/core/orchestrator-context";
import { analyzeBlockedTasks, resolveDeadlock, createDeadlockResolver } from "../core/deadlock-resolver.js";
import type { DeadlockFacade } from "@polpo-ai/core";
import { queryText } from "@polpo-ai/llm";
vi.mock("@polpo-ai/llm", async original => ({ ...await original<typeof import("@polpo-ai/llm")>(), queryText: vi.fn(), resolveModelSpec: vi.fn(() => ({})) }));
vi.mock("../llm/retry.js", () => ({ withRetry: (work: () => unknown) => work() }));
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "polpo-deadlock-")); });
afterEach(() => { vi.restoreAllMocks(); vi.mocked(queryText).mockReset(); rmSync(root, { recursive: true, force: true }); });

async function fixture() {
  const store = new FileTaskStore(root), runs = new FileRunStore(root), cancelRun = vi.fn();
  const manager = new TaskManager({ taskStore: store, spawner: { cancelRun }, emitter: { emit: vi.fn() } } as unknown as OrchestratorContext);
  const emit = vi.fn(() => true), getMemory = async () => "";
  const facade = { getStore: () => store, getMemory, getConfig: () => ({ settings: { maxResolutionAttempts: 2 } }), emit,
    forceFailTask: manager.forceFailTask.bind(manager),
    applyTaskExecutionDecision: (...args: Parameters<TaskManager["applyTaskExecutionDecision"]>) => manager.applyTaskExecutionDecision(...args),
  } as unknown as DeadlockFacade;
  const create = (title: string, dependsOn: string[] = []) => store.createTask({ title, description: title, assignTo: "support", dependsOn, expectations: [], metrics: [], maxRetries: 2 });
  const first = await store.claimTaskExecution(taskExecutionReference(await create("Dependency")), "dependency-run");
  await store.transition(first.task.id, "failed");
  const dependency = (await store.getTask(first.task.id))!;
  const task = await create("Blocked", [dependency.id]);
  const analyze = async () => analyzeBlockedTasks([task], await store.listTasks());
  const deferred = (action: string) => {
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; }), wait = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(queryText).mockImplementation(async () => { entered(); await wait; return { text: JSON.stringify({ action, reason: "fixture", absorbedDescription: "Complete the dependency" }) } as never; });
    return { ready, release };
  };
  return { store, runs, manager, facade, emit, cancelRun, dependency, task, create, analyze, deferred };
}

describe("deadlock decisions against real Task/Run persistence", () => {
  it.each(["engine", "legacy-shell"])("wires %s to the shared conditional decision facade", async mode => {
    const { Orchestrator } = await import("../core/orchestrator.js");
    const { createTestAgent } = await import("./fixtures.js");
    const f = await fixture(), gate = f.deferred("absorb");
    // The historical failed dependency has no live owner for this startup test.
    await f.runs.completeRun("dependency-run", "failed", { exitCode: 1, stdout: "", stderr: "fixture failure", duration: 0 });
    await f.runs.markRunCollected("dependency-run");
    const shell = new Orchestrator({ workDir: root, store: f.store, runStore: f.runs });
    await shell.initInteractive("fixture", { name: "main", agents: [createTestAgent({ name: "support" })] });
    try {
      const operation = mode === "legacy-shell" ? resolveDeadlock(await f.analyze(), shell) : undefined;
      if (mode === "engine") expect(await shell.tick()).toBe(false);
      await gate.ready; gate.release(); await operation;
      await vi.waitFor(async () => expect(await f.store.getTask(f.task.id)).toMatchObject({ status: "pending", executionRevision: 1, resolutionAttempts: 1, dependsOn: [] }));
    } finally { gate.release(); await shell.gracefulStop(0); }
  });

  it("keeps resolution ownership separate for two engines", async () => {
    const f = await fixture(), one = createDeadlockResolver(), two = createDeadlockResolver(), gate = f.deferred("retry");
    const resolving = one.resolveDeadlock(await f.analyze(), f.facade); await gate.ready;
    try {
      expect(one.isResolving()).toBe(true);
      expect(two.isResolving()).toBe(false);
      await two.resolveDeadlock({ resolvable: [], unresolvable: [] }, f.facade);
      expect(two.isResolving()).toBe(false);
    } finally { gate.release(); await resolving; }
    expect(one.isResolving()).toBe(false);
  });

  it("fails closed when a store cannot validate dependency preconditions", async () => {
    const f = await fixture(), gate = f.deferred("absorb");
    Object.defineProperty(f.store, "mutateTaskExecutionConditionally", { value: undefined });
    const resolving = resolveDeadlock(await f.analyze(), f.facade); await gate.ready; gate.release();
    await expect(resolving).rejects.toMatchObject({ code: "task_execution_unsupported" });
    expect(await f.store.getTask(f.task.id)).toEqual(f.task);
    expect(f.emit.mock.calls.filter(([event]) => event === "deadlock:resolved")).toEqual([]);
  });

  it.each(["absorb", "retry", "fail"])("discards delayed %s after the blocked attempt is replaced", async action => {
    const f = await fixture(), gate = f.deferred(action);
    const resolving = resolveDeadlock(await f.analyze(), f.facade); await gate.ready;
    const queued = (await f.store.mutateTaskExecution(taskExecutionReference(f.task), { type: "requeue", countRetry: false, reason: "Operator replacement" })).task;
    const replacement = await f.store.claimTaskExecution(taskExecutionReference(queued), "blocked-replacement");
    gate.release(); await resolving;
    expect(await f.store.getTask(f.task.id)).toEqual(replacement.task);
    expect(await f.runs.getRun(replacement.run.id)).toEqual(replacement.run);
    expect(await f.store.getTask(f.dependency.id)).toEqual(f.dependency);
    expect(f.emit.mock.calls.filter(([event]) => event === "deadlock:resolved" || event === "deadlock:unresolvable")).toEqual([]);
  });

  it.each(["absorb", "retry", "fail"])("discards delayed %s after only the dependency is retried", async action => {
    const f = await fixture(), gate = f.deferred(action);
    const resolving = resolveDeadlock(await f.analyze(), f.facade); await gate.ready;
    const queued = await f.store.transition(f.dependency.id, "pending");
    const replacement = await f.store.claimTaskExecution(taskExecutionReference(queued), "dependency-replacement");
    gate.release(); await resolving;
    expect(await f.store.getTask(f.task.id)).toEqual(f.task);
    expect(await f.store.getTask(f.dependency.id)).toEqual(replacement.task);
    expect(await f.runs.getRun(replacement.run.id)).toEqual(replacement.run);
    expect(f.cancelRun).not.toHaveBeenCalled();
  });

  it.each(["description", "dependsOn", "maxRetries"])("preserves a same-generation %s edit during analysis", async field => {
    const f = await fixture(), gate = f.deferred(field === "maxRetries" ? "retry" : "absorb");
    const resolving = resolveDeadlock(await f.analyze(), f.facade); await gate.ready;
    const changed = field === "maxRetries" ? await f.store.updateTask(f.dependency.id, { maxRetries: 0 })
      : await f.store.updateTask(f.task.id, field === "description" ? { description: "Operator edited input" } : { dependsOn: ["new-dependency"] });
    gate.release(); await resolving;
    expect(await f.store.getTask(changed.id)).toEqual(changed);
    expect(f.emit.mock.calls.filter(([event]) => event === "deadlock:resolved" || event === "deadlock:unresolvable")).toEqual([]);
  });

  it("atomically absorbs just the classified dependency and preserves other failed dependencies", async () => {
    const f = await fixture(), second = await f.create("Other failed dependency");
    await f.store.mutateTaskExecution(taskExecutionReference(second), { type: "cancel" });
    const task = await f.store.updateTask(f.task.id, { dependsOn: [f.dependency.id, second.id] });
    const analysis = analyzeBlockedTasks([task], await f.store.listTasks()), gate = f.deferred("absorb");
    const resolving = resolveDeadlock(analysis, f.facade); await gate.ready; gate.release(); await resolving;
    const current = (await f.store.getTask(task.id))!;
    expect(current).toMatchObject({ status: "pending", executionRevision: 1, retries: 0, resolutionAttempts: 1, originalDescription: task.description, dependsOn: [second.id] });
    expect(current.description).toContain("Complete the dependency");
    await expect(f.store.claimTaskExecution(taskExecutionReference(task), "stale-scheduler")).rejects.toMatchObject({ code: "task_execution_conflict" });
    const claimed = await f.store.claimTaskExecution(taskExecutionReference(current), "fresh-scheduler");
    expect(claimed.task.description).toBe(current.description);
    expect(f.emit).toHaveBeenCalledWith("deadlock:resolved", expect.objectContaining({ action: "absorb" }));
  });

  it("keeps previously absorbed work when a second dependency is absorbed", async () => {
    const f = await fixture(), second = await f.create("Other work");
    await f.store.mutateTaskExecution(taskExecutionReference(second), { type: "cancel" });
    await f.store.updateTask(f.task.id, { dependsOn: [f.dependency.id, second.id] });
    for (const instruction of ["Do first absorbed work", "Do second absorbed work"]) {
      vi.mocked(queryText).mockResolvedValue({ text: JSON.stringify({ action: "absorb", reason: "fixture", absorbedDescription: instruction }) } as never);
      const task = (await f.store.getTask(f.task.id))!;
      await resolveDeadlock(analyzeBlockedTasks([task], await f.store.listTasks()), f.facade);
    }
    const current = (await f.store.getTask(f.task.id))!;
    expect(current.dependsOn).toEqual([]);
    expect(current.description).toContain("Do first absorbed work");
    expect(current.description).toContain("Do second absorbed work");
    expect(current.resolutionAttempts).toBe(2);
    expect(current.originalDescription).toBe(f.task.description);
  });

  it("carries accumulated dependency work through a downstream absorption", async () => {
    const f = await fixture(), ancestor = await f.create("Ancestor");
    await f.store.updateTask(ancestor.id, { description: `${"Detailed ancestor instructions. ".repeat(30)}Must retain this ancestor requirement` });
    await f.store.mutateTaskExecution(taskExecutionReference(ancestor), { type: "cancel" });
    await f.store.transition(f.dependency.id, "pending");
    let dependency = await f.store.updateTask(f.dependency.id, { dependsOn: [ancestor.id] });
    vi.mocked(queryText).mockResolvedValue({ text: JSON.stringify({ action: "absorb", reason: "fixture", absorbedDescription: "Additional ancestor work" }) } as never);
    await resolveDeadlock(analyzeBlockedTasks([dependency], await f.store.listTasks()), f.facade);
    dependency = (await f.store.getTask(dependency.id))!;
    const attempt = await f.store.claimTaskExecution(taskExecutionReference(dependency), "failed-after-absorb");
    await f.store.transition(attempt.task.id, "failed");
    await resolveDeadlock(await f.analyze(), f.facade);
    const lastPrompt = vi.mocked(queryText).mock.calls.at(-1)![0];
    expect(lastPrompt).toContain("Additional ancestor work");
    expect(lastPrompt).toContain("Must retain this ancestor requirement");
    const current = (await f.store.getTask(f.task.id))!;
    expect(current.dependsOn).toEqual([]);
    expect(current.description).toContain("Must retain this ancestor requirement");
  });

  it("retries a shared failed dependency once and notifies its captured Run owner", async () => {
    const f = await fixture(), second = await f.create("Another blocked task", [f.dependency.id]);
    const gate = f.deferred("retry"), analysis = analyzeBlockedTasks([f.task, second], await f.store.listTasks());
    const resolving = resolveDeadlock(analysis, f.facade); await gate.ready; gate.release(); await resolving;
    expect(await f.store.getTask(f.dependency.id)).toMatchObject({ status: "pending", retries: 1, executionRevision: 2 });
    expect(await f.runs.getRun("dependency-run")).toMatchObject({ status: "killed" });
    expect(f.cancelRun).toHaveBeenCalledExactlyOnceWith("dependency-run");
    expect(f.emit.mock.calls.filter(([event]) => event === "deadlock:resolved")).toHaveLength(1);
  });

  it("preserves committed retries and processes independent graphs after an owner notification fails", async () => {
    const f = await fixture(), dependency = await f.create("Independent dependency");
    const run = await f.store.claimTaskExecution(taskExecutionReference(dependency), "independent-run");
    await f.store.transition(dependency.id, "failed");
    const blocked = await f.create("Independent blocked task", [dependency.id]);
    f.cancelRun.mockRejectedValueOnce(new Error("private host failure"));
    vi.mocked(queryText).mockResolvedValue({ text: JSON.stringify({ action: "retry", reason: "fixture" }) } as never);
    await expect(resolveDeadlock(analyzeBlockedTasks([f.task, blocked], await f.store.listTasks()), f.facade)).resolves.toBeUndefined();
    for (const task of [f.dependency, dependency]) expect(await f.store.getTask(task.id)).toMatchObject({ status: "pending", retries: 1 });
    for (const task of [f.task, blocked]) expect(await f.store.getTask(task.id)).toMatchObject({ status: "pending", retries: 0 });
    expect(await f.runs.getRun(run.run.id)).toMatchObject({ status: "killed" });
    expect(f.emit.mock.calls.filter(([event]) => event === "deadlock:resolved")).toHaveLength(2);
  });

  it("rejects a missing-dependency decision if that dependency appears during memory loading", async () => {
    const f = await fixture();
    const task = await f.create("Missing dependency", ["appears-later"]);
    const analysis = analyzeBlockedTasks([task], await f.store.listTasks());
    f.facade.getMemory = async () => {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(root, "tasks", "appears-later.json"), JSON.stringify({ ...f.dependency, id: "appears-later", status: "done", activeRunId: undefined }));
      return "";
    };
    await resolveDeadlock(analysis, f.facade);
    expect(await f.store.getTask(task.id)).toEqual(task);
  });
});
