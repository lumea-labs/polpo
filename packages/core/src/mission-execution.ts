import type { AgentConfig, Mission, ScopedNotificationRules, Task } from "./types.js";
import { normalizeRuntimeMetadata, sameRuntimeMetadata } from "./runtime-metadata.js";

/** Immutable admission receipt. Task snapshots describe what was created;
 * callers read TaskStore separately for current execution status. */
export interface MissionExecutionReceipt {
  executionId: string;
  missionId: string;
  idempotencyKey: string;
  group: string;
  sequence: number;
  user?: string;
  metadata?: Record<string, string>;
  createdAt: string;
  tasks: Task[];
}

/** Every control/inspection surface must use the same accepted task identity. */
export function assertMissionExecutionTask(task: Task, receipt: MissionExecutionReceipt): void {
  const captured = receipt.tasks.find(candidate => candidate.id === task.id);
  if (!captured || task.missionId !== receipt.missionId || task.group !== receipt.group
    || task.missionExecutionId !== receipt.executionId || captured.missionExecutionId !== task.missionExecutionId
    || task.user !== receipt.user || !sameRuntimeMetadata(task.metadata, receipt.metadata)) {
    throw new MissionExecutionError("mission_execution_invalid", "Task does not match its accepted Mission execution");
  }
}

export interface MissionExecutionCommit {
  /** Mission used to plan and authorize all tasks, rechecked at admission. */
  expected: Mission;
  receipt: MissionExecutionReceipt;
  notifications?: ScopedNotificationRules;
  /** Agent definitions selected during planning, recovered only for this execution. */
  runtime?: { volatileAgents: AgentConfig[]; taskTitles?: Array<{ authored: string; accepted: string }> };
}

/** Capability separate from ordinary Mission CRUD. Implementations must commit
 * the receipt, all tasks, Mission activation and counter as one durable unit. */
export interface MissionExecutionStore {
  getMissionExecution(missionId: string, idempotencyKey: string): Promise<MissionExecutionReceipt | undefined>;
  getMissionExecutionById(executionId: string): Promise<MissionExecutionCommit | undefined>;
  commitMissionExecution(input: MissionExecutionCommit): Promise<{ receipt: MissionExecutionReceipt; created: boolean }>;
  /** Finalize only the current active execution, with all accepted tasks terminal. */
  finalizeMissionExecution(executionId: string, status: MissionExecutionFinalStatus): Promise<boolean>;
}
export type MissionExecutionFinalStatus = "completed" | "failed" | "scheduled" | "recurring";

export function validateMissionExecutionFinalStatus(status: MissionExecutionFinalStatus): void {
  if (!["completed", "failed", "scheduled", "recurring"].includes(status)) invalid();
}

export interface MissionExecutionOptions { idempotencyKey?: string }
export interface MissionExecutionResult { tasks: Task[]; group: string; executionId?: string }

export function isMissionExecutionStore(value: unknown): value is MissionExecutionStore {
  const store = value as Partial<MissionExecutionStore> | undefined;
  return !!store && typeof store.getMissionExecution === "function" && typeof store.getMissionExecutionById === "function"
    && typeof store.commitMissionExecution === "function" && typeof store.finalizeMissionExecution === "function";
}

export class MissionExecutionError extends Error {
  constructor(readonly code: "mission_execution_invalid" | "mission_execution_conflict" | "mission_execution_unsupported", message: string) {
    super(message);
    this.name = "MissionExecutionError";
  }
}
function invalid(): never { throw new MissionExecutionError("mission_execution_invalid", "Invalid Mission execution plan"); }
function conflict(): never { throw new MissionExecutionError("mission_execution_conflict", "Mission or task state changed before execution admission"); }

function json(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  // Array.from visits holes too: sparse arrays must not silently serialize as
  // null entries that would make a committed receipt impossible to replay.
  if (Array.isArray(value)) return Array.from(value, json);
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) Object.defineProperty(result, key, { value: json(item), enumerable: true });
    }
    return result;
  }
  return invalid();
}

export function validateMissionExecutionKey(missionId: string, key: string): void {
  if (typeof missionId !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(missionId)
    || typeof key !== "string" || !key.trim() || key !== key.trim() || key.length > 200 || /[\x00-\x1f\x7f]/.test(key)) invalid();
}

/** Capture a bounded JSON copy before awaiting storage. No caller can mutate
 * its principal, dependency graph or expected Mission while admission waits. */
