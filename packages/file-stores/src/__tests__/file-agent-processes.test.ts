import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { FileAgentStore } from "../file-agent-store.js";
import { FileTaskStore } from "../file-task-store.js";
import { FileRunStore } from "../file-run-store.js";
import { FileApprovalStore } from "../file-approval-store.js";
import { randomUUID } from "node:crypto";
import { taskExecutionReference } from "@polpo-ai/core/task-execution";
import type { Mission, Task } from "@polpo-ai/core/types";

const directories: string[] = [];
const children = new Set<ChildProcessWithoutNullStreams>();
afterEach(async () => {
  for (const child of children) { const done = once(child, "close"); child.kill("SIGKILL"); await done; }
  children.clear();
  directories.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }));
});
async function fixture(legacy = false) {
  const root = mkdtempSync(join(tmpdir(), "polpo-file-process-"));
  directories.push(root);
  const dir = join(root, ".polpo");
  if (!legacy) mkdirSync(join(dir, "agents"), { recursive: true });
  const store = new FileAgentStore(dir);
  await store.createAgent({ name: "support", role: "before", systemPrompt: "Before" }, "default");
  const snapshot = (await store.getAgentSnapshot("support"))!;
  const mutation = { expected: snapshot.revision, mutationId: "process-mutation", patch: { set: { role: "after", systemPrompt: "After" } } };
  return { dir, store, mutation, snapshot };
}
async function worker(dir: string, mode: string, parameter = "") {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/file-store-process.mjs", import.meta.url)), dir, mode, parameter]);
  children.add(child);
  const messages: any[] = [];
  let output = "", errors = "";
  const waiting: Array<{ predicate: (message: any) => boolean; resolve: (value: any) => void; reject: (reason: Error) => void }> = [];
  child.stderr.on("data", data => { errors += data; });
  child.stdout.on("data", data => {
    output += data;
    while (output.includes("\n")) {
      const end = output.indexOf("\n");
      const message = JSON.parse(output.slice(0, end));
      output = output.slice(end + 1);
      messages.push(message);
      for (const waiter of [...waiting]) if (waiter.predicate(message)) { waiting.splice(waiting.indexOf(waiter), 1); waiter.resolve(message); }
    }
  });
  const closed = new Promise<void>(resolve => child.on("close", () => {
    children.delete(child);
    for (const waiter of waiting.splice(0)) waiter.reject(new Error(`Child exited before its checkpoint: ${errors}`));
    resolve();
  }));
  const next = (predicate: (message: any) => boolean): Promise<any> => {
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => waiting.push({ predicate, resolve, reject }));
  };
  await next(m => m.ready);
  return { child, next, closed, start: (input: unknown) => child.stdin.write(JSON.stringify(input)),
    kill: async () => { child.kill("SIGKILL"); await closed; } };
}

async function missionFixture() {
  const { dir } = await fixture();
  const store = new FileTaskStore(dir);
  const mission = await store.createMission({ name: "Process mission", data: '{"tasks":[]}', status: "recurring", user: "customer-a" });
  return { dir, store, mission };
}

