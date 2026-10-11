import type { ApprovalRequest, Task, TaskStatus } from "./types.js";
import type { RunRecord } from "./run-store.js";
import { assertValidTransition } from "./state-machine.js";
import { normalizeRuntimeMetadata } from "./runtime-metadata.js";
import type { ApprovalStore } from "./approval-store.js";

/** Host-owned pointer to a durable, single-use approval batch. Never accepted
 * from authored Tasks, generic patches, or caller metadata. */
export interface TaskApprovalState {
  batchId: string;
  phase: "waiting" | "ready" | "claimed";
  revision: number;
  runId?: string;
}
export interface TaskApprovalBinding {
  version: 1;
  batchId: string;
  hook: "task:spawn" | "task:complete";
  requestIds: string[];
  gates: import("./types.js").ApprovalGate[];
  /** Durable input and the effective post-hook invocation are both bound. */
  source: Task;
  invocation: { task: Task; agent?: import("./types.js").AgentConfig; agentIdentity?: import("./agent-store.js").AgentIdentity; result?: import("./types.js").TaskResult; overrides?: TaskDispatchOverrides };
}

/** Non-secret execution preferences captured separately from durable Task
 * authority. A ready approval replays them on an ordinary scheduler claim. */
export interface TaskDispatchOverrides {
  model?: import("./types/config.js").ProfiledModelSelection;
  sandbox?: import("./runtime-sandbox.js").RuntimeSandboxOptions;
  routing?: import("./types.js").RuntimeRoutingOptions;
  loop?: string;
}

/** Host-owned identity of one task attempt. Revision zero represents old rows. */
export interface TaskExecutionReference {
  taskId: string;
  revision: number;
  runId?: string;
}
export type TaskExecutionPatch = Partial<Omit<Task, "id" | "status" | "executionRevision" | "activeRunId" | "retries" | "approvalState">>;
export type TaskExecutionMutation =
  | { type: "patch"; updates: TaskExecutionPatch }
  | { type: "transition"; status: TaskStatus; updates?: TaskExecutionPatch }
  | { type: "requeue"; countRetry: boolean; reason: string; onlyIfRunRunning?: boolean; updates?: TaskExecutionPatch }
  | { type: "cancel"; reason?: string };
export interface TaskExecutionState { task: Task; run?: RunRecord }
export interface TaskDispatchClaim extends TaskExecutionState {
  run: RunRecord;
  overrides?: TaskDispatchOverrides;
}

/** Task and Run changes in these operations form one durable transaction.
 * A stale reference rejects without chasing or modifying a newer attempt. */
export interface TaskExecutionStore {
  claimTaskExecution(expected: TaskExecutionReference, runId: string): Promise<TaskExecutionState & { run: RunRecord }>;
  mutateTaskExecution(expected: TaskExecutionReference, mutation: TaskExecutionMutation): Promise<TaskExecutionState>;
}
/** A captured row (or its absence) used to make an asynchronous decision.
 * Full snapshots also fence edits that do not advance the execution generation. */
export interface TaskExecutionPrecondition { taskId: string; snapshot: Task | null }
export interface ConditionalTaskExecutionStore extends TaskExecutionStore {
  mutateTaskExecutionConditionally(expected: TaskExecutionReference, mutation: TaskExecutionMutation,
    preconditions: readonly TaskExecutionPrecondition[]): Promise<TaskExecutionState>;
}
/** An approval read condition and optional replacement in the SAME transaction
 * as Task/Run state. null asserts absence; omitted next is a read condition only. */
export interface TaskApprovalChange {
  id: string;
  expected: ApprovalRequest | null;
  next?: ApprovalRequest;
}
export interface TaskApprovalDecision {
  expected: TaskExecutionReference;
  /** Must include the complete captured target Task, not only its generation. */
  tasks: TaskExecutionPrecondition[];
  approvals: TaskApprovalChange[];
  /** Omit for a partial gate decision which must leave the waiting Task intact. */
  operation?: TaskExecutionMutation | { type: "claim"; runId: string };
  /** Explicit authority change, separate from the public Task patch surface. */
  approvalState?: TaskApprovalState | null;
}
/** This is a persistence capability, not permission to approve arbitrary work.
 * The runtime must bind gate policy and one-use consent to the execution. */
