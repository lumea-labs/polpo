import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle as sqliteDrizzle } from "drizzle-orm/better-sqlite3";
import { drizzle as pgDrizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { createSqliteStores, createPgStores, migrateSqliteSchema, migratePgSchema } from "@polpo-ai/drizzle";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileTaskStore, FileRunStore, FileApprovalStore, FileAgentStore, JsonTaskStore } from "@polpo-ai/file-stores";
import { ApprovalManager } from "@polpo-ai/core/approval-manager";
import { TaskRunner } from "@polpo-ai/core/task-runner";
import { AssessmentOrchestrator } from "@polpo-ai/core/assessment-orchestrator";
import { HookRegistry } from "@polpo-ai/core/hooks";
import { taskExecutionReference } from "@polpo-ai/core/task-execution";
import type { OrchestratorContext } from "@polpo-ai/core/orchestrator-context";
import type { ApprovalGate, RunnerConfig } from "@polpo-ai/core/types";
import { approvalRoutes } from "../../../server/src/routes/approvals.js";

const databaseUrl = process.env.AGENT_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
for (const kind of ["file", "sqlite", "pg"] as const) {
describe.skipIf(kind === "pg" && !databaseUrl)(`${kind} durable Task approval lifecycle`, () => {
const roots: string[] = [], managers: ApprovalManager[] = [], connections: Database.Database[] = [];
const namespace = `approval_lifecycle_${randomUUID().replaceAll("-", "")}`;
let admin: ReturnType<typeof postgres>, client: ReturnType<typeof postgres>;
beforeAll(async () => {
  if (kind !== "pg") return;
  admin = postgres(databaseUrl!, { max: 1, onnotice: () => undefined });
  client = postgres(databaseUrl!, { max: 3, connection: { search_path: namespace }, onnotice: () => undefined });
  await admin.unsafe(`CREATE SCHEMA "${namespace}"`); await migratePgSchema(pgDrizzle(client));
});
afterAll(async () => {
  if (kind !== "pg") return;
  await client.end(); await admin.unsafe(`DROP SCHEMA "${namespace}" CASCADE`); await admin.end();
});
afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.close()));
  vi.restoreAllMocks(); vi.useRealTimers();
  connections.splice(0).forEach(db => db.close());
  if (kind === "pg") { await client`DELETE FROM approvals`; await client`DELETE FROM tasks`; await client`DELETE FROM runs`; }
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});
async function fixture(hook = "task:spawn", count = 2) {
  const root = mkdtempSync(join(tmpdir(), "polpo-approval-lifecycle-")); roots.push(root);
  let taskStore: any, runStore: any, store: any;
  if (kind === "file") { taskStore = new FileTaskStore(root); runStore = new FileRunStore(root); store = new FileApprovalStore(root); }
  else {
    let stores;
    if (kind === "sqlite") {
      const sqlite = new Database(join(root, "project.db")); connections.push(sqlite);
      const db = sqliteDrizzle(sqlite); await migrateSqliteSchema(db); stores = createSqliteStores(db);
    } else stores = createPgStores(pgDrizzle(client));
    taskStore = stores.taskStore; runStore = stores.runStore; store = stores.approvalStore;
  }
  const agentStore = { getAgent: vi.fn(async () => ({ name: "support", role: "Read Drive" })) };
  const spawner = { spawn: vi.fn(async (_config: RunnerConfig) => ({ pid: -1, configPath: "memory://run" })),
    kill: vi.fn(), cancelRun: vi.fn(), isAlive: () => false };
  const gates: ApprovalGate[] = Array.from({ length: count }, (_, index) => ({ id: `gate-${index}`, name: `Review ${index}`, hook, handler: "human" }));
  const ctx = { taskStore, runStore, agentStore, spawner, memoryStore: { get: async () => "" },
    emitter: { emit: vi.fn() }, hooks: new HookRegistry(), config: { settings: { maxRetries: 2, approvalGates: gates }, teams: [] },
    workDir: root, agentWorkDir: root, polpoDir: root,
  } as unknown as OrchestratorContext;
  const manager = new ApprovalManager(ctx, store); managers.push(manager); await manager.init();
  const runner = new TaskRunner(ctx); runner.setApprovalManager(manager);
  const assessor = new AssessmentOrchestrator(ctx); assessor.setApprovalManager(manager);
  const task = await taskStore.createTask({ title: "Read", description: "Read the account", assignTo: "support", dependsOn: [],
    expectations: [], metrics: [], maxRetries: 2, user: "person-a", metadata: { connectionNamespace: "app-a" } });
  return { root, taskStore, runStore, store, spawner, agentStore, ctx, manager, runner, assessor, task };
}

  it("waits for all gates, resumes through one claim, and does not request the same consent again", async () => {
    const f = await fixture(); await f.runner.spawnForTask(f.task);
    const requests = await f.store.list("pending"); expect(requests).toHaveLength(2);
    const waiting = (await f.taskStore.getTask(f.task.id))!;
    expect(waiting.status).toBe("awaiting_approval"); expect(f.spawner.spawn).not.toHaveBeenCalled();
    await f.manager.approve(requests[0].id);
    expect(await f.taskStore.getTask(f.task.id)).toEqual(waiting);
    await f.manager.approve(requests[1].id);
    const ready = (await f.taskStore.getTask(f.task.id))!; expect(ready.status).toBe("pending");
    const claims = await Promise.allSettled([f.runner.spawnForTask(ready), f.runner.spawnForTask(ready)]);
    expect(claims.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(f.spawner.spawn).toHaveBeenCalledTimes(1); expect(await f.store.list()).toHaveLength(2);
  });

  it.each(["retry", "edit", "recreate"])("cannot approve a superseded Task after %s", async change => {
    const f = await fixture("task:spawn", 1); await f.runner.spawnForTask(f.task);
    const [request] = await f.store.list("pending"), waiting = (await f.taskStore.getTask(f.task.id))!;
    if (change === "retry") await f.taskStore.mutateTaskExecution(taskExecutionReference(waiting), { type: "requeue", countRetry: false, reason: "Changed work" });
    if (change === "edit") await f.taskStore.updateTask(f.task.id, { user: "person-b", description: "Different account" });
    if (change === "recreate") {
      await f.taskStore.deleteTask(f.task.id);
      const { approvalState: _authority, ...replacement } = waiting;
      await f.taskStore.setState({ tasks: [replacement] });
    }
    const before = await f.taskStore.getTask(f.task.id);
    await expect(f.manager.approve(request.id)).rejects.toMatchObject({ code: "task_approval_conflict" });
    expect(await f.taskStore.getTask(f.task.id)).toEqual(before);
    expect((await f.store.get(request.id))?.status).toBe("pending");
  });

  it("requires new consent when the agent or hook input changes after approval", async () => {
    const f = await fixture("task:spawn", 1); await f.runner.spawnForTask(f.task);
    const [request] = await f.store.list("pending"); await f.manager.approve(request.id);
    f.ctx.hooks.register({ hook: "task:spawn", phase: "before", priority: 9999,
      handler: ctx => { ctx.data.task.description = "Now modify the account"; } });
    await f.runner.spawnForTask((await f.taskStore.getTask(f.task.id))!);
    expect(f.spawner.spawn).not.toHaveBeenCalled(); expect(await f.store.list("pending")).toHaveLength(1);
  });

  it("serializes competing approve and reject decisions across the entire batch", async () => {
    const f = await fixture(); await f.runner.spawnForTask(f.task);
    const requests = await f.store.list("pending");
    await Promise.allSettled([f.manager.approve(requests[0].id), f.manager.reject(requests[1].id, "Revise")]);
    const current = (await f.taskStore.getTask(f.task.id))!;
    const remaining = await f.store.list("pending");
    if (current.status === "awaiting_approval") {
      expect(remaining).toHaveLength(1); await f.manager.reject(remaining[0].id, "Revise");
    }
    expect(await f.taskStore.getTask(f.task.id)).toMatchObject({ status: "pending", revisionCount: 1 });
    expect(await f.store.list("pending")).toHaveLength(0); expect(f.spawner.spawn).not.toHaveBeenCalled();
  });

  it("retries a timeout whose batch CAS loses to a sibling manual approval", async () => {
    const f = await fixture();
    if (kind !== "pg") vi.useFakeTimers();
    Object.assign(f.ctx.config.settings.approvalGates![1], { timeoutMs: kind === "pg" ? 500 : 10, timeoutAction: "approve" });
    await f.runner.spawnForTask(f.task);
    const requests = await f.store.list("pending"), first = requests.find((request: any) => request.gateId === "gate-0")!;
    const original = f.taskStore.commitTaskApprovalDecision.bind(f.taskStore);
    vi.spyOn(f.taskStore, "commitTaskApprovalDecision").mockImplementationOnce(async decision => {
      await f.manager.approve(first.id); return original(decision);
    });
    if (kind !== "pg") {
      await vi.advanceTimersByTimeAsync(10);
      expect(await f.store.list("pending")).toHaveLength(1);
      expect((await f.taskStore.getTask(f.task.id))?.status).toBe("awaiting_approval");
      await vi.advanceTimersByTimeAsync(1000);
    } else await vi.waitFor(async () => expect((await f.taskStore.getTask(f.task.id))?.status).toBe("pending"), { timeout: 4000 });
    expect(await f.store.list("pending")).toHaveLength(0);
    expect((await f.taskStore.getTask(f.task.id))?.status).toBe("pending");
    expect(f.spawner.spawn).not.toHaveBeenCalled();
  });

  it("does not accept approval authority through create or generic patches", async () => {
    const f = await fixture("task:spawn", 1), forged = { batchId: "forged", phase: "ready", revision: 0 };
    const another = await f.taskStore.createTask({ ...f.task, approvalState: forged });
    expect(another.approvalState).toBeUndefined();
    await f.taskStore.updateTask(f.task.id, { approvalState: forged });
    expect((await f.taskStore.getTask(f.task.id))?.approvalState).toBeUndefined();
    await expect(f.taskStore.mutateTaskExecution(taskExecutionReference(f.task), { type: "patch", updates: { approvalState: forged } }))
      .rejects.toMatchObject({ code: "task_execution_invalid" });
  });

  it("does not reuse consent on a subsequent retry", async () => {
    const f = await fixture("task:spawn", 1); await f.runner.spawnForTask(f.task);
    await f.manager.approve((await f.store.list("pending"))[0].id);
    await f.runner.spawnForTask((await f.taskStore.getTask(f.task.id))!);
    const current = (await f.taskStore.getTask(f.task.id))!;
    const pending = await f.taskStore.mutateTaskExecution(taskExecutionReference(current), { type: "requeue", countRetry: true, reason: "Retry" });
    await f.runner.spawnForTask(pending.task);
    expect(f.spawner.spawn).toHaveBeenCalledTimes(1); expect(await f.store.list("pending")).toHaveLength(1);
  });

  it("requests fresh consent when queued input changes after the final approval", async () => {
    const f = await fixture("task:spawn", 1); await f.runner.spawnForTask(f.task);
    await f.manager.approve((await f.store.list("pending"))[0].id);
    await f.taskStore.updateTask(f.task.id, { user: "person-b", description: "Read another account" });
    await f.runner.spawnForTask((await f.taskStore.getTask(f.task.id))!);
    const pending = await f.store.list("pending"); expect(pending).toHaveLength(1);
    expect(pending[0].payload.task).toMatchObject({ user: "person-b", description: "Read another account" });
    expect(f.spawner.spawn).not.toHaveBeenCalled();
  });

  it("requires new consent after deleting and recreating an agent with identical configuration", async () => {
    const f = await fixture("task:spawn", 1), agents = new FileAgentStore(f.root);
    const definition = { name: "support", role: "Read Drive", createdAt: "2026-10-11T00:00:00.000Z" };
    await agents.createAgent(definition, "default"); Object.assign(f.ctx, { agentStore: agents });
    await f.runner.spawnForTask(f.task); await f.manager.approve((await f.store.list("pending"))[0].id);
    await agents.deleteAgent("support"); await agents.createAgent(definition, "default");
    await f.runner.spawnForTask((await f.taskStore.getTask(f.task.id))!);
    expect(f.spawner.spawn).not.toHaveBeenCalled(); expect(await f.store.list("pending")).toHaveLength(1);
  });

  it("does not bypass gates through a legacy TaskStore without a coordinator", async () => {
    const f = await fixture("task:spawn", 1), legacy = new JsonTaskStore(f.root);
    const task = await legacy.createTask(f.task);
    Object.assign(f.ctx, { taskStore: legacy });
    await expect(new TaskRunner(f.ctx).spawnForTask(task)).rejects.toMatchObject({ code: "task_execution_unsupported" });
    expect(f.spawner.spawn).not.toHaveBeenCalled();
  });

  it("drains a suspended admission before handing its timeout to a replacement manager", async () => {
    const f = await fixture("task:spawn", 1);
    if (kind !== "pg") vi.useFakeTimers();
    Object.assign(f.ctx.config.settings.approvalGates![0], { timeoutMs: 1000, timeoutAction: "approve" });
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; }), blocked = new Promise<void>(resolve => { release = resolve; });
    const original = f.taskStore.commitTaskApprovalDecision.bind(f.taskStore);
    vi.spyOn(f.taskStore, "commitTaskApprovalDecision").mockImplementationOnce(async decision => { entered(); await blocked; return original(decision); });
    const spawning = f.runner.spawnForTask(f.task); await waiting;
    let closed = false; const closing = f.manager.close().then(() => { closed = true; });
    try {
      await Promise.resolve(); expect(closed).toBe(false); release(); await spawning; await closing;
      if (kind !== "pg") expect(vi.getTimerCount()).toBe(0);
      const next = new ApprovalManager(f.ctx, f.store); managers.push(next); await next.init();
      if (kind !== "pg") await vi.advanceTimersByTimeAsync(1000);
      else await vi.waitFor(async () => expect((await f.taskStore.getTask(f.task.id))?.status).toBe("pending"), { timeout: 3000 });
      expect(await f.store.list("pending")).toHaveLength(0);
      expect((await f.taskStore.getTask(f.task.id))?.status).toBe("pending");
    } finally { release(); await spawning; await closing; }
  });

  it("rejects the whole batch and atomically adds feedback, clears outcomes and requeues", async () => {
    const f = await fixture(); await f.taskStore.updateTask(f.task.id, { outcomes: [{ type: "text", label: "old", text: "old" }] as any });
    await f.runner.spawnForTask(f.task);
    const requests = await f.store.list("pending"); await f.manager.reject(requests[0].id, "Use the shared drive", "reviewer");
    expect(await f.taskStore.getTask(f.task.id)).toMatchObject({ status: "pending", revisionCount: 1, outcomes: [],
      description: expect.stringContaining("Use the shared drive") });
    expect(await f.store.list("pending")).toHaveLength(0);
    expect(await f.manager.approve(requests[1].id)).toBeNull();
  });

  it("resumes a persisted batch after restart, without duplicate hooks", async () => {
    const f = await fixture(); await f.runner.spawnForTask(f.task); f.manager.dispose();
    const next = new ApprovalManager(f.ctx, f.store); managers.push(next); await next.init(); await next.init();
    f.runner.setApprovalManager(next);
    for (const request of await f.store.list("pending")) await next.approve(request.id);
    await f.runner.spawnForTask((await f.taskStore.getTask(f.task.id))!);
    expect(f.spawner.spawn).toHaveBeenCalledTimes(1); expect(await f.store.list()).toHaveLength(2);
  });

  it("resolves through the public HTTP route on a cold host and reports stale consent as 409", async () => {
    const f = await fixture("task:spawn", 1); await f.runner.spawnForTask(f.task); f.manager.dispose();
    const cold = new ApprovalManager({ taskStore: f.taskStore, hooks: new HookRegistry(), config: f.ctx.config, emitter: f.ctx.emitter }, f.store);
    managers.push(cold); await cold.init();
    const app = approvalRoutes(() => ({ getAllApprovals: status => cold.getAll(status as any), getApprovalRequest: id => cold.getRequest(id),
      approveRequest: (id, by, note) => cold.approve(id, by, note), rejectRequest: (id, feedback, by) => cold.reject(id, feedback, by),
      canRejectRequest: id => cold.canReject(id) }));
    const [request] = await f.store.list("pending");
    const post = () => app.request(`/${request.id}/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    await f.taskStore.updateTask(f.task.id, { description: "Changed input" });
    const stale = await post(); expect(stale.status).toBe(409); expect(await stale.json()).toMatchObject({ code: "CONFLICT" });
    await f.taskStore.updateTask(f.task.id, { description: f.task.description });
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(409);
    expect(await f.taskStore.getTask(f.task.id)).toMatchObject({ status: "pending" });
    expect(f.spawner.spawn).not.toHaveBeenCalled();
  });

  it("runs independent spawn and completion approvals for the same Task", async () => {
    const f = await fixture("task:spawn", 1);
    f.ctx.config.settings.approvalGates!.push({ id: "finish", name: "Review output", hook: "task:complete", handler: "human" });
    await f.runner.spawnForTask(f.task); await f.manager.approve((await f.store.list("pending"))[0].id);
    await f.runner.spawnForTask((await f.taskStore.getTask(f.task.id))!);
    const task = (await f.taskStore.getTask(f.task.id))!, result = { exitCode: 0, stdout: "Result", stderr: "", duration: 1 };
    await f.runStore.completeRun(task.activeRunId!, "completed", result);
    await f.assessor.handleResult(task.id, result, taskExecutionReference(task));
    const [completion] = await f.store.list("pending"); expect(completion.gateId).toBe("finish");
    await f.manager.approve(completion.id);
    expect(await f.taskStore.getTask(task.id)).toMatchObject({ status: "done", result });
    expect(f.spawner.spawn).toHaveBeenCalledTimes(1);
  });

  it("shows and finalizes the persisted result even if a completion hook mutates its copy", async () => {
    const f = await fixture("task:complete", 1);
    const after = vi.fn(); f.ctx.hooks.register({ hook: "task:complete", phase: "after", handler: after });
    f.ctx.hooks.register({ hook: "task:complete", phase: "before", handler: ctx => {
      ctx.data.result!.stdout = "Unpersisted replacement";
      ctx.data.task.result!.stdout = "Another replacement"; ctx.data.task.user = "other-person";
    } });
    await f.runner.spawnForTask(f.task);
    const task = (await f.taskStore.getTask(f.task.id))!, result = { exitCode: 0, stdout: "Persisted output", stderr: "", duration: 1 };
    await f.runStore.completeRun(task.activeRunId!, "completed", result);
    await f.assessor.handleResult(task.id, result, taskExecutionReference(task));
    const [request] = await f.store.list("pending");
    expect(request.payload).toMatchObject({ result, task: { user: "person-a", result } });
    await f.manager.approve(request.id);
    expect(await f.taskStore.getTask(task.id)).toMatchObject({ status: "done", result, user: "person-a" });
    expect(after.mock.calls[0][0].data).toMatchObject({ result, task: { result, user: "person-a" } });
  });

  it("allows a completion after-hook to close the manager without awaiting itself", async () => {
    const f = await fixture("task:complete", 1);
    let finished!: () => void; const closed = new Promise<void>(resolve => { finished = resolve; });
    f.ctx.hooks.register({ hook: "task:complete", phase: "after", handler: async () => { await f.manager.close(); finished(); } });
    await f.runner.spawnForTask(f.task);
    const task = (await f.taskStore.getTask(f.task.id))!, result = { exitCode: 0, stdout: "Result", stderr: "", duration: 1 };
    await f.runStore.completeRun(task.activeRunId!, "completed", result);
    await f.assessor.handleResult(task.id, result, taskExecutionReference(task));
    await f.manager.approve((await f.store.list("pending"))[0].id); await closed;
    expect((await f.taskStore.getTask(task.id))?.status).toBe("done");
  });

  it.each([false, true])("completes the assessed result without another spawn (timeout=%s)", async timeout => {
    const f = await fixture("task:complete", 1);
    if (timeout) {
      if (kind !== "pg") vi.useFakeTimers();
      Object.assign(f.ctx.config.settings.approvalGates![0], { timeoutMs: kind === "pg" ? 500 : 10, timeoutAction: "approve" });
    }
    const after = vi.fn(); f.ctx.hooks.register({ hook: "task:complete", phase: "after", handler: after });
    await f.runner.spawnForTask(f.task);
    const running = (await f.taskStore.getTask(f.task.id))!;
    const result = { exitCode: 0, stdout: "Approved output", stderr: "", duration: 1 };
    await f.runStore.completeRun(running.activeRunId!, "completed", result);
    await f.assessor.handleResult(f.task.id, result, taskExecutionReference(running));
    expect(await f.taskStore.getTask(f.task.id)).toMatchObject({ status: "awaiting_approval", result });
    const [request] = await f.store.list("pending"); expect(request).toBeDefined();
    if (timeout) {
      if (kind !== "pg") await vi.advanceTimersByTimeAsync(10);
      else await vi.waitFor(async () => expect((await f.taskStore.getTask(f.task.id))?.status).toBe("done"), { timeout: 3000 });
    } else await f.manager.approve(request.id);
    expect(await f.taskStore.getTask(f.task.id)).toMatchObject({ status: "done", result });
    expect((await f.taskStore.getTask(f.task.id))?.phase).toBeUndefined();
    expect(f.spawner.spawn).toHaveBeenCalledTimes(1); expect(after).toHaveBeenCalledTimes(1);
  });
});

}