describe("Approval requests across real file-store processes", () => {
  const approval = (id: string) => ({ id, gateId: "review", gateName: "Review", status: "pending" as const,
    taskId: "task-a", payload: { description: "Review this work" }, requestedAt: "2026-10-11T12:00:00.000Z" });

  it("keeps requests from two stores constructed before either process writes", async () => {
    const { dir } = await fixture();
    const [a, b] = await Promise.all([worker(dir, "approval"), worker(dir, "approval")]);
    a.start({ request: approval("a") });
    expect(await a.next(m => m.ok || m.error)).toMatchObject({ ok: true });
    b.start({ request: approval("b") });
    expect(await b.next(m => m.ok || m.error)).toMatchObject({ ok: true });
    await Promise.all([a.closed, b.closed]);
    expect(await new FileApprovalStore(dir).list()).toEqual([approval("a"), approval("b")]);
  });

  it("fails before writing when the OS-lock dependency is unavailable", async () => {
    const { dir } = await fixture(), store = new FileApprovalStore(dir);
    await store.upsert(approval("existing"));
    const writer = await worker(dir, "approval-unavailable");
    writer.start({ request: approval("new") });
    expect(await writer.next(m => m.ok || m.error)).toEqual({ error: "file_coordinator_unavailable" });
    await writer.closed;
    expect(await store.list()).toEqual([approval("existing")]);
  });

  it("serializes a delete while another process has read the approval file for an insertion", async () => {
    const { dir } = await fixture(), store = new FileApprovalStore(dir);
    await store.upsert(approval("existing"));
    const [writer, remover] = await Promise.all([worker(dir, "approval-pause"), worker(dir, "approval-contend")]);
    writer.start({ request: approval("new") });
    await writer.next(m => m.read);
    remover.start({ operation: "delete", id: "existing" });
    const blocked = await remover.next(m => m.contended || m.ok || m.error);
    writeFileSync(join(dir, "release-approval-pause-writer"), "release");
    expect(blocked).toEqual({ contended: true });
    const results = await Promise.all([writer.next(m => m.ok || m.error), remover.next(m => m.ok || m.error)]);
    await Promise.all([writer.closed, remover.closed]);
    expect(results.every(r => r.ok)).toBe(true);
    expect(await store.list()).toEqual([approval("new")]);
  });

  it.each(["upsert", "delete"])("recovers %s after SIGKILL at every durable checkpoint", async operation => {
    async function prepared() {
      const { dir } = await fixture(), store = new FileApprovalStore(dir);
      await store.upsert(approval("existing"));
      return { dir, store };
    }
    const input = { operation, id: "existing", request: approval("new") };
    const baseline = await prepared(), counter = await worker(baseline.dir, "approval-count");
    counter.start(input);
    const count = await counter.next(m => m.ok || m.error); await counter.closed;
    expect(count).toMatchObject({ ok: true }); expect(count.checkpoints).toBeGreaterThan(3);
    for (let index = 1; index <= count.checkpoints; index++) {
      const f = await prepared(), writer = await worker(f.dir, "approval-crash", String(index));
      writer.start(input); await writer.next(m => m.checkpoint); await writer.kill();
      const before = [approval("existing")];
      const after = operation === "delete" ? [] : [...before, approval("new")];
      const recovered = await f.store.list();
      expect([before, after]).toContainEqual(recovered);
      expect(await new FileApprovalStore(f.dir).list()).toEqual(recovered);
      if (operation === "delete") await f.store.delete("existing");
      else await f.store.upsert(approval("new"));
      expect(await f.store.list()).toEqual(after);
    }
  }, 30_000);
});

