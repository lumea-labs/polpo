import { and, desc, eq, sql } from "drizzle-orm";
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

const LOOP_RESULT_ENVELOPE_VERSION = 1;

interface LoopResultEnvelope {
  __polpoLoopResult: 1;
  data?: unknown;
  presentation?: LoopRunRecord["presentation"];
}

function isLoopResultEnvelope(value: unknown): value is LoopResultEnvelope {
  return Boolean(
    value
    && typeof value === "object"
    && (value as Record<string, unknown>).__polpoLoopResult === LOOP_RESULT_ENVELOPE_VERSION,
  );
}

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
    const storedResult = deserializeJson<unknown>(row.result, undefined, this.dialect);
    const resultEnvelope = this.targetsRuns && isLoopResultEnvelope(storedResult)
      ? storedResult
      : undefined;
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
      result: resultEnvelope ? resultEnvelope.data : storedResult,
      presentation: resultEnvelope
        ? resultEnvelope.presentation
        : deserializeJson(row.presentation, undefined, this.dialect),
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
    const encodedEvent = JSON.stringify(event);
    const eventId = typeof event.id === "string" && event.id.length > 0
      ? event.id
      : undefined;
    const pgTrace = sql`case
      when ${this.loopRuns.trace} is null then '[]'::jsonb
      when jsonb_typeof(${this.loopRuns.trace}) = 'array' then ${this.loopRuns.trace}
      when jsonb_typeof(${this.loopRuns.trace}) = 'string'
        and left(ltrim(${this.loopRuns.trace} #>> '{}'), 1) = '['
        and right(rtrim(${this.loopRuns.trace} #>> '{}'), 1) = ']'
        then (${this.loopRuns.trace} #>> '{}')::jsonb
      else '[]'::jsonb
    end`;
    const pgAppendedTrace = sql`${pgTrace} || jsonb_build_array(${encodedEvent}::jsonb)`;
    const sqliteTrace = sql`coalesce(${this.loopRuns.trace}, '[]')`;
    const sqliteAppendedTrace = sql`json_insert(${sqliteTrace}, '$[#]', json(${encodedEvent}))`;
    const trace = this.dialect === "pg"
      ? eventId
        ? sql`case
            when exists (
              select 1
              from jsonb_array_elements(${pgTrace}) as trace_event(value)
              where trace_event.value ->> 'id' = ${eventId}
            ) then ${pgTrace}
            else ${pgAppendedTrace}
          end`
        : pgAppendedTrace
      : eventId
        ? sql`case
            when exists (
              select 1
              from json_each(${sqliteTrace})
              where json_extract(value, '$.id') = ${eventId}
            ) then ${sqliteTrace}
            else ${sqliteAppendedTrace}
          end`
        : sqliteAppendedTrace;

    await this.db.update(this.loopRuns).set({
      trace,
      updatedAt: new Date().toISOString(),
    }).where(this.runWhere(runId));
  }

  async updateRun(runId: string, patch: Partial<Omit<LoopRunRecord, "id" | "startedAt">>): Promise<LoopRunRecord | undefined> {
    if (
      this.targetsRuns
      && (Object.prototype.hasOwnProperty.call(patch, "result")
        !== Object.prototype.hasOwnProperty.call(patch, "presentation"))
    ) {
      const current = await this.getRun(runId);
      if (current) {
        patch = {
          ...patch,
          result: Object.prototype.hasOwnProperty.call(patch, "result") ? patch.result : current.result,
          presentation: Object.prototype.hasOwnProperty.call(patch, "presentation")
            ? patch.presentation
            : current.presentation,
        };
      }
    }
    await this.db.update(this.loopRuns)
      .set(this.patchToValues(patch))
      .where(this.runWhere(runId));
    return this.getRun(runId);
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
        result: serializeJson({
          __polpoLoopResult: LOOP_RESULT_ENVELOPE_VERSION,
          data: run.result,
          presentation: run.presentation,
        }, this.dialect),
        resumeState: serializeJson(run.resume, this.dialect),
      };
    }
    return {
      ...base,
      agentName: run.agentName ?? null,
      result: serializeJson(run.result, this.dialect),
      presentation: serializeJson(run.presentation, this.dialect),
      resume: serializeJson(run.resume, this.dialect),
    };
  }

  private runWhere(runId: string): any {
    return this.targetsRuns
      ? and(eq(this.loopRuns.id, runId), eq(this.loopRuns.engine, "graph"))
      : eq(this.loopRuns.id, runId);
  }

  private patchToValues(
    patch: Partial<Omit<LoopRunRecord, "id" | "startedAt">>,
  ): Record<string, unknown> {
    const values: Record<string, unknown> = {
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    };
    const owns = (key: keyof typeof patch): boolean =>
      Object.prototype.hasOwnProperty.call(patch, key);

    if (patch.loopName !== undefined) values.loopName = patch.loopName;
    if (patch.agentName !== undefined) values.agentName = patch.agentName;
    if (owns("sessionId")) values.sessionId = patch.sessionId ?? null;
    if (owns("user")) values.user = patch.user ?? null;
    if (patch.status !== undefined) values.status = patch.status;
    if (patch.context !== undefined) values.context = serializeJson(patch.context, this.dialect);
    if (patch.trace !== undefined) values.trace = serializeJson(patch.trace, this.dialect);
    if (owns("error")) values.error = patch.error ?? null;
    if (owns("approvalRequestId")) values.approvalRequestId = patch.approvalRequestId ?? null;
    if (owns("approval")) values.approval = serializeJson(patch.approval, this.dialect);
    if (owns("metadata")) values.metadata = serializeJson(patch.metadata, this.dialect);
    if (owns("result") || owns("presentation")) {
      if (this.targetsRuns) {
        values.result = serializeJson({
          __polpoLoopResult: LOOP_RESULT_ENVELOPE_VERSION,
          data: patch.result,
          presentation: patch.presentation,
        }, this.dialect);
      } else {
        if (owns("result")) values.result = serializeJson(patch.result, this.dialect);
        if (owns("presentation")) {
          values.presentation = serializeJson(patch.presentation, this.dialect);
        }
      }
    }
    if (owns("completedAt")) values.completedAt = patch.completedAt ?? null;
    if (owns("resume")) {
      values[this.targetsRuns ? "resumeState" : "resume"] = serializeJson(
        patch.resume,
        this.dialect,
      );
    }
    return values;
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
