import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileTaskStore, FileRunStore, FileApprovalStore } from "@polpo-ai/file-stores";
import { TaskRunner } from "@polpo-ai/core/task-runner";
import { TaskManager } from "@polpo-ai/core/task-manager";
import { AssessmentOrchestrator } from "@polpo-ai/core/assessment-orchestrator";
import { EscalationManager } from "@polpo-ai/core/escalation-manager";
import { ApprovalManager } from "@polpo-ai/core/approval-manager";
import type { ApprovalStore } from "@polpo-ai/core/approval-store";
import { HookRegistry } from "@polpo-ai/core/hooks";
import type { OrchestratorContext } from "@polpo-ai/core/orchestrator-context";
import type { RunnerConfig } from "@polpo-ai/core/types";
import type { LoopResumeState } from "@polpo-ai/core/loop/run-store";
import { taskExecutionReference } from "@polpo-ai/core/task-execution";
import { claimTaskDispatch, authorizeTaskDispatch, fenceTaskDispatch } from "@polpo-ai/core/task-dispatch";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "polpo-task-attempt-runtime-")); roots.push(root);
  const taskStore = new FileTaskStore(root), runStore = new FileRunStore(root);
  const agentStore = { getAgent: vi.fn(async () => ({ name: "support", role: "Read Drive" })) };
  const spawner = { spawn: vi.fn(async (_config: RunnerConfig) => ({ pid: -1, configPath: "memory://run" })),
    kill: vi.fn(), cancelRun: vi.fn(), isAlive: () => false };
  const memoryStore = { get: vi.fn(async () => "") };
  const ctx = { taskStore, runStore, agentStore, spawner, memoryStore, emitter: { emit: vi.fn() }, hooks: new HookRegistry(),
    config: { settings: { maxRetries: 2, workDir: ".", logLevel: "quiet" }, teams: [] },
    workDir: root, agentWorkDir: root, polpoDir: root,
  } as unknown as OrchestratorContext;
  const task = await taskStore.createTask({ title: "Read", description: "Read the account", assignTo: "support", dependsOn: [],
    expectations: [], metrics: [], maxRetries: 2, user: "person-a", metadata: { connectionNamespace: "app-a" } });
  return { task, taskStore, runStore, agentStore, memoryStore, spawner, ctx, runner: new TaskRunner(ctx), manager: new TaskManager(ctx) };
}