describe("Task execution across real file-store processes", () => {
  async function taskFixture(claimed: boolean) {
    const { dir } = await fixture();
    const tasks = new FileTaskStore(dir), runs = new FileRunStore(dir);
    let task = await tasks.createTask({ title: "Claim me", description: "Work", assignTo: "support", dependsOn: [], expectations: [], metrics: [], maxRetries: 1 });
    const runId = "claimed-run";
    if (claimed) task = (await tasks.claimTaskExecution(taskExecutionReference(task), runId)).task;
    const input = claimed ? { expected: taskExecutionReference(task), mutation: { type: "cancel" } }
      : { operation: "claim", expected: taskExecutionReference(task), runId };
    return { dir, tasks, runs, task, runId, input };
  }

  it("recovers Task, Run and approval together after SIGKILL at each durable checkpoint", async () => {
    const approvalRequest = (task: Task) => ({ id: "approval", taskId: task.id, gateId: "human", gateName: "Review",
      status: "pending" as const, payload: { task }, requestedAt: "2026-10-11T12:00:00.000Z" });
    const approvalDecision = (task: Task, expected: null, next: ReturnType<typeof approvalRequest>) => ({
      expected: taskExecutionReference(task), tasks: [{ taskId: task.id, snapshot: task }],
      approvals: [{ id: next.id, expected, next }], operation: { type: "transition", status: "awaiting_approval" },
    });
    const baseline = await taskFixture(true);
    const counter = await worker(baseline.dir, "task-approval-count");
    counter.start(approvalDecision(baseline.task, null, approvalRequest(baseline.task)));
    const count = await counter.next(m => m.ok || m.error); await counter.closed;
    expect(count).toMatchObject({ ok: true }); expect(count.checkpoints).toBeGreaterThan(8);
    for (let index = 1; index <= count.checkpoints; index++) {
      const f = await taskFixture(true), request = approvalRequest(f.task);
      const writer = await worker(f.dir, "task-approval-crash", String(index));
      writer.start(approvalDecision(f.task, null, request));
      await writer.next(m => m.checkpoint); await writer.kill();
      const task = (await f.tasks.getTask(f.task.id))!, run = (await f.runs.getRun(f.runId))!;
      const stored = await new FileApprovalStore(f.dir).get(request.id);
      if (task.status === "awaiting_approval") {
        expect(task).toMatchObject({ executionRevision: 2 }); expect(task.activeRunId).toBeUndefined();
        expect(run.status).toBe("killed"); expect(stored).toEqual(request);
      } else {
        expect(task).toEqual(f.task); expect(run.status).toBe("running"); expect(stored).toBeUndefined();
      }
    }
  }, 30_000);
  it("gives separate scheduler processes one claim and one Run", async () => {
    const f = await taskFixture(false);
    const [a, b] = await Promise.all([worker(f.dir, "task-execution"), worker(f.dir, "task-execution")]);
    a.start(f.input); b.start({ ...f.input, runId: "other-run" });
    const results = await Promise.all([a.next(m => m.ok || m.error), b.next(m => m.ok || m.error)]);
    await Promise.all([a.closed, b.closed]);
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(results.filter(r => r.error)).toEqual([{ error: "task_execution_conflict" }]);
    const current = (await f.tasks.getTask(f.task.id))!;
    expect(current).toMatchObject({ status: "in_progress", executionRevision: 1 });
    expect(await f.runs.getActiveRuns()).toEqual([expect.objectContaining({ id: current.activeRunId, taskExecutionRevision: 1 })]);
  });
  it.each([false, true])("recovers Task and Run as one unit after writer death (cancel=%s)", async cancelling => {
    const baseline = await taskFixture(cancelling), counter = await worker(baseline.dir, "task-execution-count");
    counter.start(baseline.input);
    const count = await counter.next(m => m.ok || m.error); await counter.closed;
    expect(count).toMatchObject({ ok: true }); expect(count.checkpoints).toBeGreaterThan(5);
    for (let index = 1; index <= count.checkpoints; index++) {
      const f = await taskFixture(cancelling), writer = await worker(f.dir, "task-execution-crash", String(index));
      writer.start(f.input); await writer.next(m => m.checkpoint); await writer.kill();
      const task = (await f.tasks.getTask(f.task.id))!, run = await f.runs.getRun(f.runId);
      if (!cancelling && task.status === "pending") {
        expect(run).toBeUndefined(); expect(task.executionRevision ?? 0).toBe(0);
      } else if (task.status === "in_progress") {
        expect(task).toMatchObject({ executionRevision: 1, activeRunId: f.runId });
        expect(run).toMatchObject({ status: "running", taskExecutionRevision: 1 });
      } else {
        expect(cancelling).toBe(true);
        expect(task).toMatchObject({ status: "failed", executionRevision: 2 });
        expect(task.activeRunId).toBeUndefined(); expect(run).toMatchObject({ status: "killed", taskExecutionRevision: 1 });
      }
    }
  }, 45_000);
});