export interface TaskApprovalExecutionStore extends ConditionalTaskExecutionStore {
  commitTaskApprovalDecision(decision: TaskApprovalDecision): Promise<TaskExecutionState>;
  /** The request adapter bound to the SAME durable project as this Task store. */
  getTaskApprovalStore(): ApprovalStore;
}
export function isTaskApprovalExecutionStore(value: unknown): value is TaskApprovalExecutionStore {
  return isConditionalTaskExecutionStore(value)
    && typeof (value as Partial<TaskApprovalExecutionStore>).commitTaskApprovalDecision === "function"
    && typeof (value as Partial<TaskApprovalExecutionStore>).getTaskApprovalStore === "function";
}
export class TaskApprovalError extends Error {
  constructor(readonly code: "task_approval_invalid" | "task_approval_conflict" | "task_approval_unsupported", message: string) {
    super(message); this.name = "TaskApprovalError";
  }
}
function invalidApproval(): never { throw new TaskApprovalError("task_approval_invalid", "Invalid Task approval decision"); }
function approvalSnapshotKey(value: unknown): string {
  const stable = (input: any): string => input === null || typeof input !== "object" ? JSON.stringify(input)
    : Array.isArray(input) ? `[${input.map(stable).join(",")}]`
      : `{${Object.keys(input).sort().map(key => `${JSON.stringify(key)}:${stable(input[key])}`).join(",")}}`;
  try { return stable(JSON.parse(JSON.stringify(value))); } catch { return invalidApproval(); }
}
function checkApproval(request: ApprovalRequest, id: string, taskId: string): void {
  if (!request || typeof request !== "object" || Array.isArray(request) || request.id !== id || request.taskId !== taskId
    || typeof request.gateId !== "string" || typeof request.gateName !== "string" || typeof request.requestedAt !== "string"
    || !["pending", "approved", "rejected", "timeout"].includes(request.status)
    || [request.missionId, request.resolvedAt, request.resolvedBy, request.note].some(value => value !== undefined && typeof value !== "string")) invalidApproval();
  const fields = new Set(["id", "gateId", "gateName", "taskId", "missionId", "status", "payload", "requestedAt", "resolvedAt", "resolvedBy", "note", "taskExecution"]);
  if (Object.keys(request).some(key => !fields.has(key))) invalidApproval();
  if (request.taskExecution !== undefined) {
    const binding = request.taskExecution;
    if (binding.version !== 1 || !validId(binding.batchId) || !["task:spawn", "task:complete"].includes(binding.hook)
      || !Array.isArray(binding.requestIds) || !binding.requestIds.includes(id) || binding.requestIds.some(id => !validId(id))
      || new Set(binding.requestIds).size !== binding.requestIds.length || !binding.requestIds.length || binding.requestIds.length > 1000
      || !Array.isArray(binding.gates) || binding.gates.length !== binding.requestIds.length
      || binding.gates[binding.requestIds.indexOf(id)]?.id !== request.gateId
      || binding.source?.id !== taskId || binding.invocation?.task?.id !== taskId) invalidApproval();
  }
  approvalSnapshotKey(request);
}
export function normalizeTaskApprovalDecision(raw: TaskApprovalDecision): TaskApprovalDecision {
  let input: TaskApprovalDecision;
  try { input = structuredClone(raw); } catch { return invalidApproval(); }
  if (!input || !Array.isArray(input.approvals) || input.approvals.length === 0 || input.approvals.length > 1000) invalidApproval();
  input.expected = normalizeTaskExecutionReference(input.expected);
  input.tasks = normalizeTaskExecutionPreconditions(input.tasks);
  const target = input.tasks.find(condition => condition.taskId === input.expected.taskId)?.snapshot;
  if (!target || JSON.stringify(taskExecutionReference(target)) !== JSON.stringify(input.expected)) invalidApproval();
  const seen = new Set<string>();
  for (const change of input.approvals) {
    if (!change || !validId(change.id) || seen.has(change.id)) invalidApproval();
    seen.add(change.id);
    if (change.expected !== null) checkApproval(change.expected, change.id, input.expected.taskId);
    if (change.next !== undefined) {
      checkApproval(change.next, change.id, input.expected.taskId);
      if (change.expected === null) {
        if (change.next.status !== "pending" || change.next.resolvedAt !== undefined || change.next.resolvedBy !== undefined) invalidApproval();
      } else {
        // Resolution cannot silently replace the captured gate, subject or input.
        const immutable = (request: ApprovalRequest) => {
          const { status, resolvedAt, resolvedBy, note, ...snapshot } = request;
          return snapshot;
        };
        if (approvalSnapshotKey(immutable(change.expected)) !== approvalSnapshotKey(immutable(change.next))) invalidApproval();
        if (change.expected.status !== "pending" && approvalSnapshotKey(change.expected) !== approvalSnapshotKey(change.next)) invalidApproval();
      }
    }
  }
  if (input.operation !== undefined) {
    if (input.operation?.type === "claim") normalizeTaskExecutionReference({ taskId: input.operation.runId, revision: 0 });
    else input.operation = normalizeTaskExecutionMutation(input.operation);
  }
  if (input.approvalState !== undefined && input.approvalState !== null) {
    const state = input.approvalState;
    if (!validId(state.batchId) || !["waiting", "ready", "claimed"].includes(state.phase)) invalidApproval();
    normalizeTaskExecutionReference({ taskId: input.expected.taskId, revision: state.revision, runId: state.runId });
    if (!input.operation || !input.approvals.every(change => (change.next ?? change.expected)?.taskExecution?.batchId === state.batchId)) invalidApproval();
  }
  return input;
}
/** Apply only inside the same Task/Run/Approval transaction. */
export function applyTaskApprovalState(state: TaskExecutionState, authority: TaskApprovalState | null | undefined): TaskExecutionState {
  if (authority === undefined) return state;
  if (authority !== null) {
    const ref = taskExecutionReference(state.task);
    if (authority.revision !== ref.revision || authority.runId !== ref.runId
      || (authority.phase === "waiting" && state.task.status !== "awaiting_approval")
      || (authority.phase === "ready" && state.task.status !== "pending")
      || (authority.phase === "claimed" && (state.task.status !== "in_progress" || !ref.runId))) invalidApproval();
  }
  return { ...state, task: { ...state.task, approvalState: authority ?? undefined } };
}
/** Call while all approval reads, including absence, are protected until commit. */
export function assertTaskApprovalPreconditions(changes: readonly TaskApprovalChange[], read: (id: string) => ApprovalRequest | undefined): void {
  for (const change of changes) {
    const current = read(change.id);
    if (change.expected === null ? current !== undefined
      : current === undefined || approvalSnapshotKey(current) !== approvalSnapshotKey(change.expected)) {
      throw new TaskApprovalError("task_approval_conflict", "Approval request changed");
    }
  }
}
export function isConditionalTaskExecutionStore(value: unknown): value is ConditionalTaskExecutionStore {
  return isTaskExecutionStore(value)
    && typeof (value as Partial<ConditionalTaskExecutionStore>).mutateTaskExecutionConditionally === "function";
}
/** Capture the decision's whole dependency graph before asynchronous work. */
export function taskDependencyPreconditions(task: Task, allTasks: readonly Task[]): TaskExecutionPrecondition[] {
  const tasks = new Map(allTasks.map(value => [value.id, value]));
  tasks.set(task.id, task);
  const conditions = new Map<string, TaskExecutionPrecondition>(), pending = [task.id];
  while (pending.length) {
    const id = pending.pop()!;
    if (conditions.has(id)) continue;
    const current = tasks.get(id);
    conditions.set(id, { taskId: id, snapshot: current ?? null });
    if (current) pending.push(...current.dependsOn);
  }
  return normalizeTaskExecutionPreconditions([...conditions.values()]);
}

