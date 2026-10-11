import type { Task, TaskStatus } from "./types.js";
import type { RunRecord } from "./run-store.js";
import { assertValidTransition } from "./state-machine.js";
import { normalizeRuntimeMetadata } from "./runtime-metadata.js";

/** Host-owned identity of one task attempt. Revision zero represents old rows. */
export interface TaskExecutionReference {
  taskId: string;
  revision: number;
  runId?: string;
}
export type TaskExecutionPatch = Partial<Omit<Task, "id" | "status" | "executionRevision" | "activeRunId" | "retries">>;
export type TaskExecutionMutation =
  | { type: "patch"; updates: TaskExecutionPatch }
  | { type: "transition"; status: TaskStatus; updates?: TaskExecutionPatch }
  | { type: "requeue"; countRetry: boolean; reason: string; updates?: TaskExecutionPatch }
  | { type: "cancel"; reason?: string };
export interface TaskExecutionState { task: Task; run?: RunRecord }

/** Task and Run changes in these operations form one durable transaction.
 * A stale reference rejects without chasing or modifying a newer attempt. */
export interface TaskExecutionStore {
  claimTaskExecution(expected: TaskExecutionReference, runId: string): Promise<TaskExecutionState & { run: RunRecord }>;
  mutateTaskExecution(expected: TaskExecutionReference, mutation: TaskExecutionMutation): Promise<TaskExecutionState>;
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
  if ((copy.type === "cancel" || copy.type === "requeue") && copy.reason !== undefined
    && (typeof copy.reason !== "string" || copy.reason.length > 2000)) invalid();
  if (copy.type !== "cancel" && copy.updates !== undefined) {
    if (!copy.updates || typeof copy.updates !== "object" || Array.isArray(copy.updates)) invalid();
    for (const field of ["id", "status", "executionRevision", "activeRunId", "retries"]) {
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

/** Called only while holding the Task/Run transaction. Initial Run state comes
 * from the persisted Task, never from a delayed caller's mutable configuration. */
export function prepareTaskExecutionClaim(task: Task | undefined, expected: TaskExecutionReference, runId: string, now: string): TaskExecutionState & { run: RunRecord } {
  assertCurrent(task, expected);
  if (task.status !== "pending" || task.activeRunId !== undefined) conflict();
  if (!validId(runId)) invalid();
  const claimed: Task = { ...task, executionRevision: nextTaskExecutionRevision(task), activeRunId: runId,
    status: "in_progress", phase: task.phase ?? "execution", updatedAt: now };
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
  if (mutation.type === "cancel" && terminalTask && task.activeRunId === undefined) return { task, run };
  const requeue = mutation.type === "requeue" || (mutation.type === "transition" && mutation.status === "pending");
  const awaitingApproval = mutation.type === "transition" && mutation.status === "awaiting_approval";
  if (mutation.type === "transition") assertValidTransition(task.status, mutation.status);
  if (mutation.type === "requeue") {
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