describe("Run cancellation across real file-store processes", () => {
  async function runFixture() {
    const { dir } = await fixture();
    const store = new FileRunStore(dir);
    await store.upsertRun({ id: "run-1", taskId: "task", agentName: "support", pid: 1, status: "running",
      startedAt: "now", updatedAt: "now", configPath: "memory://run-1",
      activity: { filesCreated: [], filesEdited: [], toolCalls: 0, totalTokens: 0, lastUpdate: "now" } });
    return { dir, store };
  }

  it("refuses unlocked cancellation when the file coordinator is unavailable", async () => {
    const { dir, store } = await runFixture();
    const writer = await worker(dir, "run-unavailable");
    writer.start({ operation: "complete" });
    expect(await writer.next(message => message.ok || message.error)).toEqual({ error: "file_coordinator_unavailable" });
    await writer.closed;
    expect((await store.getRun("run-1"))?.status).toBe("running");
  });

  it("recovers cancellation after a writer dies at each durable file checkpoint", async () => {
    const baseline = await runFixture(), counter = await worker(baseline.dir, "run-count");
    counter.start({ operation: "complete" });
    const { checkpoints } = await counter.next(message => message.ok);
    await counter.closed;
    expect(checkpoints).toBeGreaterThan(3);
    for (let index = 1; index <= checkpoints; index++) {
      const { dir, store } = await runFixture();
      const writer = await worker(dir, "run-crash", String(index));
      writer.start({ operation: "complete" });
      await writer.next(message => message.checkpoint);
      await writer.kill();
      expect(["running", "killed"]).toContain((await store.getRun("run-1"))?.status);
      await store.completeRun("run-1", "killed", { exitCode: 143, stdout: "", stderr: "cancelled", duration: 1 });
      expect(await store.getRun("run-1")).toMatchObject({ status: "killed", result: { stderr: "cancelled" } });
    }
  }, 30_000);

  it.each(["activity", "trace", "spawn", "outcomes", "resume", "collected"])("preserves cancellation during a concurrent %s update", async operation => {
    const { dir, store } = await runFixture();
    const [writer, cancel] = await Promise.all([worker(dir, "run-pause"), worker(dir, "run-contend")]);
    writer.start({ operation });
    await writer.next(message => message.read);
    cancel.start({ operation: "complete" });
    // An unlocked writer completes cancellation here. A coordinated writer
    // instead proves SQLITE_BUSY while the other process holds its read.
    await cancel.next(message => message.contended || message.ok || message.error);
    writeFileSync(join(dir, "release-run-pause-writer"), "release");
    const results = await Promise.all([writer.next(message => message.ok || message.error), cancel.next(message => message.ok || message.error)]);
    await Promise.all([writer.closed, cancel.closed]);
    expect(results.every(result => result.ok)).toBe(true);
    const saved = await store.getRun("run-1");
    expect(saved).toMatchObject({ status: "killed", result: { stderr: "cancelled" } });
    if (operation === "activity") expect(saved?.activity.toolCalls).toBe(9);
    if (operation === "trace") expect(saved?.trace?.map(event => event.id)).toEqual(["trace"]);
    if (operation === "spawn") expect(saved?.pid).toBe(9999);
    if (operation === "outcomes") expect(saved?.outcomes).toEqual([]);
    if (operation === "resume") expect(saved?.resumeState?.turn).toBe(1);
    if (operation === "collected") expect(saved?.collectedAt).toBeTruthy();
  });
});
function missionPlan(mission: Mission, key = "occurrence") {
  const createdAt = new Date().toISOString(), id = randomUUID();
  const task = (taskId: string, title: string, dependsOn: string[]): Task => ({ id: taskId, title, description: title,
    assignTo: "support", user: mission.user, missionId: mission.id, group: mission.name, status: "pending", retries: 0,
    maxRetries: 0, dependsOn, expectations: [], metrics: [], createdAt, updatedAt: createdAt });
  return { expected: mission, receipt: { executionId: randomUUID(), missionId: mission.id, idempotencyKey: key,
    sequence: 1, group: mission.name, user: mission.user, createdAt, tasks: [task(id, "First", []), task(randomUUID(), "Second", [id])] } };
}

