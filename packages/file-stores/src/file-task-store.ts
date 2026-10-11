import { normalizeTaskExecutionReference, normalizeTaskExecutionMutation, prepareTaskExecutionClaim, prepareTaskExecutionMutation,
  TaskExecutionError, taskExecutionReference, nextTaskExecutionRevision, type ConditionalTaskExecutionStore, type TaskExecutionPrecondition, normalizeTaskExecutionPreconditions, assertTaskExecutionPreconditions, type TaskExecutionReference, type TaskExecutionMutation, type TaskExecutionState } from "@polpo-ai/core/task-execution";
import { normalizeTaskApprovalDecision, assertTaskApprovalPreconditions, applyTaskApprovalState, type TaskApprovalDecision, type TaskApprovalExecutionStore } from "@polpo-ai/core/task-execution";
import type { RunRecord } from "@polpo-ai/core/run-store";
import { normalizeRuntimeMetadata } from "@polpo-ai/core";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import type { Task, TaskStatus, PolpoState, AgentProcess, Team, Mission } from "@polpo-ai/core/types";
import type { TaskStore } from "@polpo-ai/core/task-store";
import { assertValidTransition, VALID_TRANSITIONS } from "@polpo-ai/core/state-machine";
import { admitMissionExecution, normalizeMissionExecutionCommit, validateMissionExecutionKey, validateMissionExecutionFinalStatus, type MissionExecutionFinalStatus,
  MissionExecutionError, type MissionExecutionCommit, type MissionExecutionReceipt, type MissionExecutionStore } from "@polpo-ai/core/mission-store";
import { withProjectFileTransaction, type ProjectFileTransaction } from "./project-file-transaction.js";
import { FileApprovalStore, readFileApprovalRequests, writeFileApprovalRequests } from "./file-approval-store.js";

interface MetaState {
  project: string;
  teams: Team[];
  processes: AgentProcess[];
  startedAt?: string;
  completedAt?: string;
}

/** Legacy meta state with singular team — auto-migrated on read. */
interface MetaStateRaw {
  project?: string;
  team?: Team;
  teams?: Team[];
  processes: AgentProcess[];
  startedAt?: string;
  completedAt?: string;
}

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function readJson<T>(tx: ProjectFileTransaction, path: string, fallback: T): T {
  const raw = tx.read(path);
  return raw === null ? fallback : safeJsonParse(raw, fallback);
}

/**
 * Filesystem-based TaskStore.
 * Stores tasks, missions, and metadata as individual JSON files under .polpo/.
 *
 * Layout:
 *   .polpo/tasks/<taskId>.json
 *   .polpo/missions/<missionId>.json
 *   .polpo/_meta.json
 */
export class FileTaskStore implements TaskStore, MissionExecutionStore, ConditionalTaskExecutionStore, TaskApprovalExecutionStore {
  constructor(private readonly polpoDir: string) {
    mkdirSync(join(polpoDir, "tasks"), { recursive: true });
    mkdirSync(join(polpoDir, "missions"), { recursive: true });
  }

