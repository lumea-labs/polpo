import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import type {
  ModelInvocationListFilter,
  ModelInvocationStore,
} from "@polpo-ai/core/model-invocation-store";
import type { ModelInvocationRecord } from "@polpo-ai/core/model-runtime";
import { type Dialect, deserializeJson, serializeJson } from "../utils.js";

type AnyTable = any;

function dateToIso(value: Date | undefined): string {
  return (value ?? new Date()).toISOString();
}

function isoToDate(value: unknown): Date | undefined {
  return typeof value === "string" ? new Date(value) : undefined;
}

export class DrizzleModelInvocationStore implements ModelInvocationStore {
  constructor(
    private db: any,
    private table: AnyTable,
    private dialect: Dialect,
  ) {}

  private rowToRecord(row: any): ModelInvocationRecord {
    return {
      id: row.id,
      projectId: row.projectId ?? undefined,
      orgId: row.orgId ?? undefined,
      runId: row.runId ?? undefined,
      sessionId: row.sessionId ?? undefined,
      turnId: row.turnId ?? undefined,
      agentName: row.agentName ?? undefined,
      externalUser: row.externalUser ?? undefined,
      mode: row.mode,
      operation: row.operation,
      requestedProvider: row.requestedProvider ?? undefined,
      requestedModel: row.requestedModel,
      resolvedProvider: row.resolvedProvider ?? undefined,
      resolvedModel: row.resolvedModel ?? undefined,
      finalProvider: row.finalProvider ?? undefined,
      attemptIndex: row.attemptIndex ?? undefined,
      attemptCount: row.attemptCount ?? undefined,
      generationId: row.generationId ?? undefined,
      credentialType: row.credentialType ?? undefined,
      status: row.status,
      errorClass: row.errorClass ?? undefined,
      errorMessage: row.errorMessage ?? undefined,
      inputTokens: row.inputTokens ?? undefined,
      outputTokens: row.outputTokens ?? undefined,
      reasoningTokens: row.reasoningTokens ?? undefined,
      cachedTokens: row.cachedTokens ?? undefined,
      audioInputSeconds: row.audioInputSeconds ?? undefined,
      audioOutputSeconds: row.audioOutputSeconds ?? undefined,
      imageCount: row.imageCount ?? undefined,
      videoSeconds: row.videoSeconds ?? undefined,
      estimatedCostUsd: row.estimatedCostUsd ?? undefined,
      billableCostUsd: row.billableCostUsd ?? undefined,
      costSource: row.costSource,
      billingOwner: row.billingOwner,
      rawMetadata: deserializeJson(row.rawMetadata, undefined, this.dialect),
      createdAt: isoToDate(row.createdAt),
    };
  }

  private recordToRow(record: ModelInvocationRecord): Record<string, unknown> {
    return {
      id: record.id ?? nanoid(),
      projectId: record.projectId ?? null,
      orgId: record.orgId ?? null,
      runId: record.runId ?? null,
      sessionId: record.sessionId ?? null,
      turnId: record.turnId ?? null,
      agentName: record.agentName ?? null,
      externalUser: record.externalUser ?? null,
      mode: record.mode,
      operation: record.operation,
      requestedProvider: record.requestedProvider ?? null,
      requestedModel: record.requestedModel,
      resolvedProvider: record.resolvedProvider ?? null,
      resolvedModel: record.resolvedModel ?? null,
      finalProvider: record.finalProvider ?? null,
      attemptIndex: record.attemptIndex ?? null,
      attemptCount: record.attemptCount ?? null,
      generationId: record.generationId ?? null,
      credentialType: record.credentialType ?? null,
      status: record.status,
      errorClass: record.errorClass ?? null,
      errorMessage: record.errorMessage ?? null,
      inputTokens: record.inputTokens ?? null,
      outputTokens: record.outputTokens ?? null,
      reasoningTokens: record.reasoningTokens ?? null,
      cachedTokens: record.cachedTokens ?? null,
      audioInputSeconds: record.audioInputSeconds ?? null,
      audioOutputSeconds: record.audioOutputSeconds ?? null,
      imageCount: record.imageCount ?? null,
      videoSeconds: record.videoSeconds ?? null,
      estimatedCostUsd: record.estimatedCostUsd ?? null,
      billableCostUsd: record.billableCostUsd ?? null,
      costSource: record.costSource,
      billingOwner: record.billingOwner,
      rawMetadata: serializeJson(record.rawMetadata, this.dialect),
      createdAt: dateToIso(record.createdAt),
    };
  }

  async append(record: ModelInvocationRecord): Promise<ModelInvocationRecord> {
    const row = this.recordToRow(record);
    await this.db.insert(this.table).values(row).onConflictDoUpdate({
      target: this.table.id,
      set: row,
    });
    return this.rowToRecord(row);
  }

  async get(id: string): Promise<ModelInvocationRecord | undefined> {
    const rows: any[] = await this.db.select().from(this.table).where(eq(this.table.id, id));
    return rows.length > 0 ? this.rowToRecord(rows[0]) : undefined;
  }

  async list(filter: ModelInvocationListFilter = {}): Promise<ModelInvocationRecord[]> {
    const predicates = [
      filter.projectId ? eq(this.table.projectId, filter.projectId) : undefined,
      filter.orgId ? eq(this.table.orgId, filter.orgId) : undefined,
      filter.runId ? eq(this.table.runId, filter.runId) : undefined,
      filter.sessionId ? eq(this.table.sessionId, filter.sessionId) : undefined,
      filter.agentName ? eq(this.table.agentName, filter.agentName) : undefined,
      filter.mode ? eq(this.table.mode, filter.mode) : undefined,
      filter.operation ? eq(this.table.operation, filter.operation) : undefined,
      filter.status ? eq(this.table.status, filter.status) : undefined,
    ].filter(Boolean);

    const query = this.db
      .select()
      .from(this.table)
      .where(predicates.length > 0 ? and(...predicates) : undefined)
      .orderBy(desc(this.table.createdAt));

    const rows: any[] = filter.limit ? await query.limit(filter.limit) : await query;
    return rows.map((row) => this.rowToRecord(row));
  }

  async close(): Promise<void> {
    // Connection lifecycle managed externally.
  }
}