describe("Mission admission across real file-store processes", () => {
  it.each([false, true])("serializes concurrent Mission commits (duplicate=%s)", async duplicate => {
    const f = await missionFixture();
    const [a, b] = await Promise.all([worker(f.dir, "mission"), worker(f.dir, "mission")]);
    a.start(missionPlan(f.mission));
    b.start(missionPlan(f.mission, duplicate ? "occurrence" : "other-occurrence"));
    const results = await Promise.all([a.next(m => m.ok || m.error), b.next(m => m.ok || m.error)]);
    await Promise.all([a.closed, b.closed]);
    expect(results.filter(r => r.created)).toHaveLength(1);
    if (duplicate) {
      expect(results.every(r => r.ok)).toBe(true);
      expect(results[0].receipt).toEqual(results[1].receipt);
    } else expect(results.filter(r => r.error)).toEqual([{ error: "mission_execution_conflict" }]);
    expect(await f.store.listTasks()).toHaveLength(2);
    expect((await f.store.getMission(f.mission.id))?.executionCount).toBe(1);
  });

  it("recovers all task, Mission and receipt files after a process dies at each durable checkpoint", async () => {
    const baseline = await missionFixture(), counter = await worker(baseline.dir, "mission-count");
    counter.start(missionPlan(baseline.mission));
    const { checkpoints } = await counter.next(m => m.ok);
    await counter.closed;
    expect(checkpoints).toBeGreaterThan(10);
    for (let index = 1; index <= checkpoints; index++) {
      const f = await missionFixture(), input = missionPlan(f.mission);
      const crashed = await worker(f.dir, "mission-crash", String(index));
      crashed.start(input);
      await crashed.next(m => m.checkpoint);
      await crashed.kill();
      // Every ordinary reader participates in recovery; no pending half-plan
      // may become visible to a queue consumer after a crashed writer.
      const tasks = await f.store.listTasks();
      expect([0, 2]).toContain(tasks.length);
      const current = (await f.store.getMission(f.mission.id))!;
      expect(current.status).toBe(tasks.length ? "active" : "recurring");
      expect(current.executionCount ?? 0).toBe(tasks.length ? 1 : 0);
      const receipt = await f.store.getMissionExecution(f.mission.id, "occurrence");
      expect(receipt).toEqual(tasks.length ? input.receipt : undefined);
      expect((await f.store.commitMissionExecution(input)).receipt).toEqual(input.receipt);
      expect(await f.store.listTasks()).toHaveLength(2);
    }
  }, 45_000);
});