  private transaction<T>(work: (tx: ProjectFileTransaction) => T): T {
    return withProjectFileTransaction(this.polpoDir, work);
  }
  private entityPath(directory: string, id: string): string {
    if (typeof id !== "string" || !id || /[\\/\x00]/.test(id)) throw new Error("Invalid stored entity identifier");
    return `${directory}/${id}.json`;
  }
  private taskPath(id: string): string { return this.entityPath("tasks", id); }
  private missionPath(id: string): string { return this.entityPath("missions", id); }
  private executionPath(missionId: string, key: string): string {
    validateMissionExecutionKey(missionId, key);
    const digest = createHash("sha256").update(JSON.stringify([missionId, key])).digest("hex");
    return `.runtime/mission-executions/${digest}.json`;
  }
  private write(tx: ProjectFileTransaction, path: string, value: unknown): void {
    tx.write(path, JSON.stringify(value, null, 2));
  }
  private readMeta(tx: ProjectFileTransaction): MetaState {
    const raw = readJson<MetaStateRaw>(tx, "_meta.json", { teams: [{ name: "", agents: [] }], processes: [] });
    const teams = raw.teams?.length ? raw.teams : raw.team ? [raw.team] : [{ name: "", agents: [] }];
    return { project: raw.project ?? "", teams, processes: raw.processes, startedAt: raw.startedAt, completedAt: raw.completedAt };
  }
  private ids(tx: ProjectFileTransaction, directory: string): string[] {
    return tx.list(directory).filter(name => name.endsWith(".json") && !name.endsWith(".tmp")).map(name => name.slice(0, -5));
  }
  private readTask(tx: ProjectFileTransaction, id: string): Task | undefined {
    return readJson<Task | undefined>(tx, this.taskPath(id), undefined);
  }
  private tasks(tx: ProjectFileTransaction): Task[] {
    return this.ids(tx, "tasks").map(id => this.readTask(tx, id)).filter((t): t is Task => !!t)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  private admissionTasks(tx: ProjectFileTransaction): Task[] {
    return this.ids(tx, "tasks").map(id => {
      const raw = tx.read(this.taskPath(id));
      let task: Task | undefined;
      try { task = raw === null ? undefined : JSON.parse(raw); } catch { /* fail closed below */ }
      if (!task || task.id !== id || typeof task.title !== "string" || !task.title.trim()
        || !Object.hasOwn(VALID_TRANSITIONS, task.status)) {
        throw new MissionExecutionError("mission_execution_conflict", "Cannot admit a Mission while stored task state is invalid");
      }
      return task;
    });
  }
  private readMission(tx: ProjectFileTransaction, id: string): Mission | undefined {
    return readJson<Mission | undefined>(tx, this.missionPath(id), undefined);
  }
  private missions(tx: ProjectFileTransaction): Mission[] {
    return this.ids(tx, "missions").map(id => this.readMission(tx, id)).filter((m): m is Mission => !!m)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getState(): Promise<PolpoState> {
    return this.transaction(tx => ({ ...this.readMeta(tx), tasks: this.tasks(tx) }));
  }
  async setState(partial: Partial<PolpoState>): Promise<void> {
    this.transaction(tx => {
      const meta = this.readMeta(tx);
      for (const field of ["project", "teams", "startedAt", "completedAt", "processes"] as const) {
        if (partial[field] !== undefined) (meta as unknown as Record<string, unknown>)[field] = partial[field];
      }
      if (partial.tasks !== undefined) {
        for (const id of this.ids(tx, "tasks")) tx.write(this.taskPath(id), null);
        for (const task of partial.tasks) this.write(tx, this.taskPath(task.id), task);
      }
      this.write(tx, "_meta.json", meta);
    });
  }
  async createTask(input: Omit<Task, "id" | "status" | "retries" | "createdAt" | "updatedAt" | "executionRevision" | "activeRunId" | "approvalState"> & { status?: TaskStatus }): Promise<Task> {
    input = { ...input, metadata: normalizeRuntimeMetadata(input.metadata) };
    return this.transaction(tx => {
      const now = new Date().toISOString();
      const task: Task = { ...input, id: nanoid(), status: input.status ?? "pending", retries: 0, createdAt: now, updatedAt: now };
      delete task.executionRevision;
      delete task.activeRunId;
      delete task.approvalState;
      this.write(tx, this.taskPath(task.id), task);
      return task;
    });
  }
  async getTask(id: string): Promise<Task | undefined> { return this.transaction(tx => this.readTask(tx, id)); }
  async listTasks(): Promise<Task[]> { return this.transaction(tx => this.tasks(tx)); }
  async unsafeSetStatus(id: string, status: TaskStatus, reason: string): Promise<Task> {
    return this.transaction(tx => {
      const existing = this.readTask(tx, id);
      if (!existing) throw new Error(`Task not found: ${id}`);
      if (status === "pending" && existing.activeRunId) {
        return this.mutateExecution(tx, taskExecutionReference(existing), { type: "requeue", countRetry: false, reason }).task;
      }
      const updated = { ...existing, status, updatedAt: new Date().toISOString(),
        ...(status === "pending" ? { executionRevision: nextTaskExecutionRevision(existing), activeRunId: undefined, approvalState: undefined } : {}) };
      this.write(tx, this.taskPath(id), updated);
      console.warn(`[unsafeSetStatus] ${id}: ${existing.status} → ${status} — ${reason}`);
      return updated;
    });
  }
  async updateTask(id: string, updates: Partial<Omit<Task, "id" | "status" | "executionRevision" | "activeRunId" | "approvalState">>): Promise<Task> {
    if (updates.metadata !== undefined) updates = { ...updates, metadata: normalizeRuntimeMetadata(updates.metadata) };
    return this.transaction(tx => {
      const existing = this.readTask(tx, id);
      if (!existing) throw new Error(`Task not found: ${id}`);
      const updated = { ...existing, ...updates, id, status: existing.status,
        executionRevision: existing.executionRevision, activeRunId: existing.activeRunId, approvalState: existing.approvalState, updatedAt: new Date().toISOString() };
      this.write(tx, this.taskPath(id), updated);
      return updated;
    });
  }
  async deleteTask(id: string): Promise<boolean> {
    return this.transaction(tx => {
      if (!tx.exists(this.taskPath(id))) return false;
      tx.write(this.taskPath(id), null);
      return true;
    });
  }
  async deleteTasks(filter: (task: Task) => boolean): Promise<number> {
    return this.transaction(tx => {
      const removed = this.tasks(tx).filter(filter);
      for (const task of removed) tx.write(this.taskPath(task.id), null);
      return removed.length;
    });
  }
  async transition(id: string, status: TaskStatus): Promise<Task> {
    return this.transaction(tx => {
      const existing = this.readTask(tx, id);
      if (!existing) throw new Error(`Task not found: ${id}`);
      if ((status === "pending" || status === "awaiting_approval") && existing.activeRunId) {
        return this.mutateExecution(tx, taskExecutionReference(existing), { type: "transition", status }).task;
      }
      assertValidTransition(existing.status, status);
      const updated = { ...existing, status, updatedAt: new Date().toISOString(),
        retries: existing.retries + (status === "pending" && existing.status === "failed" ? 1 : 0),
        ...(status === "pending" ? { executionRevision: nextTaskExecutionRevision(existing), activeRunId: undefined, approvalState: undefined } : {}) };
      this.write(tx, this.taskPath(id), updated);
      return updated;
    });
  }

  private executionRun(tx: ProjectFileTransaction, id: string): RunRecord | undefined {
    const raw = tx.read(this.entityPath("runs", id));
    if (raw === null) return undefined;
    let run: RunRecord;
    try { run = JSON.parse(raw); } catch { throw new TaskExecutionError("task_execution_invalid", "Invalid stored Run"); }
    if (!run || run.id !== id || !["running", "completed", "failed", "killed"].includes(run.status)) {
      throw new TaskExecutionError("task_execution_invalid", "Invalid stored Run");
    }
    return run;
  }

  async claimTaskExecution(raw: TaskExecutionReference, runId: string): Promise<TaskExecutionState & { run: RunRecord }> {
    const expected = normalizeTaskExecutionReference(raw);
    normalizeTaskExecutionReference({ taskId: runId, revision: 0 });
    return this.transaction(tx => {
      if (this.executionRun(tx, runId)) throw new TaskExecutionError("task_execution_conflict", "Run identity is already in use");
      const state = prepareTaskExecutionClaim(this.readTask(tx, expected.taskId), expected, runId, new Date().toISOString());
      this.write(tx, this.taskPath(state.task.id), state.task);
      this.write(tx, this.entityPath("runs", runId), state.run);
      return state;
    });
  }

  async mutateTaskExecution(raw: TaskExecutionReference, mutation: TaskExecutionMutation): Promise<TaskExecutionState> {
    const expected = normalizeTaskExecutionReference(raw);
    const copied = normalizeTaskExecutionMutation(mutation);
    return this.transaction(tx => this.mutateExecution(tx, expected, copied));
  }

  async mutateTaskExecutionConditionally(raw: TaskExecutionReference, mutation: TaskExecutionMutation,
    preconditions: readonly TaskExecutionPrecondition[]): Promise<TaskExecutionState> {
    const expected = normalizeTaskExecutionReference(raw), copied = normalizeTaskExecutionMutation(mutation);
    const conditions = normalizeTaskExecutionPreconditions(preconditions);
    return this.transaction(tx => {
      this.checkExecutionConditions(tx, conditions);
      return this.mutateExecution(tx, expected, copied);
    });
  }

  private checkExecutionConditions(tx: ProjectFileTransaction, conditions: readonly TaskExecutionPrecondition[]): void {
    assertTaskExecutionPreconditions(conditions, id => {
      const raw = tx.read(this.taskPath(id));
      if (raw === null) return undefined;
      let task: Task;
      try { task = JSON.parse(raw); } catch { throw new TaskExecutionError("task_execution_invalid", "Invalid stored Task"); }
      if (!task || task.id !== id || !Object.hasOwn(VALID_TRANSITIONS, task.status)) {
        throw new TaskExecutionError("task_execution_invalid", "Invalid stored Task");
      }
      taskExecutionReference(task);
      return task;
    });
  }

  getTaskApprovalStore(): FileApprovalStore { return new FileApprovalStore(this.polpoDir); }

  async commitTaskApprovalDecision(raw: TaskApprovalDecision): Promise<TaskExecutionState> {
    const input = normalizeTaskApprovalDecision(raw);
    return this.transaction(tx => {
      this.checkExecutionConditions(tx, input.tasks);
      const requests = new Map(readFileApprovalRequests(tx).map(request => [request.id, request]));
      assertTaskApprovalPreconditions(input.approvals, id => requests.get(id));
      const task = this.readTask(tx, input.expected.taskId);
      const runId = input.operation?.type === "claim" ? input.operation.runId : input.expected.runId;
      const run = runId === undefined ? undefined : this.executionRun(tx, runId);
      if (input.operation?.type === "claim" && run) throw new TaskExecutionError("task_execution_conflict", "Run identity is already in use");
      const now = new Date().toISOString();
      let state = input.operation?.type === "claim"
        ? prepareTaskExecutionClaim(task, input.expected, input.operation.runId, now)
        : prepareTaskExecutionMutation(task, run, input.expected, input.operation ?? { type: "patch", updates: {} }, now);
      if (input.operation === undefined) state = { task: task!, ...(run ? { run } : {}) };
      state = applyTaskApprovalState(state, input.approvalState);
      if (input.operation !== undefined || input.approvalState !== undefined) {
        this.write(tx, this.taskPath(state.task.id), state.task);
        if (state.run && state.run !== run) this.write(tx, this.entityPath("runs", state.run.id), state.run);
      }
      for (const change of input.approvals) if (change.next !== undefined) requests.set(change.id, change.next);
      if (input.approvals.some(change => change.next !== undefined)) writeFileApprovalRequests(tx, [...requests.values()]);
      return state;
    });
  }

  private mutateExecution(tx: ProjectFileTransaction, expected: TaskExecutionReference, mutation: TaskExecutionMutation): TaskExecutionState {
    const task = this.readTask(tx, expected.taskId);
    const run = expected.runId === undefined ? undefined : this.executionRun(tx, expected.runId);
    const state = prepareTaskExecutionMutation(task, run, expected, mutation, new Date().toISOString());
    this.write(tx, this.taskPath(state.task.id), state.task);
    if (state.run && state.run !== run) this.write(tx, this.entityPath("runs", state.run.id), state.run);
    return state;
  }

  async createMission(input: Omit<Mission, "id" | "createdAt" | "updatedAt">): Promise<Mission> {
    input = { ...input, metadata: normalizeRuntimeMetadata(input.metadata) };
    return this.transaction(tx => {
      const now = new Date().toISOString();
      const mission: Mission = { ...input, id: nanoid(), createdAt: now, updatedAt: now };
      this.write(tx, this.missionPath(mission.id), mission);
      return mission;
    });
  }
  async getMission(id: string): Promise<Mission | undefined> { return this.transaction(tx => this.readMission(tx, id)); }
  async getMissionByName(name: string): Promise<Mission | undefined> { return this.transaction(tx => this.missions(tx).find(m => m.name === name)); }
  async listMissions(): Promise<Mission[]> { return this.transaction(tx => this.missions(tx)); }
  async updateMission(id: string, updates: Partial<Omit<Mission, "id">>): Promise<Mission> {
    if (updates.metadata !== undefined) updates = { ...updates, metadata: normalizeRuntimeMetadata(updates.metadata) };
    return this.transaction(tx => {
      const existing = this.readMission(tx, id);
      if (!existing) throw new Error(`Mission not found: ${id}`);
      const updated = { ...existing, ...updates, id, updatedAt: new Date().toISOString() };
      this.write(tx, this.missionPath(id), updated);
      return updated;
    });
  }
  async deleteMission(id: string): Promise<boolean> {
    return this.transaction(tx => {
      if (!tx.exists(this.missionPath(id))) return false;
      tx.write(this.missionPath(id), null);
      return true;
    });
  }
  async nextMissionName(): Promise<string> { return this.transaction(tx => `mission-${this.ids(tx, "missions").length + 1}`); }

  private receipt(tx: ProjectFileTransaction, missionId: string, key: string): MissionExecutionReceipt | undefined {
    const raw = tx.read(this.executionPath(missionId, key));
    if (raw === null) return undefined;
    const stored = normalizeMissionExecutionCommit(JSON.parse(raw));
    if (stored.receipt.missionId !== missionId || stored.receipt.idempotencyKey !== key) throw new Error("Invalid stored Mission execution receipt");
    return stored.receipt;
  }
  async getMissionExecution(missionId: string, key: string): Promise<MissionExecutionReceipt | undefined> {
    return this.transaction(tx => this.receipt(tx, missionId, key));
  }
  private admissionById(tx: ProjectFileTransaction, executionId: string): MissionExecutionCommit | undefined {
    const index = tx.read(`.runtime/mission-executions/by-id/${executionId}.json`);
    if (index === null) return undefined;
    const identity = JSON.parse(index);
    const raw = tx.read(this.executionPath(identity.missionId, identity.idempotencyKey));
    if (raw === null) throw new MissionExecutionError("mission_execution_invalid", "Missing indexed Mission execution");
    const input = normalizeMissionExecutionCommit(JSON.parse(raw));
    if (input.receipt.executionId !== executionId || input.receipt.missionId !== identity.missionId
      || input.receipt.idempotencyKey !== identity.idempotencyKey) throw new MissionExecutionError("mission_execution_invalid", "Invalid indexed Mission execution");
    return input;
  }
  async getMissionExecutionById(executionId: string): Promise<MissionExecutionCommit | undefined> {
    validateMissionExecutionKey(executionId, "lookup");
    return this.transaction(tx => this.admissionById(tx, executionId));
  }
  async finalizeMissionExecution(executionId: string, status: MissionExecutionFinalStatus): Promise<boolean> {
    validateMissionExecutionKey(executionId, "finalize");
    validateMissionExecutionFinalStatus(status);
    return this.transaction(tx => {
      const admission = this.admissionById(tx, executionId);
      if (!admission) return false;
      const mission = this.readMission(tx, admission.receipt.missionId);
      if (!mission || mission.status !== "active" || mission.executionCount !== admission.receipt.sequence) return false;
      const tasks = this.admissionTasks(tx);
      if (!admission.receipt.tasks.every(captured => tasks.some(task => task.id === captured.id && (task.status === "done" || task.status === "failed")))) return false;
      this.write(tx, this.missionPath(mission.id), { ...mission, status, updatedAt: new Date().toISOString() });
      return true;
    });
  }
  async commitMissionExecution(request: MissionExecutionCommit): Promise<{ receipt: MissionExecutionReceipt; created: boolean }> {
    const input = normalizeMissionExecutionCommit(request);
    return this.transaction(tx => {
      const receipt = this.receipt(tx, input.receipt.missionId, input.receipt.idempotencyKey);
      if (receipt) return { receipt, created: false };
      const identityPath = `.runtime/mission-executions/by-id/${input.receipt.executionId}.json`;
      if (tx.exists(identityPath)) throw new MissionExecutionError("mission_execution_conflict", "Mission execution identity is already in use");
      const mission = admitMissionExecution(input, this.readMission(tx, input.expected.id), this.admissionTasks(tx));
      for (const task of input.receipt.tasks) this.write(tx, this.taskPath(task.id), task);
      this.write(tx, this.missionPath(mission.id), mission);
      this.write(tx, this.executionPath(mission.id, input.receipt.idempotencyKey), input);
      this.write(tx, identityPath, { missionId: mission.id, idempotencyKey: input.receipt.idempotencyKey });
      return { receipt: input.receipt, created: true };
    });
  }
  async close(): Promise<void> { /* per-operation coordinator connections close synchronously */ }
}
