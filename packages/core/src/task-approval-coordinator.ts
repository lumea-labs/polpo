import { nanoid } from "nanoid";
import type { OrchestratorContext } from "./orchestrator-context.js";
import type { ApprovalGate, ApprovalRequest, Task } from "./types.js";
import type { RunRecord } from "./run-store.js";
import { isTaskExecutionStore, isTaskApprovalExecutionStore, taskExecutionReference, nextTaskExecutionRevision, TaskApprovalError,
  type TaskApprovalBinding, type TaskApprovalDecision, type TaskApprovalExecutionStore, type TaskExecutionState } from "./task-execution.js";

function conflict(): never { throw new TaskApprovalError("task_approval_conflict", "Task approval no longer matches this execution"); }
function key(input: unknown): string {
  const stable = (value: any): string => value === null || typeof value !== "object" ? JSON.stringify(value)
    : Array.isArray(value) ? `[${value.map(stable).join(",")}]`
      : `{${Object.keys(value).sort().map(name => `${JSON.stringify(name)}:${stable(value[name])}`).join(",")}}`;
  return stable(JSON.parse(JSON.stringify(input)));
}
/** Only lifecycle bookkeeping is excluded. Input, principal, outputs, policy,
 * retry count and every other Task field remain part of the authorization. */
function inputTask(task: Task): Omit<Task, "status" | "updatedAt" | "executionRevision" | "activeRunId" | "approvalState"> {
  const { status, updatedAt, executionRevision, activeRunId, approvalState, ...input } = task;
  return input;
}
function invocationKey(invocation: TaskApprovalBinding["invocation"]): string {
  return key({ ...invocation, task: inputTask(invocation.task) });
}
function withoutAuthority(task: Task): Task {
  const { approvalState, ...snapshot } = task;
  return structuredClone(snapshot);
}

/** Shared runtime policy. Hosts supply stores and notifications; they must not
 * implement another approval/retry/claim state machine in API routes. */
export class TaskApprovalCoordinator {
  constructor(private ctx: Pick<OrchestratorContext, "taskStore" | "hooks" | "config" | "emitter">) {}

  private executions(): TaskApprovalExecutionStore {
    if (!isTaskApprovalExecutionStore(this.ctx.taskStore)) {
      throw new TaskApprovalError("task_approval_unsupported", "Task approval requires atomic Task, Run and Approval storage");
    }
    return this.ctx.taskStore;
  }

  private async batch(task: Task, allowChangedInput = false) {
    const authority = task.approvalState, ref = taskExecutionReference(task);
    if (!authority || authority.revision !== ref.revision || authority.runId !== ref.runId) conflict();
    const expectedStatus = { waiting: "awaiting_approval", ready: "pending", claimed: "in_progress" }[authority.phase];
    if (task.status !== expectedStatus) conflict();
    const store = this.executions().getTaskApprovalStore();
    const requests = (await store.listByTask(task.id)).filter(request => request.taskExecution?.batchId === authority.batchId);
    const binding = requests[0]?.taskExecution;
    if (!binding || binding.version !== 1 || binding.batchId !== authority.batchId
      || binding.requestIds.length !== requests.length || binding.gates.length !== requests.length
      || new Set(binding.requestIds).size !== requests.length
      || (!allowChangedInput && key(inputTask(binding.source)) !== key(inputTask(task)))) conflict();
    const ordered = binding.requestIds.map((id, index) => {
      const request = requests.find(value => value.id === id);
      if (!request || request.gateId !== binding.gates[index]?.id || key(request.taskExecution) !== key(binding)) conflict();
      return request;
    });
    return { binding, requests: ordered };
  }

  private accepted(request: ApprovalRequest): boolean {
    return request.status === "approved" || (request.status === "timeout"
      && request.taskExecution?.gates.find(gate => gate.id === request.gateId)?.timeoutAction === "approve");
  }

  /** A CAS conflict on another gate is retryable. Only a freshly checked
   * obsolete batch or a resolved target may permanently stop its timer. */
  async isPending(request: ApprovalRequest): Promise<boolean> {
    if (!request.taskId || !request.taskExecution) return false;
    const task = await this.ctx.taskStore.getTask(request.taskId);
    if (!task || task.approvalState?.phase !== "waiting") return false;
    try {
      const batch = await this.batch(task);
      return batch.binding.batchId === request.taskExecution.batchId
        && batch.requests.some(value => value.id === request.id && value.status === "pending");
    } catch (error) {
      if (error instanceof TaskApprovalError && error.code === "task_approval_conflict") return false;
      throw error;
    }
  }