describe("real file-store processes", () => {
  it.each(["unavailable", "mission-unavailable"])("fails explicitly if the OS-lock dependency is unavailable (%s)", async mode => {
    const { dir } = await fixture();
    const child = await worker(dir, mode);
    child.start({});
    expect(await child.next(m => m.error)).toEqual({ error: "file_coordinator_unavailable" });
    await child.closed;
  });

  it("serializes a built CLI skill assignment with a built runtime update", async () => {
    const { dir, store } = await fixture();
    mkdirSync(join(dir, "skills/mail"), { recursive: true });
    writeFileSync(join(dir, "skills/mail/SKILL.md"), "---\nname: mail\ndescription: Mail\n---\nMail");
    const [cli, runtime] = await Promise.all([worker(dir, "skills"), worker(dir, "merge")]);
    cli.start(["mail"]); runtime.start({ role: "Runtime changed" });
    expect(await cli.next(m => m.ok || m.error)).toMatchObject({ ok: true });
    expect(await runtime.next(m => m.ok || m.error)).toMatchObject({ ok: true });
    await Promise.all([cli.closed, runtime.closed]);
    expect(await store.getAgent("support")).toMatchObject({ role: "Runtime changed", skills: ["mail"] });
  });
  it("gives two simultaneous CAS writers one winner, and preserves independent ordinary patches", async () => {
    const { dir, store, mutation } = await fixture();
    const [a, b] = await Promise.all([worker(dir, "cas"), worker(dir, "cas")]);
    a.start(mutation);
    b.start({ ...mutation, mutationId: "other", patch: { set: { role: "other" } } });
    const results = await Promise.all([a.next(m => m.ok || m.error), b.next(m => m.ok || m.error)]);
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(results.filter(r => r.error)).toEqual([{ error: "agent_revision_conflict" }]);
    await Promise.all([a.closed, b.closed]);
    const [c, d] = await Promise.all([worker(dir, "merge"), worker(dir, "merge")]);
    c.start({ role: "merged" }); d.start({ skills: ["mail"] });
    await Promise.all([c.closed, d.closed]);
    expect(await store.getAgent("support")).toMatchObject({ role: "merged", skills: ["mail"] });
  });

  it("keeps a live lock exclusive and recovers it immediately when its owner is killed", async () => {
    const { dir, mutation, store } = await fixture();
    const holder = await worker(dir, "hold");
    holder.start({}); await holder.next(m => m.locked);
    const contender = await worker(dir, "cas");
    let completed = false;
    const result = contender.next(m => m.ok || m.error).then(value => { completed = true; return value; });
    contender.start(mutation);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(completed).toBe(false);
    await holder.kill();
    expect(await result).toMatchObject({ ok: true });
    await contender.closed;
    expect((await store.getAgent("support"))?.role).toBe("after");
  });

  it("recovers configuration, prompt, identity and receipt after every filesystem checkpoint", async () => {
    const baseline = await fixture();
    const counter = await worker(baseline.dir, "count");
    counter.start(baseline.mutation);
    const { checkpoints } = await counter.next(m => m.ok);
    await counter.closed;
    expect(checkpoints).toBeGreaterThan(8);
    for (let index = 1; index <= checkpoints; index++) {
      const { dir, store, mutation, snapshot } = await fixture();
      const crashed = await worker(dir, "crash", String(index));
      crashed.start(mutation);
      await crashed.next(m => m.checkpoint);
      await crashed.kill();
      const current = (await store.getAgentSnapshot("support"))!;
      expect(current.revision.incarnation).toBe(snapshot.revision.incarnation);
      expect(["before", "after"]).toContain(current.agent.role);
      expect(current.agent.systemPrompt).toBe(current.agent.role === "before" ? "Before" : "After");
      const receipt = await store.compareAndSwapAgent("support", mutation);
      expect(receipt.snapshot.revision.version).toBe(snapshot.revision.version + 1);
      expect(receipt.snapshot.agent).toMatchObject({ role: "after", systemPrompt: "After" });
      expect(JSON.parse(readFileSync(join(dir, "agents/support/agent.json"), "utf8")).role).toBe("after");
    }
  }, 30_000);

  it("does not clobber a manual edit found in a committed recovery journal", async () => {
    const { dir, store, mutation } = await fixture();
    // Journal rename is the second checkpoint; after it the intent is visible.
    const crashed = await worker(dir, "crash", "3");
    crashed.start(mutation); await crashed.next(m => m.checkpoint); await crashed.kill();
    writeFileSync(join(dir, "agents/support/instructions.md"), "Manual");
    await expect(store.getAgentSnapshot("support")).rejects.toMatchObject({ code: "file_transaction_conflict" });
    expect(readFileSync(join(dir, "agents/support/instructions.md"), "utf8")).toBe("Manual");
  });

  it("recovers legacy-to-directory migration at every checkpoint without losing identity", async () => {
    const baseline = await fixture(true);
    const counter = await worker(baseline.dir, "migrate-count");
    counter.start({});
    const { checkpoints } = await counter.next(m => m.ok);
    await counter.closed;
    for (let index = 1; index <= checkpoints; index++) {
      const { dir, store, snapshot } = await fixture(true);
      const child = await worker(dir, "migrate-crash", String(index));
      child.start({});
      await child.next(m => m.checkpoint);
      await child.kill();
      const current = (await store.getAgentSnapshot("support"))!;
      expect(current.revision.incarnation).toBe(snapshot.revision.incarnation);
      expect(current.agent).toEqual(snapshot.agent);
    }
  }, 30_000);
});
