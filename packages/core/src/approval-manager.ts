import { nanoid } from "nanoid";
import type { OrchestratorContext } from "./orchestrator-context.js";
import type { ApprovalStore } from "./approval-store.js";
import type { ApprovalGate, ApprovalRequest, ApprovalStatus, Task } from "./types.js";
import { isTaskExecutionStore, taskExecutionReference, TaskApprovalError, type TaskApprovalBinding } from "./task-execution.js";
import { TaskApprovalCoordinator } from "./task-approval-coordinator.js";
import type { LifecycleHook } from "./hooks.js";
import { SafeExpressionEvaluator } from "./loop/expression.js";
/** Approval resolution can run on a cold host without creating a scheduler,
 * model client, runner, sandbox or any other execution subsystem. */
export type ApprovalContext = Pick<OrchestratorContext, "taskStore" | "hooks" | "config" | "emitter">;
/** Shared project-policy validation, including hosts loading JSON settings. */
export function normalizeApprovalGates(value: unknown): ApprovalGate[] {
  if (value === undefined) return [];
  const invalid = (): never => { throw new TaskApprovalError("task_approval_invalid", "Invalid approval gate configuration"); };
  if (!Array.isArray(value) || value.length > 1000) invalid();
  const ids = new Set<string>();
  for (const gate of value as ApprovalGate[]) {
    if (!gate || typeof gate !== "object" || typeof gate.id !== "string" || !gate.id.trim() || ids.has(gate.id)
      || typeof gate.name !== "string" || !gate.name.trim() || typeof gate.hook !== "string" || !gate.hook.trim()
      || !["human", "auto"].includes(gate.handler)
      || (gate.condition !== undefined && typeof gate.condition?.expression !== "string")
      || (gate.timeoutMs !== undefined && (!Number.isSafeInteger(gate.timeoutMs) || gate.timeoutMs < 0 || gate.timeoutMs > 2_147_483_647))
      || (gate.timeoutAction !== undefined && !["approve", "reject"].includes(gate.timeoutAction))
      || (gate.maxRevisions !== undefined && (!Number.isSafeInteger(gate.maxRevisions) || gate.maxRevisions < 0))
      || (gate.priority !== undefined && !Number.isFinite(gate.priority))) invalid();
    ids.add(gate.id);
  }
  return structuredClone(value as ApprovalGate[]);
}
/**
 * Manages approval gates — both automatic (condition-based) and human (blocking).
 *
 * Automatic gates evaluate a condition against the hook payload and either
 * allow or block the operation immediately.
 *
 * Human gates pause the operation (task enters "awaiting_approval"),
 * emit a notification event, and wait for external resolution (API call,
 * TUI action, or timeout).
 */
export class ApprovalManager {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private unregister: Array<() => void> = [];
  private initialized = false;
  private disposed = false;
  private inFlight = new Set<Promise<unknown>>();
  private taskApprovals: TaskApprovalCoordinator;
  private evaluator = new SafeExpressionEvaluator();

  constructor(
    private ctx: ApprovalContext,
    private store: ApprovalStore,
  ) { this.taskApprovals = new TaskApprovalCoordinator(ctx); }

  /** Initialize: register hooks for all configured approval gates. */
  init(): Promise<void> { return this.track(() => this.initCurrent()); }

  private async initCurrent(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    const gates = normalizeApprovalGates(this.ctx.config.settings.approvalGates);

    for (const gate of gates) {
      if (gate.hook !== "task:spawn" && gate.hook !== "task:complete") this.registerGate(gate);
    }

    // Resume any pending approval timeouts from previous session
    const pending = await this.store.list("pending");
    for (const req of pending) {
      const gate = req.taskExecution?.gates.find(g => g.id === req.gateId) ?? gates.find(g => g.id === req.gateId);
      if (gate?.timeoutMs && gate.timeoutMs > 0) {
        const elapsed = Date.now() - new Date(req.requestedAt).getTime();
        const remaining = gate.timeoutMs - elapsed;
        if (remaining <= 0) {
          await this.resolveTimeout(req, gate);
        } else {
          this.startTimer(req.id, remaining, gate);
        }
      }
    }
  }

  private ensureGateNotificationRules(_gate: ApprovalGate): void {
    // No-op: notification routing removed.
  }