describe("Task execution dispatch and cancellation", () => {
  it("fences an unacknowledged claim before its delayed transaction can commit", async () => {
    const f = await fixture(), release = deferred();
    const claim = f.taskStore.claimTaskExecution.bind(f.taskStore);
    const lateCommit = release.promise.then(() => claim(taskExecutionReference(f.task), "uncertain-run"));
    const rejected = expect(lateCommit).rejects.toMatchObject({ code: "task_execution_conflict" });
    vi.spyOn(f.taskStore, "claimTaskExecution").mockRejectedValueOnce(new Error("transport acknowledgement lost"));
    await expect(claimTaskDispatch(f.ctx, f.task, "uncertain-run")).rejects.toThrow("acknowledgement lost");
    await fenceTaskDispatch(f.ctx, f.task, "uncertain-run");
    release.resolve(); await rejected;
    expect(await f.runStore.getRun("uncertain-run")).toBeUndefined();
    expect(await f.taskStore.getTask(f.task.id)).toMatchObject({ status: "pending", retries: 0 });
  });

  it.each(["ours", "other", "completed"] as const)("fences a committed claim without damaging a %s owner/result", async owner => {
    const f = await fixture();
    const runId = owner === "other" ? "competing-run" : "uncertain-run";
    await claimTaskDispatch(f.ctx, f.task, runId);
    if (owner === "completed") await f.runStore.completeRun(runId, "completed", {
      exitCode: 0, stdout: "finished", stderr: "", duration: 1,
    });
    const before = await f.taskStore.getTask(f.task.id);
    await fenceTaskDispatch(f.ctx, f.task, "uncertain-run");
    if (owner === "ours") {
      expect(await f.runStore.getRun(runId)).toMatchObject({ status: "killed" });
      expect(await f.taskStore.getTask(f.task.id)).toMatchObject({ status: "pending", retries: 0 });
    } else {
      expect(await f.taskStore.getTask(f.task.id)).toEqual(before);
      expect(await f.runStore.getRun(runId)).toMatchObject({ status: owner === "completed" ? "completed" : "running" });
    }
  });

  it("shares one canonical claim with a direct host and returns durable principal authority", async () => {
    const f = await fixture();
    await f.taskStore.updateTask(f.task.id, { user: "current-principal" });
    const claims = await Promise.allSettled([
      claimTaskDispatch(f.ctx, f.task, "direct-one"),
      claimTaskDispatch(f.ctx, f.task, "direct-two"),
    ]);
    expect(claims.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const claimed = claims.find(result => result.status === "fulfilled")!;
    if (claimed.status !== "fulfilled") throw new Error("Expected successful claim");
    expect(claimed.value.task.user).toBe("current-principal");
    expect(claimed.value.task.activeRunId).toBe(claimed.value.run.id);
    expect(claimed.value.run.taskExecutionRevision).toBe(claimed.value.task.executionRevision);
  });

  it("rejects a direct host's unrelated Run before hook or provider preparation", async () => {
    const f = await fixture();
    const claimed = await claimTaskDispatch(f.ctx, f.task, "direct-one");
    const hook = vi.fn(), prepare = vi.fn();
    f.ctx.hooks.register({ hook: "task:spawn", phase: "before", handler: hook });
    await expect(authorizeTaskDispatch(f.ctx, {
      source: claimed.task, run: { ...claimed.run, id: "unrelated" },
      invocation: { task: claimed.task, agent: { name: "support" } }, prepare,
    })).rejects.toMatchObject({ code: "task_execution_conflict" });
    expect(hook).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it("denies direct admission cancelled during host preparation without altering the cancelled Task", async () => {
    const f = await fixture();
    const claimed = await claimTaskDispatch(f.ctx, f.task, "direct-one");
    let cancelled;
    const result = await authorizeTaskDispatch(f.ctx, {
      source: claimed.task, run: claimed.run,
      invocation: { task: claimed.task, agent: { name: "support" } },
      prepare: async invocation => {
        cancelled = await f.taskStore.mutateTaskExecution(taskExecutionReference(claimed.task), { type: "cancel" });
        return invocation;
      },
    });
    expect(result.allowed).toBe(false);
    expect(await f.taskStore.getTask(f.task.id)).toEqual(cancelled!.task);
    expect(await f.runStore.getRun(claimed.run.id)).toMatchObject({ status: "killed" });
  });

  it("cannot reintroduce a volume removed by the durable Task through a request override", async () => {
    const f = await fixture();
    f.ctx.config.settings.sandbox = { volumes: [{ name: "documents", access: "read-write" }] };
    const task = await f.taskStore.updateTask(f.task.id, { sandbox: { volumes: [] } });
    await f.runner.spawnForTask(task, { sandbox: { volumes: [{ name: "documents" }] } });
    expect(f.spawner.spawn).not.toHaveBeenCalled();
    const current = (await f.taskStore.getTask(f.task.id))!;
    expect(await f.runStore.getRun(current.activeRunId!)).toMatchObject({ status: "failed" });
  });

  it("does not requeue a completed owner when a before-hook concurrently vetoes dispatch", async () => {
    const f = await fixture();
    f.ctx.hooks.register({ hook: "task:spawn", phase: "before", handler: async context => {
      await f.runStore.completeRun(context.data.task.activeRunId!, "completed", { exitCode: 0, stdout: "finished", stderr: "", duration: 1 });
      context.cancel("veto after completion");
    } });
    await f.runner.spawnForTask(f.task);
    const current = (await f.taskStore.getTask(f.task.id))!;
    expect(current.status).toBe("in_progress");
    expect(await f.runStore.getRun(current.activeRunId!)).toMatchObject({ status: "completed", result: { stdout: "finished" } });
    expect(f.spawner.spawn).not.toHaveBeenCalled();
  });

  it("preserves admitted assignment and approval authority when a hook rewrites Task content", async () => {
    const f = await fixture();
    f.ctx.hooks.register({ hook: "task:spawn", phase: "before", handler: context => {
      context.data.task.assignTo = "other-agent";
      context.data.task.user = "other-user";
      context.data.task.approvalState = { batchId: "forged", phase: "claimed", revision: 1 };
      context.data.task.description = "Reviewed hook content";
    } });
    await f.runner.spawnForTask(f.task);
    const config = f.spawner.spawn.mock.calls[0][0];
    expect(config.task).toMatchObject({ assignTo: "support", user: "person-a", description: "Reviewed hook content" });
    expect(config.task.approvalState).toBeUndefined();
  });
  it.each(["cancelRun", "onExit"] as const)("keeps an owner recoverable when its spawner lacks %s for verified shutdown", async missing => {
    const f = await fixture();
    if (missing === "cancelRun") {
      delete (f.spawner as { cancelRun?: unknown }).cancelRun;
      f.spawner.spawn.mockImplementation(async () => ({ pid: 42, configPath: "local://unsupported", onExit: () => {} }));
    }
    await f.runner.spawnForTask(f.task);
    const task = (await f.taskStore.getTask(f.task.id))!;
    await expect(f.runner.close()).rejects.toThrow("owner-scoped cancelRun and an onExit receipt");
    expect(await f.runStore.getRun(task.activeRunId!)).toMatchObject({ status: "running" });
    expect(f.spawner.kill).not.toHaveBeenCalled();
    expect(await f.taskStore.getTask(f.task.id)).toEqual(task);
  });

  it("recovers the checkpoint committed after the orphan scan before recovery wins", async () => {
    const f = await fixture();
    await f.runner.spawnForTask(f.task);
    const task = (await f.taskStore.getTask(f.task.id))!;
    const now = new Date().toISOString();
    const first: LoopResumeState = { context: {}, steps: [], loopName: "default", turn: 1,
      history: [{ role: "user", content: "Read account" }], accumText: "first", createdAt: now, updatedAt: now };
    const latest = { ...first, turn: 2, accumText: "latest durable output" };
    await f.runStore.updateResumeState(task.activeRunId!, first);
    const active = f.runStore.getActiveRuns.bind(f.runStore);
    vi.spyOn(f.runStore, "getActiveRuns").mockImplementationOnce(async () => {
      const snapshot = await active();
      await f.runStore.updateResumeState(task.activeRunId!, latest);
      return snapshot;
    });
    expect(await f.runner.recoverOrphanedTasks()).toBe(1);
    await f.runner.spawnForTask((await f.taskStore.getTask(f.task.id))!);
    expect(f.spawner.spawn.mock.calls[1][0].resumeState).toEqual(latest);
  });

  it("fences a legacy result when a new attempt is claimed after its initial task read", async () => {
    const f = await fixture(), entered = deferred(), release = deferred();
    await f.taskStore.transition(f.task.id, "assigned");
    await f.taskStore.transition(f.task.id, "in_progress");
    const now = new Date().toISOString();
    await f.runStore.upsertRun({ id: "legacy-run", taskId: f.task.id, agentName: "support", pid: 0,
      status: "completed", startedAt: now, updatedAt: now, configPath: "legacy", sessionId: "obsolete-session",
      activity: { filesCreated: [], filesEdited: [], toolCalls: 0, totalTokens: 0, lastUpdate: now },
      result: { exitCode: 0, stdout: "Obsolete", stderr: "", duration: 1 } });
    const read = f.taskStore.getTask.bind(f.taskStore);
    vi.spyOn(f.taskStore, "getTask").mockImplementationOnce(async id => {
      const snapshot = await read(id); entered.resolve(); await release.promise; return snapshot;
    });
    const onResult = vi.fn(), collecting = f.runner.collectResults(onResult);
    try {
      await entered.promise;
      await f.manager.killTask(f.task.id);
      const pending = await f.taskStore.transition(f.task.id, "pending");
      const next = await f.taskStore.claimTaskExecution(taskExecutionReference(pending), "new-run");
      release.resolve(); await collecting;
      expect(onResult).not.toHaveBeenCalled();
      expect(await read(f.task.id)).toEqual(next.task);
      expect((await f.runStore.getRun("legacy-run"))?.collectedAt).toBeTruthy();
    } finally { release.resolve(); await collecting; }
  });

  it("ignores delayed escalation analysis after cancellation and a new claim", async () => {
    const f = await fixture(), entered = deferred(), release = deferred();
    f.ctx.config.settings.escalationPolicy = { levels: [
      { level: 2, handler: "orchestrator" }, { level: 3, handler: "human" },
    ] };
    f.ctx.queryLLM = async () => { entered.resolve(); await release.promise; return { text: "A reformulated description for the obsolete attempt" }; };
    const escalation = new EscalationManager(f.ctx); escalation.init();
    await f.taskStore.updateTask(f.task.id, { maxRetries: 0 });
    const first = await f.taskStore.claimTaskExecution(taskExecutionReference(f.task), "old-run");
    await f.runStore.completeRun(first.run.id, "failed", { exitCode: 1, stdout: "", stderr: "Failure", duration: 1 });
    const assessor = new AssessmentOrchestrator(f.ctx);
    const collecting = f.runner.collectResults((id, result, execution) => assessor.handleResult(id, result, execution));
    try {
      await entered.promise;
      await f.manager.killTask(f.task.id);
      const pending = await f.taskStore.transition(f.task.id, "pending");
      const next = await f.taskStore.claimTaskExecution(taskExecutionReference(pending), "new-run");
      release.resolve(); await collecting;
      expect(await f.taskStore.getTask(f.task.id)).toEqual(next.task);
      expect(await f.runStore.getRun(next.run.id)).toMatchObject({ status: "running" });
      expect(f.ctx.emitter.emit).not.toHaveBeenCalledWith("escalation:human", expect.anything());
      expect((await f.runStore.getRun(first.run.id))?.collectedAt).toBeTruthy();
    } finally { release.resolve(); await collecting; escalation.dispose(); }
  });

  it.each(["pending", "claimed", "superseded"] as const)("binds escalation timeout to its own published attempt (%s)", async state => {
    const f = await fixture(); vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    f.ctx.config.settings.escalationPolicy = { levels: [
      { level: 2, handler: "orchestrator", timeoutMs: 100 }, { level: 3, handler: "agent", target: "fallback", timeoutMs: 100 },
      { level: 4, handler: "human" },
    ] };
    f.ctx.queryLLM = async () => ({ text: "A reformulated description for this execution" });
    const escalation = new EscalationManager(f.ctx); escalation.init();
    try {
      const first = await f.taskStore.claimTaskExecution(taskExecutionReference(f.task), "old-run");
      await f.ctx.hooks.runBefore("task:fail", { taskId: f.task.id, task: first.task,
        reason: "maxRetries", result: { exitCode: 1, stdout: "", stderr: "Failure", duration: 1 } });
      const pending = (await f.taskStore.getTask(f.task.id))!;
      expect(pending).toMatchObject({ status: "pending", executionRevision: 2 });
      if (state !== "pending") await f.taskStore.claimTaskExecution(taskExecutionReference(pending), "escalation-run");
      let replacement;
      if (state === "superseded") {
        await f.manager.killTask(f.task.id);
        const retry = await f.taskStore.transition(f.task.id, "pending");
        replacement = await f.taskStore.claimTaskExecution(taskExecutionReference(retry), "unrelated-run");
      }
      await vi.advanceTimersByTimeAsync(100);
      if (replacement) {
        expect(await f.taskStore.getTask(f.task.id)).toEqual(replacement.task);
        expect(await f.runStore.getRun(replacement.run.id)).toMatchObject({ status: "running" });
      } else {
        const reassigned = (await f.taskStore.getTask(f.task.id))!;
        expect(reassigned).toMatchObject({ status: "pending", assignTo: "fallback", retries: 0 });
        expect(reassigned.executionRevision).toBeGreaterThan(pending.executionRevision!);
        await vi.advanceTimersByTimeAsync(100);
        expect(await f.taskStore.getTask(f.task.id)).toMatchObject({ status: "awaiting_approval", retries: 0 });
      }
    } finally { escalation.dispose(); }
  });

  it.each([false, true])("awaits real task-create approval persistence and stays blocked on failure (%s)", async fails => {
    const f = await fixture(), entered = deferred(), release = deferred();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const approvals = new ApprovalManager(f.ctx, { list: async () => [], upsert: async () => {
      entered.resolve(); await release.promise; if (fails) throw new Error("fixture approval unavailable");
    } } as unknown as ApprovalStore);
    f.ctx.config.settings.approvalGates = [{ id: "human", name: "Approve creation", hook: "task:create", handler: "human" }];
    await approvals.init();
    let settled = false;
    const creating = f.manager.createTask({ title: "New task", description: "Read", assignTo: "support" })
      .then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
    try {
      await entered.promise;
      expect(settled).toBe(false);
      expect(await f.taskStore.listTasks()).toHaveLength(1);
      release.resolve();
      expect(await creating).toMatchObject({ error: expect.objectContaining({ message: expect.stringContaining("blocked by hook") }) });
      expect(await f.taskStore.listTasks()).toHaveLength(1);
      expect(errorLog).toHaveBeenCalledTimes(fails ? 1 : 0);
    } finally { release.resolve(); await creating; approvals.dispose(); }
  });

  it("acknowledges a superseded result without attaching its session, outcomes or assessment to the retry", async () => {
    const f = await fixture();
    const first = await f.taskStore.claimTaskExecution(taskExecutionReference(f.task), "old-run");
    await f.runStore.upsertRun({ ...first.run, sessionId: "old-session", outcomes: [{ id: "old", type: "text", label: "Old", text: "obsolete", producedAt: new Date().toISOString() }] });
    await f.manager.killTask(f.task.id);
    const pending = await f.taskStore.transition(f.task.id, "pending");
    const second = await f.taskStore.claimTaskExecution(taskExecutionReference(pending), "new-run");
    const onResult = vi.fn();
    await f.runner.collectResults(onResult);
    expect(onResult).not.toHaveBeenCalled();
    expect(await f.taskStore.getTask(f.task.id)).toEqual(second.task);
    expect((await f.runStore.getRun(first.run.id))?.collectedAt).toBeTruthy();
  });

  it("fences assessment writes when cancellation and retry happen while the assessor awaits", async () => {
    const f = await fixture(), entered = deferred(), release = deferred();
    await f.taskStore.updateTask(f.task.id, { expectations: [{ type: "test", command: "true" }] });
    const first = await f.taskStore.claimTaskExecution(taskExecutionReference(f.task), "old-run");
    const result = { exitCode: 0, stdout: "Read complete", stderr: "", duration: 2 };
    await f.runStore.completeRun(first.run.id, "completed", result);
    const assessor = new AssessmentOrchestrator({ ...f.ctx, assessFn: async () => {
      entered.resolve(); await release.promise;
      return { passed: true, checks: [], metrics: [], timestamp: new Date().toISOString() };
    } });
    const collecting = f.runner.collectResults((id, output, execution) => assessor.handleResult(id, output, execution));
    try {
      await entered.promise;
      await f.manager.killTask(f.task.id);
      const pending = await f.taskStore.transition(f.task.id, "pending");
      const second = await f.taskStore.claimTaskExecution(taskExecutionReference(pending), "new-run");
      release.resolve(); await collecting;
      expect(await f.taskStore.getTask(f.task.id)).toEqual(second.task);
      expect(await f.runStore.getRun(second.run.id)).toMatchObject({ status: "running" });
      expect((await f.runStore.getRun(first.run.id))?.collectedAt).toBeTruthy();
    } finally { release.resolve(); await collecting; }
  });

  it("collects and completes a current attempt with its exact execution reference", async () => {
    const f = await fixture();
    const first = await f.taskStore.claimTaskExecution(taskExecutionReference(f.task), "current-run");
    const result = { exitCode: 0, stdout: "Read complete", stderr: "", duration: 2 };
    await f.runStore.completeRun(first.run.id, "completed", result);
    const assessor = new AssessmentOrchestrator(f.ctx);
    const received = vi.fn((id, output, execution) => assessor.handleResult(id, output, execution));
    await f.runner.collectResults(received);
    expect(received).toHaveBeenCalledWith(f.task.id, result, taskExecutionReference(first.task));
    expect(await f.taskStore.getTask(f.task.id)).toMatchObject({ status: "done", result });
    expect((await f.taskStore.getTask(f.task.id))?.phase).toBeUndefined();
  });

  it.each(["fix", "retry"] as const)("publishes the complete %s input before a competing scheduler can claim it", async mode => {
    const f = await fixture();
    f.ctx.config.settings.autoCorrectExpectations = false;
    await f.taskStore.updateTask(f.task.id, { expectations: [{ type: "test", command: "verify" }] });
    const first = await f.taskStore.claimTaskExecution(taskExecutionReference(f.task), "old-run");
    const result = { exitCode: mode === "fix" ? 0 : 1, stdout: "Read complete", stderr: "", duration: 2 };
    await f.runStore.completeRun(first.run.id, result.exitCode ? "failed" : "completed", result);
    const assessor = new AssessmentOrchestrator({ ...f.ctx, assessFn: async () => ({
      passed: false, checks: [{ type: "test", passed: false, message: "Missing required output" }], metrics: [], timestamp: new Date().toISOString(),
    }) });
    const mutate = f.taskStore.mutateTaskExecution.bind(f.taskStore);
    let next: Awaited<ReturnType<typeof f.taskStore.claimTaskExecution>> | undefined;
    vi.spyOn(f.taskStore, "mutateTaskExecution").mockImplementation(async (reference, mutation) => {
      const state = await mutate(reference, mutation);
      if (mutation.type === "requeue") next = await f.taskStore.claimTaskExecution(taskExecutionReference(state.task), "new-run");
      return state;
    });
    await f.runner.collectResults((id, output, execution) => assessor.handleResult(id, output, execution));
    expect(next?.task).toMatchObject({ phase: mode === "fix" ? "fix" : "execution", originalDescription: f.task.description,
      retries: mode === "fix" ? 0 : 1, fixAttempts: mode === "fix" ? 1 : 0, outcomes: [] });
    expect(next?.task.description).not.toBe(f.task.description);
    expect(await f.taskStore.getTask(f.task.id)).toEqual(next?.task);
  });

  it.each([false, true])("fences an asynchronous clarification answer (cancelled=%s)", async cancelled => {
    const f = await fixture(), entered = deferred(), release = deferred();
    const first = await f.taskStore.claimTaskExecution(taskExecutionReference(f.task), "old-run");
    await f.runStore.completeRun(first.run.id, "completed", { exitCode: 0, stdout: "Which account should I use?", stderr: "", duration: 1 });
    const assessor = new AssessmentOrchestrator({ ...f.ctx, queryLLM: async () => ({ text: "unused" }) }, {
      classifyAsQuestion: async () => ({ isQuestion: true, question: "Which account?" }),
      generateAnswer: async () => { entered.resolve(); await release.promise; return "Use the authorized account"; },
    });
    const collecting = f.runner.collectResults((id, output, execution) => assessor.handleResult(id, output, execution));
    try {
      await entered.promise;
      let next: Awaited<ReturnType<typeof f.taskStore.claimTaskExecution>> | undefined;
      if (cancelled) {
        await f.manager.killTask(f.task.id);
        const pending = await f.taskStore.transition(f.task.id, "pending");
        next = await f.taskStore.claimTaskExecution(taskExecutionReference(pending), "new-run");
      }
      release.resolve(); await collecting;
      const current = await f.taskStore.getTask(f.task.id);
      if (cancelled) expect(current).toEqual(next?.task);
      else {
        expect(current).toMatchObject({ status: "pending", executionRevision: 2, questionRounds: 1, retries: 0,
          originalDescription: f.task.description, description: expect.stringContaining("Use the authorized account") });
        expect(current?.activeRunId).toBeUndefined();
      }
    } finally { release.resolve(); await collecting; }
  });

  it("requires the captured execution reference when assessing a versioned Task", async () => {
    const f = await fixture();
    const first = await f.taskStore.claimTaskExecution(taskExecutionReference(f.task), "current-run");
    await expect(new AssessmentOrchestrator(f.ctx).handleResult(f.task.id, { exitCode: 0, stdout: "Unbound", stderr: "", duration: 1 }))
      .rejects.toMatchObject({ code: "task_execution_invalid" });
    expect(await f.taskStore.getTask(f.task.id)).toEqual(first.task);
  });

  it("does not finish a new attempt when a completion hook resumes after cancellation", async () => {
    const f = await fixture(), entered = deferred(), release = deferred();
    const first = await f.taskStore.claimTaskExecution(taskExecutionReference(f.task), "old-run");
    await f.runStore.completeRun(first.run.id, "completed", { exitCode: 0, stdout: "Complete", stderr: "", duration: 1 });
    f.ctx.hooks.register({ hook: "task:complete", phase: "before", handler: async () => { entered.resolve(); await release.promise; } });
    const assessor = new AssessmentOrchestrator(f.ctx);
    const collecting = f.runner.collectResults((id, output, execution) => assessor.handleResult(id, output, execution));
    try {
      await entered.promise; await f.manager.killTask(f.task.id);
      const pending = await f.taskStore.transition(f.task.id, "pending");
      const second = await f.taskStore.claimTaskExecution(taskExecutionReference(pending), "new-run");
      release.resolve(); await collecting;
      expect(await f.taskStore.getTask(f.task.id)).toEqual(second.task);
      expect(f.ctx.emitter.emit).not.toHaveBeenCalledWith("task:transition", expect.objectContaining({ to: "done" }));
    } finally { release.resolve(); await collecting; }
  });

  it("claims one durable attempt before asynchronous agent lookup", async () => {
    const f = await fixture();
    f.agentStore.getAgent.mockImplementationOnce(async () => {
      const task = (await f.taskStore.getTask(f.task.id))!;
      expect(task).toMatchObject({ status: "in_progress", executionRevision: 1 });
      expect(await f.runStore.getRun(task.activeRunId!)).toMatchObject({ taskId: task.id, taskExecutionRevision: 1, status: "running" });
      return { name: "support", role: "Read Drive" };
    });
    await f.runner.spawnForTask(f.task);
    expect(f.spawner.spawn).toHaveBeenCalledOnce();
    expect(f.spawner.spawn.mock.calls[0][0].task).toMatchObject({ executionRevision: 1, activeRunId: expect.any(String) });
  });

  it("allows competing schedulers to dispatch only one host execution", async () => {
    const f = await fixture();
    const results = await Promise.allSettled([f.runner.spawnForTask(f.task), new TaskRunner(f.ctx).spawnForTask(f.task)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "task_execution_conflict" } });
    expect(f.spawner.spawn).toHaveBeenCalledOnce();
    expect(await f.runStore.getActiveRuns()).toHaveLength(1);
  });

  it("does not dispatch a cancelled preparation or disturb its newer retry", async () => {
    const f = await fixture(), entered = deferred(), release = deferred();
    f.memoryStore.get.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return ""; });
    const preparing = f.runner.spawnForTask(f.task);
    try {
      await entered.promise;
      const old = (await f.taskStore.getTask(f.task.id))!;
      expect(await f.manager.killTask(f.task.id)).toBe(true);
      expect(await f.runStore.getRun(old.activeRunId!)).toMatchObject({ status: "killed" });
      expect(f.spawner.cancelRun).toHaveBeenCalledWith(old.activeRunId);
      const pending = await f.taskStore.transition(f.task.id, "pending");
      await new TaskRunner(f.ctx).spawnForTask(pending);
      const current = (await f.taskStore.getTask(f.task.id))!;
      release.resolve(); await preparing;
      expect(f.spawner.spawn).toHaveBeenCalledOnce();
      expect(await f.taskStore.getTask(f.task.id)).toEqual(current);
      expect(await f.runStore.getRun(current.activeRunId!)).toMatchObject({ status: "running" });
    } finally { release.resolve(); await preparing; }
  });

  it("rejects an old scheduler snapshot after cancellation before dispatch", async () => {
    const f = await fixture();
    await f.manager.killTask(f.task.id);
    await expect(f.runner.spawnForTask(f.task)).rejects.toMatchObject({ code: "task_execution_conflict" });
    expect(f.spawner.spawn).not.toHaveBeenCalled(); expect(f.agentStore.getAgent).not.toHaveBeenCalled();
  });

  it("notifies the exact host when acquisition finishes after cancellation", async () => {
    const f = await fixture(), entered = deferred(), release = deferred();
    f.spawner.spawn.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return { pid: -23, configPath: "memory://late" }; });
    const starting = f.runner.spawnForTask(f.task);
    try {
      await entered.promise;
      const task = (await f.taskStore.getTask(f.task.id))!;
      await f.manager.killTask(task.id);
      release.resolve(); await starting;
      expect(f.spawner.cancelRun.mock.calls).toEqual([[task.activeRunId], [task.activeRunId]]);
      expect(await f.runStore.getRun(task.activeRunId!)).toMatchObject({ status: "killed", pid: -23 });
      expect(await f.taskStore.getTask(task.id)).toMatchObject({ status: "failed" });
    } finally { release.resolve(); await starting; }
  });

  it.each(["killTask", "forceFailTask"] as const)("%s does not chase a new attempt when cancellation races a retry", async method => {
    const f = await fixture();
    const first = await f.taskStore.claimTaskExecution(taskExecutionReference(f.task), "first-run");
    const read = f.taskStore.getTask.bind(f.taskStore);
    vi.spyOn(f.taskStore, "getTask").mockImplementationOnce(async () => {
      await f.taskStore.mutateTaskExecution(taskExecutionReference(first.task), { type: "cancel" });
      const pending = await f.taskStore.transition(f.task.id, "pending");
      await f.taskStore.claimTaskExecution(taskExecutionReference(pending), "second-run");
      return first.task;
    });
    await expect(f.manager[method](f.task.id)).rejects.toMatchObject({ code: "task_execution_conflict" });
    expect(await read(f.task.id)).toMatchObject({ activeRunId: "second-run", status: "in_progress" });
    expect(await f.runStore.getRun("second-run")).toMatchObject({ status: "running" });
    expect(f.spawner.cancelRun).not.toHaveBeenCalled();
  });

  it.each(["in_progress", "done", "failed"] as const)("force-fail atomically invalidates the active Run on a %s Task", async status => {
    const f = await fixture();
    const first = await f.taskStore.claimTaskExecution(taskExecutionReference(f.task), "force-run");
    if (status !== "in_progress") await f.taskStore.unsafeSetStatus(f.task.id, status, "fixture terminal task with retained owner");
    await f.manager.forceFailTask(f.task.id);
    const task = (await f.taskStore.getTask(f.task.id))!;
    expect(task).toMatchObject({ status: status === "done" ? "done" : "failed", executionRevision: 2 });
    expect(task.activeRunId).toBeUndefined();
    expect(await f.runStore.getRun(first.run.id)).toMatchObject({ status: "killed", taskExecutionRevision: 1 });
    expect(f.spawner.cancelRun).toHaveBeenCalledExactlyOnceWith(first.run.id);
    expect(f.spawner.kill).not.toHaveBeenCalled();
  });

  it("does not let a supplied force-fail reference target another Task", async () => {
    const f = await fixture();
    const first = await f.taskStore.claimTaskExecution(taskExecutionReference(f.task), "owner-run");
    await expect(f.manager.forceFailTask("different-task", taskExecutionReference(first.task)))
      .rejects.toMatchObject({ code: "task_execution_invalid" });
    expect(await f.taskStore.getTask(f.task.id)).toEqual(first.task);
    expect(await f.runStore.getRun(first.run.id)).toEqual(first.run);
    expect(f.spawner.cancelRun).not.toHaveBeenCalled();
  });

  it("refuses forced status fallback for a versioned Task behind an unsupported store", async () => {
    const f = await fixture();
    const first = await f.taskStore.claimTaskExecution(taskExecutionReference(f.task), "owner-run");
    const transition = vi.fn(), unsafeSetStatus = vi.fn();
    const manager = new TaskManager({ ...f.ctx, taskStore: { getTask: f.taskStore.getTask.bind(f.taskStore), transition, unsafeSetStatus } } as never);
    await expect(manager.forceFailTask(f.task.id)).rejects.toMatchObject({ code: "task_execution_unsupported" });
    expect(await f.taskStore.getTask(f.task.id)).toEqual(first.task);
    expect(await f.runStore.getRun(first.run.id)).toEqual(first.run);
    expect(transition).not.toHaveBeenCalled(); expect(unsafeSetStatus).not.toHaveBeenCalled();
  });

  it("uses the principal and input of the persisted claim instead of a stale caller snapshot", async () => {
    const f = await fixture();
    await f.taskStore.updateTask(f.task.id, { description: "Updated input", user: "person-b", metadata: { connectionNamespace: "app-b" } });
    await f.runner.spawnForTask(f.task);
    const config = f.spawner.spawn.mock.calls[0][0];
    expect(config.task).toMatchObject({ description: "Updated input", user: "person-b", metadata: { connectionNamespace: "app-b" } });
    expect(await f.runStore.getRun(config.runId)).toMatchObject({ user: "person-b", taskExecutionRevision: 1 });
  });

  it("retains one inspectable failed Run when preflight fails after claiming", async () => {
    const f = await fixture(); f.agentStore.getAgent.mockResolvedValueOnce(undefined as never);
    await f.runner.spawnForTask(f.task);
    const current = (await f.taskStore.getTask(f.task.id))!;
    expect(await f.runStore.getRun(current.activeRunId!)).toMatchObject({ status: "failed", taskExecutionRevision: 1,
      result: { stderr: expect.stringContaining('No agent "support"') } });
    expect(f.spawner.spawn).not.toHaveBeenCalled();
  });

  it("keeps hook-vetoed work pending without burning a retry or changing execution identity", async () => {
    const f = await fixture();
    f.ctx.hooks.register({ hook: "task:spawn", phase: "before", handler: hook => {
      Object.assign(hook.data.task, { id: "forged", executionRevision: 99, activeRunId: "forged", user: "foreign" });
      hook.cancel("Awaiting operator");
    } });
    await f.runner.spawnForTask(f.task);
    expect(await f.taskStore.getTask(f.task.id)).toMatchObject({ status: "pending", retries: 0, executionRevision: 2, user: "person-a" });
    expect((await f.taskStore.getTask(f.task.id))?.activeRunId).toBeUndefined();
    expect(await f.runStore.getTerminalRuns()).toEqual([expect.objectContaining({ status: "killed", taskId: f.task.id, taskExecutionRevision: 1 })]);
    expect(f.spawner.spawn).not.toHaveBeenCalled();
  });

  it("preserves a real human approval gate after slow approval persistence", async () => {
    const f = await fixture(), entered = deferred(), release = deferred();
    const approvalStore = new FileApprovalStore(f.ctx.polpoDir);
    const commit = f.taskStore.commitTaskApprovalDecision.bind(f.taskStore);
    vi.spyOn(f.taskStore, "commitTaskApprovalDecision").mockImplementationOnce(async decision => {
      entered.resolve(); await release.promise; return commit(decision);
    });
    f.ctx.config.settings.approvalGates = [{ id: "human", name: "Approve access", hook: "task:spawn", handler: "human" }];
    const approvals = new ApprovalManager(f.ctx, approvalStore);
    await approvals.init();
    f.runner.setApprovalManager(approvals);
    const starting = f.runner.spawnForTask(f.task);
    try {
      await entered.promise; release.resolve(); await starting;
      const current = (await f.taskStore.getTask(f.task.id))!;
      expect(current).toMatchObject({ status: "awaiting_approval", retries: 0, executionRevision: 2 });
      expect(current.activeRunId).toBeUndefined();
      const competing = new TaskRunner(f.ctx); competing.setApprovalManager(approvals);
      await expect(competing.spawnForTask(current)).rejects.toMatchObject({ code: "task_approval_conflict" });
      expect(await approvalStore.list()).toHaveLength(1); expect(f.spawner.spawn).not.toHaveBeenCalled();
      expect(await f.runStore.getActiveRuns()).toHaveLength(0);
    } finally { release.resolve(); await starting; }
  });

  it("retries a timed approval after actual file corruption without acknowledging a resolution", async () => {
    const f = await fixture(); vi.useFakeTimers();
    const store = new FileApprovalStore(f.ctx.polpoDir);
    await store.upsert({ id: "approval", gateId: "human", gateName: "Review", status: "pending",
      payload: { mission: "Review" }, requestedAt: new Date().toISOString() });
    f.ctx.config.settings.approvalGates = [{ id: "human", name: "Review", hook: "mission:execute", handler: "human", timeoutMs: 10 }];
    const approvals = new ApprovalManager(f.ctx, store);
    const path = join(f.ctx.polpoDir, "approvals.json");
    const original = readFileSync(path, "utf8");
    try {
      await approvals.init();
      writeFileSync(path, "unreadable approval state");
      await vi.advanceTimersByTimeAsync(10);
      expect(readFileSync(path, "utf8")).toBe("unreadable approval state");
      expect(f.ctx.emitter.emit).not.toHaveBeenCalledWith("approval:timeout", expect.anything());
      expect(f.ctx.emitter.emit).toHaveBeenCalledWith("log", expect.objectContaining({ level: "error" }));
      expect(await f.taskStore.getTask(f.task.id)).toEqual(f.task);
      expect(f.spawner.spawn).not.toHaveBeenCalled();
      // Simulate repair while no store transaction is active. The retry must
      // read durable state again rather than retaining the failed snapshot.
      writeFileSync(path, original);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await store.get("approval")).toMatchObject({ status: "timeout", resolvedBy: "timeout" });
      expect(vi.getTimerCount()).toBe(0);
    } finally { approvals.dispose(); }
  });
});
