import { eq, desc, inArray, and, ne, isNull, or } from "drizzle-orm";
import type { RunStore, RunRecord, RunStatus } from "@polpo-ai/core/run-store";
import type { AgentActivity, TaskResult, TaskOutcome, RunnerConfig } from "@polpo-ai/core/types";
import type { LoopResumeState } from "@polpo-ai/core/loop-run-store";
import { type Dialect, serializeJson, deserializeJson } from "../utils.js";

type AnyTable = any;

const TERMINAL_STATUSES: RunStatus[] = ["completed", "failed", "killed"];

export class DrizzleRunStore implements RunStore {
  constructor(
    private db: any,
    private runs: AnyTable,
    private dialect: Dialect,
  ) {}

  private rowToRecord(row: any): RunRecord {
    const d = this.dialect;
    const activity = deserializeJson<AgentActivity>(row.activity, {
      filesCreated: [], filesEdited: [], toolCalls: 0, totalTokens: 0, lastUpdate: "",
    }, d);

    return {
      id: row.id,
      taskId: row.taskId,
      pid: row.pid,
      agentName: row.agentName,
      sessionId: row.sessionId ?? activity.sessionId,
      status: row.status as RunStatus,
      startedAt: row.startedAt,
      updatedAt: row.updatedAt,
      activity,
      result: deserializeJson<TaskResult | undefined>(row.result, undefined, d),
      outcomes: deserializeJson<TaskOutcome[] | undefined>(row.outcomes, undefined, d),
      config: deserializeJson<RunnerConfig | undefined>(row.config, undefined, d),
      configPath: row.configPath,
      user: row.user ?? undefined,
      resumeState: deserializeJson<LoopResumeState | undefined>(row.resumeState, undefined, d),
      executionMode: row.executionMode ?? undefined,
      engine: row.engine ?? undefined,
      delivery: row.delivery ?? undefined,
      completedAt: row.completedAt ?? undefined,
      collectedAt: row.collectedAt ?? undefined,
    };
  }

  async upsertRun(run: RunRecord): Promise<void> {
    const d = this.dialect;
    const values = {
      id: run.id,
      taskId: run.taskId,
      pid: run.pid,
      agentName: run.agentName,
      adapterType: "sdk",
      sessionId: run.sessionId ?? null,
      status: run.status,
      startedAt: run.startedAt,
      updatedAt: run.updatedAt,
      activity: serializeJson(run.activity, d),
      result: serializeJson(run.result, d),
      outcomes: serializeJson(run.outcomes, d),
      config: serializeJson(run.config, d),
      configPath: run.configPath,
      user: run.user ?? null,
      resumeState: serializeJson(run.resumeState, d),
      executionMode: run.executionMode ?? null,
      engine: run.engine ?? "agent",
      delivery: run.delivery ?? null,
      completedAt: run.completedAt ?? null,
      collectedAt: run.collectedAt ?? null,
    };
    const conflictSet: Record<string, unknown> = {
      pid: values.pid,
      sessionId: values.sessionId,
      status: values.status,
      updatedAt: values.updatedAt,
      activity: values.activity,
      result: values.result,
      outcomes: values.outcomes,
      configPath: values.configPath,
    };
    if (run.config !== undefined) conflictSet.config = values.config;
    if (run.executionMode !== undefined) conflictSet.executionMode = values.executionMode;
    if (run.engine !== undefined) conflictSet.engine = values.engine;
    if (run.delivery !== undefined) conflictSet.delivery = values.delivery;

    await this.db.insert(this.runs).values(values)
      .onConflictDoUpdate({
        target: this.runs.id,
        // resumeState/collectedAt deliberately stay out: a runner
        // re-registering itself must not erase checkpoints or acknowledgements.
        set: conflictSet,
      });
  }

  async updateResumeState(runId: string, state: LoopResumeState): Promise<void> {
    await this.db.update(this.runs).set({
      resumeState: serializeJson(state, this.dialect),
      updatedAt: new Date().toISOString(),
    }).where(eq(this.runs.id, runId));
  }

