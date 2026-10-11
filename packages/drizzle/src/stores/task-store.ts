import { normalizeTaskExecutionReference, normalizeTaskExecutionMutation, prepareTaskExecutionClaim, prepareTaskExecutionMutation,
  TaskExecutionError, taskExecutionReference, nextTaskExecutionRevision, type ConditionalTaskExecutionStore, type TaskExecutionPrecondition, normalizeTaskExecutionPreconditions, assertTaskExecutionPreconditions, type TaskExecutionReference, type TaskExecutionMutation, type TaskExecutionState } from "@polpo-ai/core/task-execution";
import { runRecordFromRow, runRecordToValues } from "./run-store.js";
import { eq, desc, asc, and, or, inArray, notInArray, sql, getTableColumns } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { TaskStore } from "@polpo-ai/core/task-store";
import type {
  Task, TaskStatus, Mission, PolpoState, AgentProcess,
} from "@polpo-ai/core/types";
import { assertValidTransition } from "@polpo-ai/core/state-machine";
import { normalizeRuntimeMetadata } from "@polpo-ai/core";
import { type Dialect, serializeJson, deserializeJson, extractAffectedRows } from "../utils.js";
import {
  admitMissionExecution, normalizeMissionExecutionCommit, validateMissionExecutionKey, validateMissionExecutionFinalStatus, type MissionExecutionFinalStatus,
  MissionExecutionError, type MissionExecutionStore, type MissionExecutionCommit, type MissionExecutionReceipt,
} from "@polpo-ai/core/mission-store";
import type { DrizzleTransactionProvider } from "./session-store.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTable = any;

export interface TaskStoreSchema {
  tasks: AnyTable;
  runs?: AnyTable;
  missions: AnyTable;
  metadata: AnyTable;
  processes: AnyTable;
  missionExecutions?: AnyTable;
}

export class DrizzleTaskStore implements TaskStore, MissionExecutionStore, ConditionalTaskExecutionStore {
  constructor(
    private db: any,
    private schema: TaskStoreSchema,
    private dialect: Dialect,
    private transactionProvider?: DrizzleTransactionProvider,
  ) {}

  // ── Helpers ──────────────────────────────────────────────────────────