export function normalizeMissionExecutionCommit(input: unknown): MissionExecutionCommit {
  let copied: MissionExecutionCommit;
  try { copied = json(input) as MissionExecutionCommit; } catch { return invalid(); }
  if (!copied || typeof copied !== "object" || Array.isArray(copied)) invalid();
  if (new TextEncoder().encode(JSON.stringify(copied)).length > 4 * 1024 * 1024) invalid();
  const { expected, receipt } = copied;
  if (!expected || !receipt) invalid();
  try {
    normalizeRuntimeMetadata(expected.metadata);
    if (!sameRuntimeMetadata(expected.metadata, receipt.metadata)
      || receipt.tasks?.some(task => !sameRuntimeMetadata(task?.metadata, receipt.metadata))) invalid();
  } catch { invalid(); }
  validateMissionExecutionKey(receipt.missionId, receipt.idempotencyKey);
  if (expected.id !== receipt.missionId || typeof expected.name !== "string" || !expected.name.trim()
    || typeof expected.data !== "string" || (expected.user !== undefined && (typeof expected.user !== "string" || !expected.user.trim()))
    || typeof receipt.executionId !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(receipt.executionId)
    || typeof receipt.createdAt !== "string" || !Number.isFinite(Date.parse(receipt.createdAt))
    || !Number.isSafeInteger(receipt.sequence) || receipt.sequence < 1
    || receipt.sequence !== (expected.executionCount ?? 0) + 1 || receipt.user !== expected.user
    || receipt.group !== (receipt.sequence > 1 ? `${expected.name} #${receipt.sequence}` : expected.name)
    || !Array.isArray(receipt.tasks) || !receipt.tasks.length || receipt.tasks.length > 1000) invalid();
  const ids = new Set<string>(), titles = new Set<string>();
  for (const task of receipt.tasks) {
    if (!task || typeof task.id !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(task.id) || ids.has(task.id)
      || typeof task.title !== "string" || !task.title.trim() || titles.has(task.title)
      || typeof task.description !== "string" || typeof task.assignTo !== "string" || !task.assignTo.trim()
      || task.missionId !== expected.id || task.group !== receipt.group || task.user !== receipt.user
      || (task.missionExecutionId !== undefined && task.missionExecutionId !== receipt.executionId)
      || task.status !== "pending" || task.retries !== 0 || !Number.isSafeInteger(task.maxRetries) || task.maxRetries < 0
      || task.createdAt !== receipt.createdAt || task.updatedAt !== receipt.createdAt || !Array.isArray(task.dependsOn)
      || task.dependsOn.some(id => !ids.has(id)) || !Array.isArray(task.expectations) || !Array.isArray(task.metrics)) invalid();
    ids.add(task.id); titles.add(task.title);
  }
  if (copied.runtime !== undefined) {
    const runtime = copied.runtime;
    if (!runtime || !Array.isArray(runtime.volatileAgents)) invalid();
    const names = new Set<string>();
    for (const agent of runtime.volatileAgents) {
      if (!agent || typeof agent.name !== "string" || !agent.name.trim() || names.has(agent.name)) invalid();
      names.add(agent.name);
    }
    if (runtime.taskTitles !== undefined) {
      if (!Array.isArray(runtime.taskTitles) || runtime.taskTitles.length !== receipt.tasks.length) invalid();
      const authored = new Set<string>(), accepted = new Set<string>();
      for (const entry of runtime.taskTitles) {
        if (!entry || typeof entry.authored !== "string" || !entry.authored.trim() || authored.has(entry.authored)
          || !titles.has(entry.accepted) || accepted.has(entry.accepted)) invalid();
        authored.add(entry.authored); accepted.add(entry.accepted);
      }
    }
  }
  return copied;
}

/** Called under the store's actual transaction/lock, after receipt lookup.
 * A committed duplicate returns its original receipt before these stale-plan
 * checks; changed Mission configuration never reauthorizes a replay. */
export function admitMissionExecution(input: MissionExecutionCommit, current: Mission | undefined, tasks: Task[]): Mission {
  const state = (mission: Mission) => JSON.stringify(json({ ...mission, executionCount: mission.executionCount ?? 0 }));
  if (!current || state(input.expected) !== state(current)
    || !["draft", "scheduled", "recurring", "failed", "cancelled"].includes(current.status)) conflict();
  const ids = new Set(input.receipt.tasks.map(task => task.id));
  const titles = new Set(input.receipt.tasks.map(task => task.title));
  if (tasks.some(task => ids.has(task.id) || (titles.has(task.title) && task.status !== "done" && task.status !== "failed"))) conflict();
  return { ...current, status: "active", executionCount: input.receipt.sequence, updatedAt: input.receipt.createdAt,
    ...(input.notifications === undefined ? {} : { notifications: input.notifications }) };
}