  private registerGate(gate: ApprovalGate): void {
    const hook = gate.hook as LifecycleHook;

    this.ensureGateNotificationRules(gate);

    this.unregister.push(this.ctx.hooks.register({
      hook,
      phase: "before",
      priority: gate.priority ?? 50,
      name: `approval-gate:${gate.name}`,
      handler: async (ctx) => {
        if (gate.condition?.expression) {
          const matches = this.evaluateCondition(gate.condition.expression, ctx.data);
          if (!matches) return;
        }

        if (gate.handler === "auto") {
          if (gate.condition?.expression) {
            ctx.cancel(`Auto gate "${gate.name}" condition matched — blocking`);
          }
          return;
        }

        const request = this.createRequest(gate, ctx.data);
        ctx.cancel(`Awaiting human approval: ${gate.name} (request: ${request.id})`);

        const taskId = this.extractTaskId(ctx.data);
        const payloadTask = (ctx.data as { task?: Task }).task;
        const execution = payloadTask && payloadTask.id === taskId ? taskExecutionReference(payloadTask) : undefined;
        await this.store.upsert(request);
        if (taskId) {
          if (execution && isTaskExecutionStore(this.ctx.taskStore)) {
            await this.ctx.taskStore.mutateTaskExecution(execution, { type: "transition", status: "awaiting_approval" });
          } else {
            await this.ctx.taskStore.transition(taskId, "awaiting_approval");
          }
        }

        this.ctx.emitter.emit("approval:requested", {
          requestId: request.id,
          gateId: gate.id,
          gateName: gate.name,
          taskId: request.taskId,
          missionId: request.missionId,
        });

        if (gate.timeoutMs && gate.timeoutMs > 0) {
          this.startTimer(request.id, gate.timeoutMs, gate);
        }
      },
    }));
  }

  private createRequest(gate: ApprovalGate, payload: unknown): ApprovalRequest {
    const request: ApprovalRequest = {
      id: nanoid(),
      gateId: gate.id,
      gateName: gate.name,
      taskId: this.extractTaskId(payload),
      missionId: this.extractMissionId(payload),
      status: "pending",
      payload,
      requestedAt: new Date().toISOString(),
    };
    return request;
  }

