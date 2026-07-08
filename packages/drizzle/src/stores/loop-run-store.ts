import { and, desc, eq } from "drizzle-orm";
import type {
  CreateLoopRunInput,
  LoopRunListFilter,
  LoopRunRecord,
  ProjectLoopRunStatus,
  LoopRunStore,
} from "@polpo-ai/core/loop-run-store";
import type { ContextBag, LoopTraceEvent } from "@polpo-ai/core";
import { type Dialect, deserializeJson, serializeJson } from "../utils.js";

type AnyTable = any;

export class DrizzleLoopRunStore implements LoopRunStore {
  constructor(
    private db: any,
    private loopRuns: AnyTable,
    private dialect: Dialect,
    /** When true, `loopRuns` is actually the unified `runs` table (F2 fold):
     *  records are written with engine="graph" + task-column sentinels, `resume`
     *  maps to the `resume_state` column, and reads/lists scope to engine="graph"
     *  so task rows in the same table are never returned. */
    private targetsRuns: boolean = false,
  ) {}

  private rowToRecord(row: any): LoopRunRecord {
    return {
      id: row.id,
      loopName: row.loopName,
      agentName: row.agentName ?? undefined,
      sessionId: row.sessionId ?? undefined,
      user: row.user ?? undefined,
      status: row.status as ProjectLoopRunStatus,
      context: deserializeJson<ContextBag>(row.context, {}, this.dialect),
      trace: deserializeJson<LoopTraceEvent[]>(row.trace, [], this.dialect),
      error: row.error ?? undefined,
      approvalRequestId: row.approvalRequestId ?? undefined,
      approval: deserializeJson(row.approval, undefined, this.dialect),
      resume: deserializeJson(this.targetsRuns ? row.resumeState : row.resume, undefined, this.dialect),
      metadata: deserializeJson(row.metadata, undefined, this.dialect),
      startedAt: row.startedAt,
      updatedAt: row.updatedAt,
      completedAt: row.completedAt ?? undefined,
    };
  }

  async createRun(input: CreateLoopRunInput): Promise<LoopRunRecord> {
    const now = new Date().toISOString();
    const run: LoopRunRecord = {
      id: input.id,
      loopName: input.loop.name,
      agentName: input.agentName,
      sessionId: input.sessionId,
      user: input.user,
      status: "running",
      context: input.context ?? {},
      trace: [],
      metadata: {
        ...input.loop.metadata,
        ...input.metadata,
      },
      startedAt: now,
      updatedAt: now,
    };
    await this.db.insert(this.loopRuns).values(this.recordToValues(run))
      .onConflictDoUpdate({
        target: this.loopRuns.id,
        set: this.recordToValues(run),
      });
    return run;
  }

  async getRun(id: string): Promise<LoopRunRecord | undefined> {
    const where = this.targetsRuns
      ? and(eq(this.loopRuns.id, id), eq(this.loopRuns.engine, "graph"))
      : eq(this.loopRuns.id, id);
    const rows: any[] = await this.db.select().from(this.loopRuns).where(where).limit(1);
    return rows[0] ? this.rowToRecord(rows[0]) : undefined;
  }

  async listRuns(filter: LoopRunListFilter = {}): Promise<LoopRunRecord[]> {
    const clauses = [];
    if (this.targetsRuns) clauses.push(eq(this.loopRuns.engine, "graph"));
    if (filter.loopName) clauses.push(eq(this.loopRuns.loopName, filter.loopName));
    if (filter.agentName) clauses.push(eq(this.loopRuns.agentName, filter.agentName));
    if (filter.sessionId) clauses.push(eq(this.loopRuns.sessionId, filter.sessionId));
    if (filter.user) clauses.push(eq(this.loopRuns.user, filter.user));
    if (filter.status) clauses.push(eq(this.loopRuns.status, filter.status));

    let query = this.db.select().from(this.loopRuns).orderBy(desc(this.loopRuns.startedAt));
    if (clauses.length > 0) query = query.where(and(...clauses));
    if (filter.limit) query = query.limit(filter.limit);

    const rows: any[] = await query;
    return rows.map((row) => this.rowToRecord(row));
  }