export class TaskExecutionError extends Error {
  constructor(readonly code: "task_execution_invalid" | "task_execution_conflict" | "task_execution_unsupported", message: string) {
    super(message); this.name = "TaskExecutionError";
  }
}
export function isTaskExecutionStore(value: unknown): value is TaskExecutionStore {
  const store = value as Partial<TaskExecutionStore> | undefined;
  return !!store && typeof store.claimTaskExecution === "function" && typeof store.mutateTaskExecution === "function";
}
function invalid(): never { throw new TaskExecutionError("task_execution_invalid", "Invalid Task execution state"); }
function conflict(): never { throw new TaskExecutionError("task_execution_conflict", "Task execution changed"); }
const validId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(value);
export function normalizeTaskExecutionReference(expected: TaskExecutionReference): TaskExecutionReference {
  if (!expected || !validId(expected.taskId) || !Number.isSafeInteger(expected.revision)
    || expected.revision < 0 || expected.revision > 2_147_483_647
    || (expected.runId !== undefined && !validId(expected.runId))) invalid();
  return { taskId: expected.taskId, revision: expected.revision, ...(expected.runId === undefined ? {} : { runId: expected.runId }) };
}
export function taskExecutionReference(task: Task): TaskExecutionReference {
  return normalizeTaskExecutionReference({ taskId: task.id, revision: task.executionRevision ?? 0, runId: task.activeRunId });
}
export function nextTaskExecutionRevision(task: Task): number {
  const value = taskExecutionReference(task).revision + 1;
  if (value > 2_147_483_647) invalid();
  return value;
}
function assertCurrent(task: Task | undefined, expected: TaskExecutionReference): asserts task is Task {
  if (!task) conflict();
  const current = taskExecutionReference(task);
  if (current.taskId !== expected.taskId || current.revision !== expected.revision || current.runId !== expected.runId) conflict();
}
/** Copy before any I/O, retaining explicit undefined (optional-field clearing). */
export function normalizeTaskExecutionMutation(mutation: TaskExecutionMutation): TaskExecutionMutation {
  let copy: TaskExecutionMutation;
  try { copy = structuredClone(mutation); } catch { return invalid(); }
  if (!copy || !["patch", "transition", "requeue", "cancel"].includes(copy.type)) invalid();
  if (copy.type === "requeue" && (typeof copy.countRetry !== "boolean" || typeof copy.reason !== "string" || !copy.reason.trim())) invalid();
  if (copy.type === "requeue" && copy.onlyIfRunRunning !== undefined && typeof copy.onlyIfRunRunning !== "boolean") invalid();
  if ((copy.type === "cancel" || copy.type === "requeue") && copy.reason !== undefined
    && (typeof copy.reason !== "string" || copy.reason.length > 2000)) invalid();
  if (copy.type !== "cancel" && copy.updates !== undefined) {
    if (!copy.updates || typeof copy.updates !== "object" || Array.isArray(copy.updates)) invalid();
    for (const field of ["id", "status", "executionRevision", "activeRunId", "retries", "approvalState"]) {
      if (Object.hasOwn(copy.updates, field)) invalid();
    }
    // A required field cannot be removed. Optional counters have a shared zero
    // default, including in SQL where these columns are deliberately NOT NULL.
    // Normalize here so adapters return and persist the same logical state.
    for (const field of ["title", "description", "assignTo", "dependsOn", "expectations", "metrics", "maxRetries", "createdAt", "updatedAt"] as const) {
      if (Object.hasOwn(copy.updates, field) && copy.updates[field] == null) invalid();
    }
    for (const field of ["fixAttempts", "questionRounds", "resolutionAttempts"] as const) {
      if (Object.hasOwn(copy.updates, field) && copy.updates[field] === undefined) copy.updates[field] = 0;
      const value = copy.updates[field];
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647)) invalid();
    }
    if (copy.updates.metadata !== undefined) copy.updates.metadata = normalizeRuntimeMetadata(copy.updates.metadata);
  }
  if (copy.type === "patch" && copy.updates === undefined) invalid();
  return copy;
}