  checkTask(hook: TaskApprovalBinding["hook"], task: Task, invocation: TaskApprovalBinding["invocation"]): Promise<boolean> {
    return this.track(() => this.checkTaskCurrent(hook, task, invocation));
  }
  private async checkTaskCurrent(hook: TaskApprovalBinding["hook"], task: Task, invocation: TaskApprovalBinding["invocation"]): Promise<boolean> {
    const payload = hook === "task:complete" ? { taskId: task.id, ...invocation } : invocation;
    const gates = normalizeApprovalGates(this.ctx.config.settings.approvalGates).filter(gate => gate.hook === hook
      && (!gate.condition?.expression || this.evaluateCondition(gate.condition.expression, payload)))
      .sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50));
    const result = await this.taskApprovals.check(hook, task, invocation, gates);
    for (const request of this.disposed ? [] : result.created) {
      this.ctx.emitter.emit("approval:requested", { requestId: request.id, gateId: request.gateId,
        gateName: request.gateName, taskId: request.taskId, missionId: request.missionId });
      const gate = request.taskExecution!.gates.find(gate => gate.id === request.gateId)!;
      if (gate.timeoutMs && gate.timeoutMs > 0) this.startTimer(request.id, gate.timeoutMs, gate);
    }
    return result.allowed;
  }

  claimTask(task: Task, runId: string) { return this.track(() => this.taskApprovals.claim(task, runId)); }

  approve(requestId: string, resolvedBy?: string, note?: string): Promise<ApprovalRequest | null> {
    return this.track(() => this.approveCurrent(requestId, resolvedBy, note));
  }
  private async approveCurrent(requestId: string, resolvedBy?: string, note?: string): Promise<ApprovalRequest | null> {
    const request = await this.store.get(requestId);
    if (!request || request.status !== "pending") return null;
    if (request.taskId) {
      const resolved = await this.taskApprovals.resolve(request, "approve", resolvedBy, note);
      if (resolved) this.clearTimer(requestId);
      return resolved;
    }
    const resolved: ApprovalRequest = { ...request, status: "approved", resolvedAt: new Date().toISOString(), resolvedBy: resolvedBy ?? "user", note };
    await this.store.upsert(resolved); this.clearTimer(requestId);
    this.ctx.emitter.emit("approval:resolved", { requestId, status: resolved.status, resolvedBy: resolved.resolvedBy });
    return resolved;
  }

  reject(requestId: string, feedback: string, resolvedBy?: string): Promise<ApprovalRequest | null> {
    return this.track(() => this.rejectCurrent(requestId, feedback, resolvedBy));
  }
  private async rejectCurrent(requestId: string, feedback: string, resolvedBy?: string): Promise<ApprovalRequest | null> {
    const request = await this.store.get(requestId);
    if (!request || request.status !== "pending" || !request.taskId) return null;
    const resolved = await this.taskApprovals.resolve(request, "reject", resolvedBy, feedback);
    if (resolved) for (const id of request.taskExecution?.requestIds ?? [requestId]) this.clearTimer(id);
    return resolved;
  }

  async canReject(requestId: string): Promise<{ allowed: boolean; rejectionCount: number; maxRejections: number }> {
    const request = await this.store.get(requestId);
    return request ? this.taskApprovals.canReject(request) : { allowed: false, rejectionCount: 0, maxRejections: 0 };
  }

  private resolveTimeout(request: ApprovalRequest, gate: ApprovalGate): Promise<void> {
    return this.track(() => this.resolveTimeoutCurrent(request, gate));
  }
  private async resolveTimeoutCurrent(request: ApprovalRequest, gate: ApprovalGate): Promise<void> {
    if (request.status !== "pending") return;
    if (request.taskId) {
      try { await this.taskApprovals.resolve(request, "timeout"); }
      catch (error) {
        // A sibling gate may have changed while this timer was committing.
        // Retry that conflict; only confirmed obsolete work loses its timer.
        if (!(error instanceof TaskApprovalError && error.code === "task_approval_conflict")
          || await this.taskApprovals.isPending(request)) throw error;
      }
      return;
    }
    const resolved: ApprovalRequest = { ...request, status: "timeout", resolvedAt: new Date().toISOString(), resolvedBy: "timeout" };
    await this.store.upsert(resolved);
    this.ctx.emitter.emit("approval:timeout", { requestId: request.id, action: gate.timeoutAction ?? "reject" });
  }

  async getPending(): Promise<ApprovalRequest[]> {
    return this.store.list("pending");
  }

  async getAll(status?: ApprovalStatus): Promise<ApprovalRequest[]> {
    return this.store.list(status);
  }

  async getRequest(id: string): Promise<ApprovalRequest | undefined> {
    return this.store.get(id);
  }

  // ─── Helpers ───────────────────────────────────────

  private startTimer(requestId: string, ms: number, gate: ApprovalGate, failures = 0): void {
    if (this.disposed) return;
    this.clearTimer(requestId);
    const timer = setTimeout(async () => {
      try {
        const request = await this.store.get(requestId);
        // A dispose or explicit resolution may have cleared this timer while
        // the durable read was in flight. It no longer owns timeout work.
        if (this.timers.get(requestId) !== timer) return;
        if (request?.status === "pending") await this.resolveTimeout(request, gate);
      } catch {
        if (this.timers.get(requestId) !== timer) return;
        // Storage errors can contain connection strings or private payloads.
        // Retry the durable read with backoff; never infer a successful
        // resolution from a failed write or its missing acknowledgement.
        try {
          this.ctx.emitter.emit("log", { level: "error", message: "Approval timeout could not be processed; retrying" });
        } catch { /* A logging listener must not create an unhandled rejection. */ }
        if (this.timers.get(requestId) === timer) {
          this.startTimer(requestId, Math.min(1_000 * 2 ** failures, 30_000), gate, Math.min(failures + 1, 5));
        }
      } finally {
        // Do not remove the replacement timer installed for a failed attempt.
        if (this.timers.get(requestId) === timer) this.timers.delete(requestId);
      }
    }, ms);
    this.timers.set(requestId, timer);
  }

  private clearTimer(requestId: string): void {
    const timer = this.timers.get(requestId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(requestId);
    }
  }

  private evaluateCondition(expression: string, data: unknown): boolean {
    // SAFE: no `new Function`/eval. Expressions can read `data`, `task`,
    // `mission` (the hook payload + its task/mission), combined with
    // comparisons/boolean logic only — nothing else.
    const d = this.isRecord(data) ? (data as Record<string, unknown>) : {};
    return this.evaluator.evaluate(expression, { data: d, task: d.task, mission: d.mission });
  }

  private isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null;
  }

  private extractTaskId(data: unknown): string | undefined {
    if (!this.isRecord(data)) return undefined;
    const d = data as Record<string, unknown>;
    if (typeof d.taskId === "string") return d.taskId;
    if (this.isRecord(d.task) && typeof (d.task as Record<string, unknown>).id === "string") {
      return (d.task as Record<string, unknown>).id as string;
    }
    return undefined;
  }

  private extractMissionId(data: unknown): string | undefined {
    if (!this.isRecord(data)) return undefined;
    const d = data as Record<string, unknown>;
    if (typeof d.missionId === "string") return d.missionId;
    if (this.isRecord(d.mission) && typeof (d.mission as Record<string, unknown>).id === "string") {
      return (d.mission as Record<string, unknown>).id as string;
    }
    return undefined;
  }

  private track<T>(operation: () => Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new TaskApprovalError("task_approval_unsupported", "Approval manager has been disposed"));
    const promise = operation();
    this.inFlight.add(promise);
    void promise.then(() => this.inFlight.delete(promise), () => this.inFlight.delete(promise));
    return promise;
  }

  /** Hosts must await this before replacing the manager or closing its stores.
   * The replacement's init then discovers every committed pending request. */
  async close(): Promise<void> {
    this.dispose();
    await Promise.allSettled([...this.inFlight]);
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.unregister.splice(0).forEach(unregister => unregister());
    this.initialized = false;
  }
}