  async appendTrace(runId: string, event: LoopTraceEvent): Promise<void> {
    const run = await this.getRun(runId);
    if (!run) return;
    await this.updateRun(runId, { trace: [...run.trace, event] });
  }

  async updateRun(runId: string, patch: Partial<Omit<LoopRunRecord, "id" | "startedAt">>): Promise<LoopRunRecord | undefined> {
    const current = await this.getRun(runId);
    if (!current) return undefined;
    const updated: LoopRunRecord = {
      ...current,
      ...patch,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    };
    await this.db.update(this.loopRuns)
      .set(this.recordToValues(updated))
      .where(eq(this.loopRuns.id, runId));
    return updated;
  }

  async close(): Promise<void> {
    // Connection lifecycle managed externally.
  }

  private recordToValues(run: LoopRunRecord): Record<string, unknown> {
    const base: Record<string, unknown> = {
      id: run.id,
      loopName: run.loopName,
      sessionId: run.sessionId ?? null,
      user: run.user ?? null,
      status: run.status,
      context: serializeJson(run.context, this.dialect),
      trace: serializeJson(run.trace, this.dialect),
      error: run.error ?? null,
      approvalRequestId: run.approvalRequestId ?? null,
      approval: serializeJson(run.approval, this.dialect),
      metadata: serializeJson(run.metadata, this.dialect),
      startedAt: run.startedAt,
      updatedAt: run.updatedAt,
      completedAt: run.completedAt ?? null,
    };
    if (this.targetsRuns) {
      // Writing a loop record into the unified `runs` table: fill the NOT-NULL
      // task columns with sentinels, tag engine="graph", and map resume →
      // resume_state (the column `runs` already has).
      return {
        ...base,
        agentName: run.agentName ?? "", // runs.agent_name is NOT NULL
        taskId: run.id,
        adapterType: "loop",
        configPath: "",
        engine: "graph",
        resumeState: serializeJson(run.resume, this.dialect),
      };
    }
    return {
      ...base,
      agentName: run.agentName ?? null,
      resume: serializeJson(run.resume, this.dialect),
    };
  }
}

/**
 * Dual-write LoopRunStore for the F2 transition. Writes go to BOTH the legacy
 * `loop_runs` store and the shadow `runs`-backed store; the shadow write is
 * best-effort (a shadow failure never fails the request). Reads come from
 * `readFrom` — "legacy" during dual-write, flipped to "shadow" once loop_runs
 * is backfilled into `runs`. When the shadow is the sole source, this wrapper
 * is dropped and the plain runs-backed store is used directly (PR5).
 */
export class DualWriteLoopRunStore implements LoopRunStore {
  constructor(
    private legacy: LoopRunStore,
    private shadow: LoopRunStore,
    private readFrom: "legacy" | "shadow" = "legacy",
  ) {}

  private async shadowBestEffort(op: () => Promise<unknown>): Promise<void> {
    try { await op(); } catch { /* shadow write must never fail the request */ }
  }

  async createRun(input: CreateLoopRunInput): Promise<LoopRunRecord> {
    const run = await this.legacy.createRun(input);
    await this.shadowBestEffort(() => this.shadow.createRun(input));
    return run;
  }

  async appendTrace(runId: string, event: LoopTraceEvent): Promise<void> {
    await this.legacy.appendTrace(runId, event);
    await this.shadowBestEffort(() => this.shadow.appendTrace(runId, event));
  }

  async updateRun(runId: string, patch: Partial<Omit<LoopRunRecord, "id" | "startedAt">>): Promise<LoopRunRecord | undefined> {
    const updated = await this.legacy.updateRun(runId, patch);
    await this.shadowBestEffort(() => this.shadow.updateRun(runId, patch));
    return updated;
  }

  getRun(id: string): Promise<LoopRunRecord | undefined> {
    return (this.readFrom === "shadow" ? this.shadow : this.legacy).getRun(id);
  }

  listRuns(filter?: LoopRunListFilter): Promise<LoopRunRecord[]> {
    return (this.readFrom === "shadow" ? this.shadow : this.legacy).listRuns(filter);
  }

  async close(): Promise<void> {
    await this.legacy.close?.();
    await this.shadow.close?.();
  }
}
