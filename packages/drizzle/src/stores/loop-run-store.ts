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
      resume: deserializeJson(row.resume, undefined, this.dialect),
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
    const rows: any[] = await this.db.select().from(this.loopRuns).where(eq(this.loopRuns.id, id)).limit(1);
    return rows[0] ? this.rowToRecord(rows[0]) : undefined;
  }

  async listRuns(filter: LoopRunListFilter = {}): Promise<LoopRunRecord[]> {
    const clauses = [];
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
    return {
      id: run.id,
      loopName: run.loopName,
      agentName: run.agentName ?? null,
      sessionId: run.sessionId ?? null,
      user: run.user ?? null,
      status: run.status,
      context: serializeJson(run.context, this.dialect),
      trace: serializeJson(run.trace, this.dialect),
      error: run.error ?? null,
      approvalRequestId: run.approvalRequestId ?? null,
      approval: serializeJson(run.approval, this.dialect),
      resume: serializeJson(run.resume, this.dialect),
      metadata: serializeJson(run.metadata, this.dialect),
      startedAt: run.startedAt,
      updatedAt: run.updatedAt,
      completedAt: run.completedAt ?? null,
    };
  }
}