  /** Called after ordinary before-hooks, with a separate captured durable Task.
   * All matching human gates are suspended in one transaction. */
  async check(hook: TaskApprovalBinding["hook"], task: Task, invocation: TaskApprovalBinding["invocation"], gates: ApprovalGate[]): Promise<{ allowed: boolean; created: ApprovalRequest[] }> {
    const policy = structuredClone(gates);
    if (policy.some(gate => gate.handler === "auto" && gate.condition?.expression)) return { allowed: false, created: [] };
    const human = policy.filter(gate => gate.handler === "human");
    if (!human.length) return { allowed: true, created: [] };
    if (new Set(human.map(gate => gate.id)).size !== human.length) {
      throw new TaskApprovalError("task_approval_invalid", "Approval gate IDs must be unique");
    }
    const store = this.executions();
    if (hook === "task:spawn" && task.approvalState?.phase === "claimed") {
      const batch = await this.batch(task);
      if (batch.binding.hook === hook && key(batch.binding.gates) === key(human)
        && invocationKey(batch.binding.invocation) === invocationKey(invocation) && batch.requests.every(request => this.accepted(request))) {
        // Also fence edits and revocations made during hook/preflight work.
        await store.commitTaskApprovalDecision({ expected: taskExecutionReference(task), tasks: [{ taskId: task.id, snapshot: task }],
          approvals: batch.requests.map(request => ({ id: request.id, expected: request })) });
        return { allowed: true, created: [] };
      }
    }
    const binding: TaskApprovalBinding = {
      version: 1, batchId: nanoid(), hook, requestIds: human.map(() => nanoid()), gates: human,
      source: withoutAuthority(task), invocation: structuredClone({ ...invocation, task: withoutAuthority(invocation.task) }),
    };
    const now = new Date().toISOString();
    const requests: ApprovalRequest[] = human.map((gate, index) => ({ id: binding.requestIds[index], gateId: gate.id,
      gateName: gate.name, taskId: task.id, missionId: task.missionId, status: "pending", requestedAt: now,
      payload: binding.invocation, taskExecution: binding }));
    await store.commitTaskApprovalDecision({ expected: taskExecutionReference(task), tasks: [{ taskId: task.id, snapshot: task }],
      approvals: requests.map(next => ({ id: next.id, expected: null, next })),
      operation: { type: "transition", status: "awaiting_approval" },
      approvalState: { batchId: binding.batchId, phase: "waiting", revision: nextTaskExecutionRevision(task) } });
    return { allowed: false, created: requests };
  }

  async claim(task: Task, runId: string): Promise<TaskExecutionState & { run: RunRecord }> {
    if (!task.approvalState && isTaskExecutionStore(this.ctx.taskStore)) return this.ctx.taskStore.claimTaskExecution(taskExecutionReference(task), runId);
    const store = this.executions();
    const batch = await this.batch(task, true);
    if (task.approvalState?.phase !== "ready" || batch.binding.hook !== "task:spawn" || !batch.requests.every(request => this.accepted(request))) conflict();
    const sameInput = key(inputTask(batch.binding.source)) === key(inputTask(task));
    return await store.commitTaskApprovalDecision({ expected: taskExecutionReference(task), tasks: [{ taskId: task.id, snapshot: task }],
      approvals: batch.requests.map(request => ({ id: request.id, expected: request })), operation: { type: "claim", runId },
      // An edited queued Task may make a fresh attempt, but carries no previous
      // consent into it. The runtime gate must review its new effective input.
      approvalState: sameInput ? { batchId: batch.binding.batchId, phase: "claimed", revision: nextTaskExecutionRevision(task), runId } : null,
    }) as TaskExecutionState & { run: RunRecord };
  }