  async updateSpawnInfo(runId: string, pid: number, configPath: string): Promise<void> {
    await this.db.update(this.runs).set({
      pid,
      configPath,
      updatedAt: new Date().toISOString(),
    }).where(eq(this.runs.id, runId));
  }

  async updateActivity(runId: string, activity: AgentActivity): Promise<void> {
    const now = new Date().toISOString();
    await this.db.update(this.runs).set({
      activity: serializeJson(activity, this.dialect),
      sessionId: activity.sessionId ?? null,
      updatedAt: now,
    }).where(eq(this.runs.id, runId));
  }

  async updateOutcomes(runId: string, outcomes: TaskOutcome[]): Promise<void> {
    await this.db.update(this.runs).set({
      outcomes: serializeJson(outcomes, this.dialect),
      updatedAt: new Date().toISOString(),
    }).where(eq(this.runs.id, runId));
  }

  async completeRun(runId: string, status: RunStatus, result: TaskResult): Promise<void> {
    // Race-condition guard: don't overwrite terminal states
    const rows: any[] = await this.db.select({ status: this.runs.status })
      .from(this.runs).where(eq(this.runs.id, runId));
    if (rows.length > 0 && TERMINAL_STATUSES.includes(rows[0].status as RunStatus)) {
      return;
    }

    const now = new Date().toISOString();
    await this.db.update(this.runs).set({
      status,
      result: serializeJson(result, this.dialect),
      updatedAt: now,
      completedAt: now,
    }).where(eq(this.runs.id, runId));
  }

  async markRunCollected(runId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.update(this.runs).set({
      collectedAt: now,
      updatedAt: now,
    }).where(eq(this.runs.id, runId));
  }

  async getRun(runId: string): Promise<RunRecord | undefined> {
    const rows: any[] = await this.db.select().from(this.runs)
      .where(eq(this.runs.id, runId));
    return rows.length > 0 ? this.rowToRecord(rows[0]) : undefined;
  }

  async getRunByTaskId(taskId: string): Promise<RunRecord | undefined> {
    // Scope to task rows (engine != "graph"): once loop_runs folds into this
    // table (F2), loop rows share it but are never task-run results.
    const rows: any[] = await this.db.select().from(this.runs)
      .where(and(
        eq(this.runs.taskId, taskId),
        or(isNull(this.runs.engine), ne(this.runs.engine, "graph")),
      ))
      .orderBy(desc(this.runs.startedAt), desc(this.runs.updatedAt))
      .limit(1);
    return rows.length > 0 ? this.rowToRecord(rows[0]) : undefined;
  }

  async getActiveRuns(): Promise<RunRecord[]> {
    // engine-scoped: the orchestrator reaper iterates these — it must never see
    // (and re-spawn / delete) project-loop rows folded into `runs` (F2).
    const rows: any[] = await this.db.select().from(this.runs)
      .where(and(
        eq(this.runs.status, "running"),
        or(isNull(this.runs.engine), ne(this.runs.engine, "graph")),
        or(isNull(this.runs.delivery), ne(this.runs.delivery, "stream")),
      ));
    return rows.map((r) => this.rowToRecord(r));
  }

  async getTerminalRuns(): Promise<RunRecord[]> {
    const rows: any[] = await this.db.select().from(this.runs)
      .where(and(
        inArray(this.runs.status, TERMINAL_STATUSES),
        or(isNull(this.runs.engine), ne(this.runs.engine, "graph")),
        or(isNull(this.runs.delivery), ne(this.runs.delivery, "stream")),
        isNull(this.runs.collectedAt),
      ));
    return rows.map((r) => this.rowToRecord(r));
  }

  async deleteRun(runId: string): Promise<void> {
    await this.db.delete(this.runs).where(eq(this.runs.id, runId));
  }

  async close(): Promise<void> {
    // Connection lifecycle managed externally
  }
}