/** Copy and validate before any I/O; a legacy adapter cannot silently ignore these checks. */
export function normalizeTaskExecutionPreconditions(input: readonly TaskExecutionPrecondition[]): TaskExecutionPrecondition[] {
  let copied: TaskExecutionPrecondition[];
  try { copied = structuredClone(input) as TaskExecutionPrecondition[]; } catch { return invalid(); }
  if (!Array.isArray(copied) || !copied.length || copied.length > 10000) invalid();
  const seen = new Set<string>();
  for (const condition of copied) {
    if (!condition || !validId(condition.taskId) || seen.has(condition.taskId)) invalid();
    seen.add(condition.taskId);
    if (condition.snapshot !== null) {
      if (!condition.snapshot || condition.snapshot.id !== condition.taskId) invalid();
      taskExecutionReference(condition.snapshot);
      taskSnapshotKey(condition.snapshot);
    }
  }
  return copied;
}
function taskSnapshotKey(task: Task): string {
  // SQL supplies zero defaults and file rows may omit them. JSON object key
  // order is not semantic; optional undefined fields represent absence.
  const normalized = { ...task, executionRevision: task.executionRevision ?? 0,
    fixAttempts: task.fixAttempts ?? 0, questionRounds: task.questionRounds ?? 0, resolutionAttempts: task.resolutionAttempts ?? 0 };
  const stable = (value: any): string => value === null || typeof value !== "object" ? JSON.stringify(value)
    : Array.isArray(value) ? `[${value.map(stable).join(",")}]`
      : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  try { return stable(JSON.parse(JSON.stringify(normalized))); } catch { return invalid(); }
}
/** The adapter must keep the read rows/absence stable until its write commits. */
export function assertTaskExecutionPreconditions(conditions: readonly TaskExecutionPrecondition[], read: (id: string) => Task | undefined): void {
  for (const condition of conditions) {
    const current = read(condition.taskId);
    if (condition.snapshot === null) { if (current) conflict(); }
    else if (!current || taskSnapshotKey(current) !== taskSnapshotKey(condition.snapshot)) conflict();
  }
}