  private rowToTask(row: any): Task {
    const d = this.dialect;
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      assignTo: row.assignTo,
      loop: row.loop ?? undefined,
      group: row.group ?? undefined,
      missionId: row.missionId ?? undefined,
      missionExecutionId: row.missionExecutionId ?? undefined,
      dependsOn: deserializeJson<string[]>(row.dependsOn, [], d),
      status: row.status as TaskStatus,
      ...(row.executionRevision ? { executionRevision: row.executionRevision } : {}),
      ...(row.activeRunId == null ? {} : { activeRunId: row.activeRunId }),
      retries: row.retries,
      maxRetries: row.maxRetries,
      maxDuration: row.maxDuration ?? undefined,
      retryPolicy: deserializeJson(row.retryPolicy, undefined, d),
      expectations: deserializeJson(row.expectations, [], d),
      metrics: deserializeJson(row.metrics, [], d),
      result: deserializeJson(row.result, undefined, d),
      phase: row.phase ?? undefined,
      fixAttempts: row.fixAttempts ?? 0,
      questionRounds: row.questionRounds ?? 0,
      resolutionAttempts: row.resolutionAttempts ?? 0,
      originalDescription: row.originalDescription ?? undefined,
      sessionId: row.sessionId ?? undefined,
      notifications: deserializeJson(row.notifications, undefined, d),
      outcomes: deserializeJson(row.outcomes, undefined, d),
      expectedOutcomes: deserializeJson(row.expectedOutcomes, undefined, d),
      deadline: row.deadline ?? undefined,
      priority: row.priority != null ? Number(row.priority) : undefined,
      sideEffects: row.sideEffects != null ? Boolean(row.sideEffects) : undefined,
      revisionCount: row.revisionCount ?? undefined,
      executionMode: row.executionMode ?? undefined,
      sandbox: deserializeJson(row.sandbox, undefined, d),
      routing: deserializeJson(row.routing, undefined, d),
      user: row.user ?? undefined,
      metadata: normalizeRuntimeMetadata(deserializeJson(row.metadata, undefined, d)),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private taskToValues(task: Partial<Task> & { id: string }): Record<string, unknown> {
    const d = this.dialect;
    const v: Record<string, unknown> = {};
    if (task.id !== undefined) v.id = task.id;
    if (task.title !== undefined) v.title = task.title;
    if (task.description !== undefined) v.description = task.description;
    if (task.assignTo !== undefined) v.assignTo = task.assignTo;
    if (task.loop !== undefined) v.loop = task.loop;
    if (task.group !== undefined) v.group = task.group;
    if (task.missionId !== undefined) v.missionId = task.missionId;
    if (task.missionExecutionId !== undefined) v.missionExecutionId = task.missionExecutionId;
    if (task.dependsOn !== undefined) v.dependsOn = serializeJson(task.dependsOn, d);
    if (task.status !== undefined) v.status = task.status;
    if (task.executionRevision !== undefined) v.executionRevision = task.executionRevision;
    if (task.activeRunId !== undefined) v.activeRunId = task.activeRunId;
    if (task.retries !== undefined) v.retries = task.retries;
    if (task.maxRetries !== undefined) v.maxRetries = task.maxRetries;
    if (task.maxDuration !== undefined) v.maxDuration = task.maxDuration;
    if (task.retryPolicy !== undefined) v.retryPolicy = serializeJson(task.retryPolicy, d);
    if (task.expectations !== undefined) v.expectations = serializeJson(task.expectations, d);
    if (task.metrics !== undefined) v.metrics = serializeJson(task.metrics, d);
    if (task.result !== undefined) v.result = serializeJson(task.result, d);
    if (task.phase !== undefined) v.phase = task.phase;
    if (task.fixAttempts !== undefined) v.fixAttempts = task.fixAttempts;
    if (task.questionRounds !== undefined) v.questionRounds = task.questionRounds;
    if (task.resolutionAttempts !== undefined) v.resolutionAttempts = task.resolutionAttempts;
    if (task.originalDescription !== undefined) v.originalDescription = task.originalDescription;
    if (task.sessionId !== undefined) v.sessionId = task.sessionId;
    if (task.notifications !== undefined) v.notifications = serializeJson(task.notifications, d);
    if (task.outcomes !== undefined) v.outcomes = serializeJson(task.outcomes, d);
    if (task.expectedOutcomes !== undefined) v.expectedOutcomes = serializeJson(task.expectedOutcomes, d);
    if (task.deadline !== undefined) v.deadline = task.deadline;
    if (task.priority !== undefined) v.priority = String(task.priority);
    if (task.sideEffects !== undefined) v.sideEffects = task.sideEffects ? 1 : 0;
    if (task.revisionCount !== undefined) v.revisionCount = task.revisionCount;
    if (task.executionMode !== undefined) v.executionMode = task.executionMode;
    if (task.sandbox !== undefined) v.sandbox = serializeJson(task.sandbox, d);
    if (task.routing !== undefined) v.routing = serializeJson(task.routing, d);
    if (task.user !== undefined) v.user = task.user;
    if (task.metadata !== undefined) v.metadata = serializeJson(normalizeRuntimeMetadata(task.metadata), d);
    if (task.createdAt !== undefined) v.createdAt = task.createdAt;
    if (task.updatedAt !== undefined) v.updatedAt = task.updatedAt;
    return v;
  }

  private rowToMission(row: any): Mission {
    const d = this.dialect;
    return {
      id: row.id,
      name: row.name,
      data: row.data,
      prompt: row.prompt ?? undefined,
      status: row.status,
      schedule: row.schedule ?? undefined,
      endDate: row.endDate ?? undefined,
      qualityThreshold: row.qualityThreshold != null ? Number(row.qualityThreshold) : undefined,
      deadline: row.deadline ?? undefined,
      notifications: deserializeJson(row.notifications, undefined, d),
      executionCount: row.executionCount ?? 0,
      user: row.user ?? undefined,
      metadata: normalizeRuntimeMetadata(deserializeJson(row.metadata, undefined, d)),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private rowToProcess(row: any): AgentProcess {
    return {
      agentName: row.agentName,
      pid: row.pid,
      taskId: row.taskId,
      startedAt: row.startedAt,
      alive: Boolean(row.alive),
      activity: deserializeJson(row.activity, {
        filesCreated: [], filesEdited: [], toolCalls: 0, totalTokens: 0, lastUpdate: "",
      }, this.dialect),
    };
  }

  // ── State ────────────────────────────────────────────────────────────

  async getState(): Promise<PolpoState> {
    const { metadata, tasks, processes } = this.schema;

    const metaRows: any[] = await this.db.select().from(metadata);
    const meta: Record<string, string> = {};
    for (const r of metaRows) meta[r.key] = r.value;

    let teams: any[] = [];
    if (meta.teams) {
      teams = deserializeJson<any[]>(meta.teams, [], this.dialect);
    } else if (meta.team) {
      teams = [deserializeJson(meta.team, { name: "default", agents: [] }, this.dialect)];
    }

    const taskRows: any[] = await this.db.select().from(tasks).orderBy(asc(tasks.createdAt));
    const procRows: any[] = await this.db.select().from(processes);

    return {
      project: meta.project ?? "",
      teams,
      tasks: taskRows.map((r) => this.rowToTask(r)),
      processes: procRows.map((r) => this.rowToProcess(r)),
      startedAt: meta.startedAt,
      completedAt: meta.completedAt,
    };
  }

  async setState(partial: Partial<PolpoState>): Promise<void> {
    const { metadata, tasks, processes } = this.schema;
    const d = this.dialect;

    // SQLite transactions require synchronous callbacks — execute directly.
    const upsertMeta = (db: any, key: string, value: string) =>
      db.insert(metadata).values({ key, value })
        .onConflictDoUpdate({ target: metadata.key, set: { value } });

    const exec = async (db: any) => {
      if (partial.project !== undefined) {
        await upsertMeta(db, "project", partial.project);
      }
      if (partial.teams !== undefined) {
        const val = JSON.stringify(partial.teams);
        await upsertMeta(db, "teams", val);
      }
      if (partial.startedAt !== undefined) {
        await upsertMeta(db, "startedAt", partial.startedAt);
      }
      if (partial.completedAt !== undefined) {
        await upsertMeta(db, "completedAt", partial.completedAt);
      }
      if (partial.processes !== undefined) {
        await db.delete(processes);
        for (const p of partial.processes) {
          await db.insert(processes).values({
            agentName: p.agentName,
            pid: p.pid,
            taskId: p.taskId,
            startedAt: p.startedAt,
            alive: p.alive ? 1 : 0,
            activity: serializeJson(p.activity, d),
          });
        }
      }
      if (partial.tasks !== undefined) {
        await db.delete(tasks);
        for (const t of partial.tasks) {
          await db.insert(tasks).values(this.taskToValues(t));
        }
      }
    };

    // Execute directly without transaction.
    // Some HTTP drivers don't support transactions, and
    // SQLite better-sqlite3 transactions don't support async callbacks.
    // Individual upserts are idempotent — no transaction needed for correctness.
    await exec(this.db);
  }

  // ── Task CRUD ────────────────────────────────────────────────────────

  async createTask(input: Omit<Task, "id" | "status" | "retries" | "createdAt" | "updatedAt" | "executionRevision" | "activeRunId"> & { status?: TaskStatus }): Promise<Task> {
    input = { ...input, metadata: normalizeRuntimeMetadata(input.metadata) };
    const now = new Date().toISOString();
    const task: Task = {
      ...input,
      id: nanoid(),
      status: input.status ?? "pending",
      retries: 0,
      createdAt: now,
      updatedAt: now,
    };
    delete task.executionRevision;
    delete task.activeRunId;
    await this.db.insert(this.schema.tasks).values(this.taskToValues(task));
    return task;
  }

  async getTask(taskId: string): Promise<Task | undefined> {
    const rows: any[] = await this.db.select().from(this.schema.tasks)
      .where(eq(this.schema.tasks.id, taskId));
    return rows.length > 0 ? this.rowToTask(rows[0]) : undefined;
  }

  async listTasks(): Promise<Task[]> {
    const rows: any[] = await this.db.select().from(this.schema.tasks)
      .orderBy(asc(this.schema.tasks.createdAt));
    return rows.map((r) => this.rowToTask(r));
  }

  async updateTask(taskId: string, updates: Partial<Omit<Task, "id" | "status" | "executionRevision" | "activeRunId">>): Promise<Task> {
    if (updates.metadata !== undefined) updates = { ...updates, metadata: normalizeRuntimeMetadata(updates.metadata) };
    const existing = await this.getTask(taskId);
    if (!existing) throw new Error(`Task "${taskId}" not found`);

    const now = new Date().toISOString();
    // Write only the requested fields. Rewriting a previously read Task can
    // resurrect a cancelled execution or lose a concurrent retry/metadata edit.
    const values = this.taskToValues({ ...updates, id: taskId, updatedAt: now });
    const columns = getTableColumns(this.schema.tasks);
    for (const [field, value] of Object.entries(updates)) {
      // An explicitly cleared optional field is different from an omitted one.
      // Assessment, for example, clears phase when its work is complete.
      if (value === undefined && Object.hasOwn(columns, field) && !columns[field].notNull) {
        values[field] = null;
      }
    }
    delete values.id;
    delete values.status;
    delete values.executionRevision;
    delete values.activeRunId;
    const rows: any[] = await this.db.update(this.schema.tasks).set(values)
      .where(eq(this.schema.tasks.id, taskId)).returning();
    if (!rows[0]) throw new Error(`Task "${taskId}" not found`);
    return this.rowToTask(rows[0]);
  }

  async deleteTask(taskId: string): Promise<boolean> {
    const result = await this.db.delete(this.schema.tasks)
      .where(eq(this.schema.tasks.id, taskId));
    return extractAffectedRows(result) > 0;
  }

  async deleteTasks(filter: (task: Task) => boolean): Promise<number> {
    const all = await this.listTasks();
    const toRemove = all.filter(filter);
    if (toRemove.length === 0) return 0;
    for (const t of toRemove) {
      await this.db.delete(this.schema.tasks)
        .where(eq(this.schema.tasks.id, t.id));
    }
    return toRemove.length;
  }

  // ── State machine ───────────────────────────────────────────────────

  async transition(taskId: string, newStatus: TaskStatus): Promise<Task> {
    const task = await this.getTask(taskId);
    if (!task) throw new Error(`Task "${taskId}" not found`);

    if ((newStatus === "pending" || newStatus === "awaiting_approval") && task.activeRunId) {
      return (await this.mutateTaskExecution(taskExecutionReference(task), { type: "transition", status: newStatus })).task;
    }
    assertValidTransition(task.status, newStatus);

    const now = new Date().toISOString();
    const updates: Record<string, unknown> = { status: newStatus, updatedAt: now };

    if (newStatus === "pending") {
      updates.executionRevision = nextTaskExecutionRevision(task);
      updates.activeRunId = null;
    }
    // Increment retries on failed → pending
    if (task.status === "failed" && newStatus === "pending") {
      updates.retries = task.retries + 1;
    }

    // Validation and mutation must refer to the same observed state. A later
    // writer cannot overwrite completion/cancellation or a new retry that has
    // returned to the same status. Callers processing a specific attempt must
    // additionally pass its captured reference through mutateTaskExecution.
    const rows: any[] = await this.db.update(this.schema.tasks).set(updates)
      .where(and(
        eq(this.schema.tasks.id, taskId),
        eq(this.schema.tasks.status, task.status),
        eq(this.schema.tasks.retries, task.retries),
        eq(this.schema.tasks.executionRevision, task.executionRevision ?? 0),
      )).returning();
    if (!rows[0]) throw new Error(`Task "${taskId}" state changed during transition`);
    return this.rowToTask(rows[0]);
  }

  async unsafeSetStatus(taskId: string, newStatus: TaskStatus, _reason: string): Promise<Task> {
    const task = await this.getTask(taskId);
    if (!task) throw new Error(`Task "${taskId}" not found`);

    if (newStatus === "pending" && task.activeRunId) {
      return (await this.mutateTaskExecution(taskExecutionReference(task), { type: "requeue", countRetry: false, reason: _reason })).task;
    }
    const now = new Date().toISOString();
    const execution = newStatus === "pending" ? { executionRevision: nextTaskExecutionRevision(task), activeRunId: null } : {};
    const rows = await this.db.update(this.schema.tasks)
      .set({ status: newStatus, updatedAt: now, ...execution })
      .where(and(eq(this.schema.tasks.id, taskId), eq(this.schema.tasks.executionRevision, task.executionRevision ?? 0))).returning();
    if (!rows[0]) throw new TaskExecutionError("task_execution_conflict", "Task execution changed");
    return this.rowToTask(rows[0]);
  }

  async claimTaskExecution(raw: TaskExecutionReference, runId: string): Promise<TaskExecutionState & { run: import("@polpo-ai/core/run-store").RunRecord }> {
    const expected = normalizeTaskExecutionReference(raw);
    normalizeTaskExecutionReference({ taskId: runId, revision: 0 });
    return this.executeTaskMutation(expected, { claim: runId }) as Promise<TaskExecutionState & { run: import("@polpo-ai/core/run-store").RunRecord }>;
  }

  async mutateTaskExecution(raw: TaskExecutionReference, mutation: TaskExecutionMutation): Promise<TaskExecutionState> {
    const expected = normalizeTaskExecutionReference(raw);
    return this.executeTaskMutation(expected, { mutation: normalizeTaskExecutionMutation(mutation) });
  }

  async mutateTaskExecutionConditionally(raw: TaskExecutionReference, mutation: TaskExecutionMutation,
    preconditions: readonly TaskExecutionPrecondition[]): Promise<TaskExecutionState> {
    const expected = normalizeTaskExecutionReference(raw), copied = normalizeTaskExecutionMutation(mutation);
    const conditions = normalizeTaskExecutionPreconditions(preconditions);
    return this.executeTaskMutation(expected, { mutation: copied }, conditions);
  }

  private async executeTaskMutation(expected: TaskExecutionReference, operation: { claim: string } | { mutation: TaskExecutionMutation }, conditions?: TaskExecutionPrecondition[]): Promise<TaskExecutionState> {
    const { tasks, runs } = this.schema;
    if (!runs) throw new TaskExecutionError("task_execution_unsupported", "Task execution requires shared Task and Run storage");
    const runId = "claim" in operation ? operation.claim : expected.runId;
    const taskIds = [...new Set([expected.taskId, ...conditions?.map(condition => condition.taskId) ?? []])].sort();
    const taskQuery = (tx: any) => tx.select().from(tasks).where(inArray(tasks.id, taskIds)).orderBy(asc(tasks.id));
    const checkedTaskRow = (rows: any[]) => {
      const captured = new Map(rows.map(row => [row.id, row]));
      if (conditions) assertTaskExecutionPreconditions(conditions, id => {
        const row = captured.get(id); return row ? this.rowToTask(row) : undefined;
      });
      return captured.get(expected.taskId);
    };
    const runQuery = (tx: any) => tx.select().from(runs).where(eq(runs.id, runId));
    const prepare = (taskRow: any, runRow: any) => {
      const task = taskRow ? this.rowToTask(taskRow) : undefined;
      const run = runRow ? runRecordFromRow(runRow, this.dialect) : undefined;
      if ("claim" in operation && run) throw new TaskExecutionError("task_execution_conflict", "Run identity is already in use");
      const now = new Date().toISOString();
      const state = "claim" in operation
        ? prepareTaskExecutionClaim(task, expected, operation.claim, now)
        : prepareTaskExecutionMutation(task, run, expected, operation.mutation, now);
      const values = this.taskToValues(state.task);
      const columns = getTableColumns(tasks);
      for (const [field, value] of Object.entries(state.task)) {
        if (value === undefined && Object.hasOwn(columns, field) && !columns[field].notNull) values[field] = null;
      }
      delete values.id;
      return { state, values, runChanged: state.run !== run };
    };
    const writes = (tx: any, prepared: ReturnType<typeof prepare>) => {
      const queries = [tx.update(tasks).set(prepared.values).where(eq(tasks.id, expected.taskId))];
      const run = prepared.state.run;
      if ("claim" in operation) queries.push(tx.insert(runs).values(runRecordToValues(run!, this.dialect)));
      else if (run && prepared.runChanged) queries.push(tx.update(runs).set({
        status: run.status, result: serializeJson(run.result, this.dialect), updatedAt: run.updatedAt, completedAt: run.completedAt,
      }).where(and(eq(runs.id, run.id), eq(runs.status, "running"))));
      return queries;
    };
    if (this.dialect === "sqlite") {
      return this.db.transaction((tx: any) => {
        const prepared = prepare(checkedTaskRow(taskQuery(tx).all()), runId === undefined ? undefined : runQuery(tx).get());
        for (const query of writes(tx, prepared)) query.run();
        return prepared.state;
      }, { behavior: "immediate" });
    }
    const execute = async (tx: any) => {
      // Missing rows cannot be protected with FOR UPDATE. Take this broader
      // lock before row locks only for an absence assertion, excluding existing
      // SELECT FOR UPDATE owners as well as writes to prevent lock upgrades
      // from deadlocking. This prevents inserts
      // (including legacy writers) until the decision commits. Existing rows
      // are locked in deterministic ID order to avoid cross-dependency deadlocks.
      if (conditions?.some(condition => condition.snapshot === null)) {
        await tx.execute(sql`LOCK TABLE ${tasks} IN EXCLUSIVE MODE`);
      }
      const taskRow = checkedTaskRow(await taskQuery(tx).for("update"));
      const runRow = runId === undefined ? undefined : (await runQuery(tx).for("update"))[0];
      const prepared = prepare(taskRow, runRow);
      for (const query of writes(tx, prepared)) await query;
      return prepared.state;
    };
    if (this.transactionProvider) return this.transactionProvider(execute);
    if (typeof this.db.transaction !== "function") throw new TaskExecutionError("task_execution_unsupported", "Task execution requires an interactive transaction");
    return this.db.transaction(execute);
  }

  // ── Missions ─────────────────────────────────────────────────────────

  private executionTable(): AnyTable {
    if (!this.schema.missionExecutions) throw new MissionExecutionError("mission_execution_unsupported", "Mission execution persistence is not configured");
    return this.schema.missionExecutions;
  }

  private receiptFromRow(row: any): MissionExecutionReceipt | undefined {
    if (!row) return undefined;
    const input = normalizeMissionExecutionCommit(deserializeJson(row.admission, undefined, this.dialect));
    if (input.receipt.missionId !== row.missionId || input.receipt.idempotencyKey !== row.idempotencyKey
      || input.receipt.executionId !== row.executionId || input.receipt.createdAt !== row.createdAt) {
      throw new MissionExecutionError("mission_execution_invalid", "Invalid stored Mission execution");
    }
    return input.receipt;
  }

  async getMissionExecution(missionId: string, idempotencyKey: string): Promise<MissionExecutionReceipt | undefined> {
    validateMissionExecutionKey(missionId, idempotencyKey);
    const table = this.executionTable();
    const rows = await this.db.select().from(table).where(and(eq(table.missionId, missionId), eq(table.idempotencyKey, idempotencyKey)));
    return this.receiptFromRow(rows[0]);
  }

  async getMissionExecutionById(executionId: string): Promise<MissionExecutionCommit | undefined> {
    validateMissionExecutionKey(executionId, "lookup");
    const table = this.executionTable();
    const rows = await this.db.select().from(table).where(eq(table.executionId, executionId));
    if (!rows[0]) return undefined;
    this.receiptFromRow(rows[0]);
    return normalizeMissionExecutionCommit(deserializeJson(rows[0].admission, undefined, this.dialect));
  }

  async finalizeMissionExecution(executionId: string, status: MissionExecutionFinalStatus): Promise<boolean> {
    validateMissionExecutionFinalStatus(status);
    const admission = await this.getMissionExecutionById(executionId);
    if (!admission) return false;
    const { missions, tasks } = this.schema;
    const ids = admission.receipt.tasks.map(task => task.id);
    // The immutable receipt can be read separately. The current sequence,
    // state and complete terminal task set are checked in the UPDATE itself.
    const updated = await this.db.update(missions).set({ status, updatedAt: new Date().toISOString() }).where(and(
      eq(missions.id, admission.receipt.missionId), eq(missions.status, "active"), eq(missions.executionCount, admission.receipt.sequence),
      sql`(SELECT count(*) FROM ${tasks} WHERE ${inArray(tasks.id, ids)} AND ${inArray(tasks.status, ["done", "failed"])}) = ${ids.length}`,
    )).returning({ id: missions.id });
    return updated.length > 0;
  }

  async commitMissionExecution(raw: MissionExecutionCommit): Promise<{ receipt: MissionExecutionReceipt; created: boolean }> {
    const input = normalizeMissionExecutionCommit(raw);
    const { receipt } = input, table = this.executionTable(), { tasks, missions } = this.schema;
    const receiptQuery = (db: any) => db.select().from(table)
      .where(and(eq(table.missionId, receipt.missionId), eq(table.idempotencyKey, receipt.idempotencyKey)));
    const identityQuery = (db: any) => db.select({ executionId: table.executionId }).from(table).where(eq(table.executionId, receipt.executionId));
    const assertUnusedIdentity = (row: unknown) => {
      if (row) throw new MissionExecutionError("mission_execution_conflict", "Mission execution identity is already in use");
    };
    const missionQuery = (db: any) => db.select().from(missions).where(eq(missions.id, receipt.missionId));
    const conflictsQuery = (db: any) => db.select().from(tasks).where(or(
      inArray(tasks.id, receipt.tasks.map(task => task.id)),
      and(inArray(tasks.title, receipt.tasks.map(task => task.title)), notInArray(tasks.status, ["done", "failed"])),
    ));
    const missionValues = (current: any, conflicts: any[]) => {
      const mission = admitMissionExecution(input, current ? this.rowToMission(current) : undefined, conflicts.map(row => this.rowToTask(row)));
      return { status: mission.status, executionCount: mission.executionCount, updatedAt: mission.updatedAt,
        ...(input.notifications === undefined ? {} : { notifications: serializeJson(input.notifications, this.dialect) }) };
    };
    const record = { missionId: receipt.missionId, idempotencyKey: receipt.idempotencyKey, executionId: receipt.executionId,
      admission: serializeJson(input, this.dialect), createdAt: receipt.createdAt };
    const taskValues = receipt.tasks.map(task => this.taskToValues(task));

    if (this.dialect === "sqlite") {
      // better-sqlite3 requires a synchronous callback. Awaiting a Drizzle query
      // here would commit before the writes; run/get/all execute inside BEGIN.
      return this.db.transaction((tx: any) => {
        const existing = this.receiptFromRow(receiptQuery(tx).get());
        if (existing) return { receipt: existing, created: false };
        assertUnusedIdentity(identityQuery(tx).get());
        const values = missionValues(missionQuery(tx).get(), conflictsQuery(tx).all());
        // One row at a time stays below SQLite's parameter limit for large plans.
        for (const task of taskValues) tx.insert(tasks).values(task).run();
        tx.update(missions).set(values).where(eq(missions.id, receipt.missionId)).run();
        tx.insert(table).values(record).run();
        return { receipt, created: true };
      }, { behavior: "immediate" });
    }

    const execute = async (tx: any) => {
      // Serialize admission within this project's task table, including across
      // different Missions whose active titles could conflict. Ordinary task
      // writes wait for this short transaction; readers can see committed work.
      await tx.execute(sql`LOCK TABLE ${tasks} IN EXCLUSIVE MODE`);
      const existing = this.receiptFromRow((await receiptQuery(tx))[0]);
      if (existing) return { receipt: existing, created: false };
      assertUnusedIdentity((await identityQuery(tx))[0]);
      const current = (await missionQuery(tx).for("update"))[0];
      const values = missionValues(current, await conflictsQuery(tx));
      await tx.insert(tasks).values(taskValues);
      await tx.update(missions).set(values).where(eq(missions.id, receipt.missionId));
      await tx.insert(table).values(record);
      return { receipt, created: true };
    };
    if (this.transactionProvider) return this.transactionProvider(execute);
    if (typeof this.db.transaction !== "function") throw new MissionExecutionError("mission_execution_unsupported", "Mission execution requires an interactive transaction");
    return this.db.transaction(execute);
  }

  async createMission(input: Omit<Mission, "id" | "createdAt" | "updatedAt">): Promise<Mission> {
    input = { ...input, metadata: normalizeRuntimeMetadata(input.metadata) };
    const now = new Date().toISOString();
    const mission: Mission = {
      ...input,
      id: nanoid(),
      createdAt: now,
      updatedAt: now,
    };
    const d = this.dialect;
    await this.db.insert(this.schema.missions).values({
      id: mission.id,
      name: mission.name,
      data: mission.data,
      prompt: mission.prompt ?? null,
      status: mission.status,
      schedule: mission.schedule ?? null,
      endDate: mission.endDate ?? null,
      qualityThreshold: mission.qualityThreshold != null ? String(mission.qualityThreshold) : null,
      deadline: mission.deadline ?? null,
      notifications: serializeJson(mission.notifications, d),
      executionCount: mission.executionCount ?? 0,
      user: mission.user ?? null,
      metadata: serializeJson(mission.metadata, d),
      createdAt: mission.createdAt,
      updatedAt: mission.updatedAt,
    });
    return mission;
  }

  async getMission(missionId: string): Promise<Mission | undefined> {
    const rows: any[] = await this.db.select().from(this.schema.missions)
      .where(eq(this.schema.missions.id, missionId));
    return rows.length > 0 ? this.rowToMission(rows[0]) : undefined;
  }

  async getMissionByName(name: string): Promise<Mission | undefined> {
    const rows: any[] = await this.db.select().from(this.schema.missions)
      .where(eq(this.schema.missions.name, name));
    return rows.length > 0 ? this.rowToMission(rows[0]) : undefined;
  }

  async listMissions(): Promise<Mission[]> {
    const rows: any[] = await this.db.select().from(this.schema.missions)
      .orderBy(desc(this.schema.missions.createdAt));
    return rows.map((r) => this.rowToMission(r));
  }

  async updateMission(missionId: string, updates: Partial<Omit<Mission, "id">>): Promise<Mission> {
    if (updates.metadata !== undefined) updates = { ...updates, metadata: normalizeRuntimeMetadata(updates.metadata) };
    const existing = await this.getMission(missionId);
    if (!existing) throw new Error(`Mission "${missionId}" not found`);

    const now = new Date().toISOString();
    const d = this.dialect;
    const values: Record<string, unknown> = { updatedAt: now };

    if (updates.name !== undefined) values.name = updates.name;
    if (updates.data !== undefined) values.data = updates.data;
    if (updates.prompt !== undefined) values.prompt = updates.prompt;
    if (updates.status !== undefined) values.status = updates.status;
    if (updates.schedule !== undefined) values.schedule = updates.schedule;
    if (updates.endDate !== undefined) values.endDate = updates.endDate;
    if (updates.qualityThreshold !== undefined) values.qualityThreshold = updates.qualityThreshold != null ? String(updates.qualityThreshold) : null;
    if (updates.deadline !== undefined) values.deadline = updates.deadline;
    if (updates.notifications !== undefined) values.notifications = serializeJson(updates.notifications, d);
    if (updates.executionCount !== undefined) values.executionCount = updates.executionCount;
    if (updates.user !== undefined) values.user = updates.user;
    if (updates.metadata !== undefined) values.metadata = serializeJson(updates.metadata, d);

    await this.db.update(this.schema.missions).set(values)
      .where(eq(this.schema.missions.id, missionId));

    return { ...existing, ...updates, updatedAt: now };
  }

  async deleteMission(missionId: string): Promise<boolean> {
    const result = await this.db.delete(this.schema.missions)
      .where(eq(this.schema.missions.id, missionId));
    return extractAffectedRows(result) > 0;
  }

  async nextMissionName(): Promise<string> {
    const rows: any[] = await this.db.select().from(this.schema.missions)
      .orderBy(desc(this.schema.missions.createdAt));
    let maxNum = 0;
    for (const r of rows) {
      const match = (r.name as string).match(/^mission-(\d+)$/);
      if (match) maxNum = Math.max(maxNum, Number(match[1]));
    }
    return `mission-${maxNum + 1}`;
  }

  async close(): Promise<void> {
    // Connection lifecycle managed externally
  }
}