  async canReject(request: ApprovalRequest): Promise<{ allowed: boolean; rejectionCount: number; maxRejections: number }> {
    if (!request.taskExecution || !request.taskId || request.status !== "pending") return { allowed: false, rejectionCount: 0, maxRejections: 0 };
    const task = await this.ctx.taskStore.getTask(request.taskId);
    if (!task || task.approvalState?.phase !== "waiting") return { allowed: false, rejectionCount: 0, maxRejections: 0 };
    try {
      const batch = await this.batch(task);
      if (batch.binding.batchId !== request.taskExecution.batchId) conflict();
      const max = batch.binding.gates.find(gate => gate.id === request.gateId)?.maxRevisions ?? 3;
      return { allowed: (task.revisionCount ?? 0) < max, rejectionCount: task.revisionCount ?? 0, maxRejections: max };
    } catch (error) {
      if (error instanceof TaskApprovalError && error.code === "task_approval_conflict") return { allowed: false, rejectionCount: 0, maxRejections: 0 };
      throw error;
    }
  }

  async resolve(request: ApprovalRequest, action: "approve" | "reject" | "timeout", resolvedBy?: string, note?: string): Promise<ApprovalRequest | null> {
    // Unbound old requests are retained for inspection, never allowed to mutate
    // a possibly newer Task. Operators can cancel/requeue it for fresh consent.
    if (!request.taskExecution || !request.taskId) conflict();
    const task = await this.ctx.taskStore.getTask(request.taskId);
    if (!task || task.approvalState?.phase !== "waiting") conflict();
    const batch = await this.batch(task);
    const current = batch.requests.find(value => value.id === request.id);
    if (!current || key(current) !== key(request)) conflict();
    if (current.status !== "pending") return null;
    const gate = batch.binding.gates.find(value => value.id === current.gateId)!;
    const rejecting = action === "reject" || (action === "timeout" && gate.timeoutAction !== "approve");
    const count = task.revisionCount ?? 0;
    if (action === "reject" && count >= (gate.maxRevisions ?? 3)) return null;
    const resolved: ApprovalRequest = { ...current, status: action === "timeout" ? "timeout" : action === "approve" ? "approved" : "rejected",
      resolvedAt: new Date().toISOString(), resolvedBy: action === "timeout" ? "timeout" : resolvedBy ?? "user", note };
    const changes = batch.requests.map(expected => ({ id: expected.id, expected,
      next: expected.id === current.id ? resolved : rejecting && expected.status === "pending"
        ? { ...expected, status: "rejected" as const, resolvedAt: resolved.resolvedAt, resolvedBy: resolved.resolvedBy, note: "Approval batch rejected" } : undefined }));
    const allApproved = changes.every(change => this.accepted(change.next ?? change.expected));
    const decision: TaskApprovalDecision = { expected: taskExecutionReference(task), tasks: [{ taskId: task.id, snapshot: task }], approvals: changes };
    if (rejecting) {
      decision.approvalState = null;
      decision.operation = action === "timeout" ? { type: "cancel", reason: "Approval timed out" }
        : { type: "requeue", countRetry: false, reason: "Approval rejected", updates: {
          revisionCount: count + 1, outcomes: [], result: undefined, phase: "execution",
          description: `${task.description}\n\n---\n**Rejection #${count + 1} feedback:** ${note ?? ""}`,
        } };
    } else if (allApproved && batch.binding.hook === "task:complete") {
      decision.approvalState = null;
      decision.operation = { type: "transition", status: "done", updates: { phase: undefined } };
    } else if (allApproved) {
      decision.operation = { type: "requeue", countRetry: false, reason: "All approval gates passed" };
      decision.approvalState = { batchId: batch.binding.batchId, phase: "ready", revision: nextTaskExecutionRevision(task) };
    }
    const result = await this.executions().commitTaskApprovalDecision(decision);
    this.ctx.emitter.emit("approval:resolved", { requestId: current.id, status: resolved.status, resolvedBy: resolved.resolvedBy });
    if (action === "reject") this.ctx.emitter.emit("approval:rejected", { requestId: current.id, taskId: task.id,
      feedback: note ?? "", rejectionCount: count + 1, resolvedBy: resolved.resolvedBy });
    if (action === "timeout") this.ctx.emitter.emit("approval:timeout", { requestId: current.id, action: rejecting ? "reject" : "approve" });
    if (result.task.status !== task.status) {
      this.ctx.emitter.emit("task:transition", { taskId: task.id, from: task.status, to: result.task.status, task: result.task });
      // Match Assessment's notification semantics. An after-hook may reload
      // or stop the host; awaiting it inside a drained resolution deadlocks.
      if (result.task.status === "done") void this.ctx.hooks.runAfter("task:complete", {
        taskId: task.id, task: result.task, result: result.task.result,
      }).catch(() => {});
    }
    return resolved;
  }
}