/** Called only while holding the Task/Run transaction. Initial Run state comes
 * from the persisted Task, never from a delayed caller's mutable configuration. */
export function prepareTaskExecutionClaim(task: Task | undefined, expected: TaskExecutionReference, runId: string, now: string): TaskExecutionState & { run: RunRecord } {
  assertCurrent(task, expected);
  if (task.status !== "pending" || task.activeRunId !== undefined) conflict();
  if (!validId(runId)) invalid();
  const claimed: Task = { ...task, executionRevision: nextTaskExecutionRevision(task), activeRunId: runId,
    status: "in_progress", phase: task.phase ?? "execution", updatedAt: now, approvalState: undefined };
  const run: RunRecord = { id: runId, taskId: task.id, taskExecutionRevision: claimed.executionRevision,
    agentName: task.assignTo, user: task.user, pid: 0, status: "running", startedAt: now, updatedAt: now,
    activity: { filesCreated: [], filesEdited: [], toolCalls: 0, totalTokens: 0, lastUpdate: now },
    configPath: `pending://${runId}`, engine: "agent", delivery: "background" };
  return { task: claimed, run };
}

/** Pure state calculation shared by SQL and file transaction adapters. */
export function prepareTaskExecutionMutation(task: Task | undefined, run: RunRecord | undefined,
  expected: TaskExecutionReference, mutation: TaskExecutionMutation, now: string): TaskExecutionState {
  assertCurrent(task, expected);
  if (task.activeRunId !== undefined && (!run || run.id !== task.activeRunId || run.taskId !== task.id
    || run.taskExecutionRevision !== task.executionRevision)) invalid();
  if (task.activeRunId === undefined && run !== undefined) invalid();
  const terminalTask = task.status === "done" || task.status === "failed";
  if (mutation.type === "cancel" && terminalTask && task.activeRunId === undefined && task.approvalState === undefined) return { task, run };
  const requeue = mutation.type === "requeue" || (mutation.type === "transition" && mutation.status === "pending");
  const awaitingApproval = mutation.type === "transition" && mutation.status === "awaiting_approval";
  if (mutation.type === "transition") assertValidTransition(task.status, mutation.status);
  if (mutation.type === "requeue") {
    // Recovery cannot discard a completion which won after its liveness read.
    if (mutation.onlyIfRunRunning && run?.status !== "running") conflict();
    // Escalation may replace work that is still queued. Publishing its new
    // input also advances the generation so a scheduler holding the previous
    // pending snapshot cannot claim it. Counted retries still require a run.
    if (task.status === "draft" || task.status === "done") conflict();
    if (mutation.countRetry && !["failed", "review", "in_progress", "assigned"].includes(task.status)) conflict();
  }
  const updated: Task = { ...task, ...(mutation.type === "cancel" ? {} : mutation.updates), updatedAt: now };
  if (mutation.type === "transition") updated.status = mutation.status;
  if (requeue || awaitingApproval || mutation.type === "cancel") {
    updated.executionRevision = nextTaskExecutionRevision(task);
    updated.activeRunId = undefined;
    updated.approvalState = undefined;
    if (requeue) {
      updated.status = "pending";
      const countRetry = mutation.type === "requeue" ? mutation.countRetry : task.status === "failed";
      updated.retries = task.retries + (countRetry ? 1 : 0);
    } else if (mutation.type === "cancel") {
      // The old Run remains history, but no longer owns the Task generation.
      if (!terminalTask) {
        updated.status = "failed";
        updated.result = { exitCode: 1, stdout: "", stderr: mutation.reason || "Task cancelled", duration: 0 };
        updated.phase = undefined;
      }
    }
    if (run?.status === "running") {
      run = { ...run, status: "killed", completedAt: now, updatedAt: now,
        result: { exitCode: 1, stdout: "", stderr: mutation.type === "cancel" ? mutation.reason || "Task cancelled" : awaitingApproval ? "Task awaiting approval" : "Task requeued",
          duration: Math.max(0, Date.parse(now) - Date.parse(run.startedAt)) } };
    }
  }
  return { task: updated, run };
}
