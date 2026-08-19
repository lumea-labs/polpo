import { and, asc, count, eq, gt, lte, sql } from "drizzle-orm";
import {
  DEFAULT_RUN_EVENT_PAGE_SIZE,
  MAX_RUN_EVENT_BATCH_SIZE,
  MAX_RUN_EVENT_PAGE_SIZE,
  RunDeliveryValidationError,
  RunEventConflictError,
  RunExecutionLeaseValidationError,
  RUN_STREAM_EVENT_SCHEMA_VERSION,
  formatRunEventCursor,
  materializeRunStreamEvent,
  normalizeRunExecutionLease,
  normalizeRunCancellationRequest,
  normalizeRunStreamEventInput,
  parseRunEventCursor,
  runStreamEventMatchesInput,
  validateRunDeliveryRunId,
  type AppendRunStreamEvent,
  type NormalizedRunStreamEventInput,
  type RunEventBounds,
  type RunEventPage,
  type RunEventStore,
  type RunExecutionLease,
  type RunExecutionLeaseStore,
  type RunCancellationRequest,
  type RunCancellationStore,
  type RunStreamEvent,
} from "@polpo-ai/core/run-delivery";
import { deserializeJson, serializeJson, type Dialect } from "../utils.js";

type RunEventTables = {
  sequences: any;
  events: any;
};

export interface DrizzleRunEventStoreOptions {
  now?: () => Date;
  maxInsertAttempts?: number;
}

export class DrizzleRunEventStore implements RunEventStore {
  private readonly now: () => Date;
  private readonly maxInsertAttempts: number;

  constructor(
    private readonly db: any,
    private readonly tables: RunEventTables,
    private readonly dialect: Dialect,
    options: DrizzleRunEventStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.maxInsertAttempts = options.maxInsertAttempts ?? 3;
    if (!Number.isInteger(this.maxInsertAttempts) || this.maxInsertAttempts < 1) {
      throw new RunDeliveryValidationError("maxInsertAttempts must be a positive integer");
    }
  }

  async append(runId: string, input: AppendRunStreamEvent): Promise<RunStreamEvent> {
    const normalized = normalizeRunStreamEventInput(runId, input, { now: this.now });
    if (normalized.id) {
      const existing = await this.getByEventId(runId, normalized.id);
      if (existing) return this.resolveProducerRetry(existing, normalized);
    }

    for (let attempt = 0; attempt < this.maxInsertAttempts; attempt += 1) {
      const sequence = await this.allocateSequence(runId);
      const event = materializeRunStreamEvent(runId, sequence, normalized);
      const inserted: any[] = await this.db.insert(this.tables.events).values({
        runId: event.runId,
        sequence: event.sequence,
        eventId: event.id,
        schemaVersion: event.schemaVersion,
        type: event.type,
        data: serializeJson(event.data, this.dialect),
        createdAt: event.createdAt,
      }).onConflictDoNothing().returning();
      if (inserted[0]) return this.rowToEvent(inserted[0]);

      const existing = await this.getByEventId(runId, event.id);
      if (existing) return this.resolveProducerRetry(existing, normalized);
    }

    throw new RunEventConflictError(
      `Could not append a unique event to run ${runId} after ${this.maxInsertAttempts} attempts`,
    );
  }

  async appendMany(
    runId: string,
    inputs: readonly AppendRunStreamEvent[],
  ): Promise<RunStreamEvent[]> {
    if (inputs.length === 0) return [];
    if (inputs.length > MAX_RUN_EVENT_BATCH_SIZE) {
      throw new RunDeliveryValidationError(
        `Run event batch cannot exceed ${MAX_RUN_EVENT_BATCH_SIZE} events`,
      );
    }
    const normalized = inputs.map((input) =>
      normalizeRunStreamEventInput(runId, input, { now: this.now })
    );

    // Explicit producer IDs require retry/conflict reconciliation. Keep that
    // uncommon path on the existing strict append implementation; streamed
    // response chunks use generated IDs and take the atomic range fast path.
    if (normalized.some((event) => event.id !== undefined)) {
      const events: RunStreamEvent[] = [];
      for (const input of inputs) events.push(await this.append(runId, input));
      return events;
    }

    const lastSequence = await this.allocateSequenceRange(runId, normalized.length);
    const firstSequence = lastSequence - normalized.length + 1;
    const events = normalized.map((event, index) =>
      materializeRunStreamEvent(runId, firstSequence + index, event)
    );
    const rows: any[] = await this.db.insert(this.tables.events).values(events.map((event) => ({
      runId: event.runId,
      sequence: event.sequence,
      eventId: event.id,
      schemaVersion: event.schemaVersion,
      type: event.type,
      data: serializeJson(event.data, this.dialect),
      createdAt: event.createdAt,
    }))).returning();
    if (rows.length !== events.length) {
      throw new RunEventConflictError(
        `Could not append complete event batch to run ${runId}`,
      );
    }
    return rows.map((row) => this.rowToEvent(row))
      .sort((left, right) => left.sequence - right.sequence);
  }

  async listAfter(
    runId: string,
    cursor?: string,
    limit = DEFAULT_RUN_EVENT_PAGE_SIZE,
  ): Promise<RunEventPage> {
    validateRunDeliveryRunId(runId);
    const sequence = parseRunEventCursor(cursor);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RUN_EVENT_PAGE_SIZE) {
      throw new RunDeliveryValidationError(
        `Run event page limit must be between 1 and ${MAX_RUN_EVENT_PAGE_SIZE}`,
      );
    }
    const rows: any[] = await this.db.select().from(this.tables.events)
      .where(and(
        eq(this.tables.events.runId, runId),
        gt(this.tables.events.sequence, sequence),
      ))
      .orderBy(asc(this.tables.events.sequence))
      .limit(limit + 1);
    const selected = rows.slice(0, limit).map((row) => this.rowToEvent(row));
    const lastSequence = selected.at(-1)?.sequence ?? sequence;
    return {
      events: selected,
      nextCursor: formatRunEventCursor(lastSequence),
      hasMore: rows.length > limit,
    };
  }

  async bounds(runId: string): Promise<RunEventBounds | null> {
    validateRunDeliveryRunId(runId);
    const rows: any[] = await this.db.select({
      count: count(),
      first: sql<number | null>`min(${this.tables.events.sequence})`,
      last: sql<number | null>`max(${this.tables.events.sequence})`,
    }).from(this.tables.events).where(eq(this.tables.events.runId, runId));
    const row = rows[0];
    const eventCount = Number(row?.count ?? 0);
    if (eventCount === 0 || row?.first == null || row?.last == null) return null;
    return {
      firstCursor: formatRunEventCursor(Number(row.first)),
      lastCursor: formatRunEventCursor(Number(row.last)),
      count: eventCount,
    };
  }

  private async allocateSequence(runId: string): Promise<number> {
    return this.allocateSequenceRange(runId, 1);
  }

  private async allocateSequenceRange(runId: string, count: number): Promise<number> {
    if (!Number.isSafeInteger(count) || count < 1 || count > MAX_RUN_EVENT_BATCH_SIZE) {
      throw new RunDeliveryValidationError(
        `Run event sequence range must be between 1 and ${MAX_RUN_EVENT_BATCH_SIZE}`,
      );
    }
    const rows: any[] = await this.db.insert(this.tables.sequences).values({
      runId,
      lastSequence: count,
    }).onConflictDoUpdate({
      target: this.tables.sequences.runId,
      set: { lastSequence: sql`${this.tables.sequences.lastSequence} + ${count}` },
    }).returning({ sequence: this.tables.sequences.lastSequence });
    const sequence = Number(rows[0]?.sequence);
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      throw new RunDeliveryValidationError("Allocated run event sequence is invalid");
    }
    return sequence;
  }

  private async getByEventId(runId: string, eventId: string): Promise<RunStreamEvent | null> {
    const rows: any[] = await this.db.select().from(this.tables.events).where(and(
      eq(this.tables.events.runId, runId),
      eq(this.tables.events.eventId, eventId),
    )).limit(1);
    return rows[0] ? this.rowToEvent(rows[0]) : null;
  }

  private resolveProducerRetry(
    existing: RunStreamEvent,
    normalized: NormalizedRunStreamEventInput,
  ): RunStreamEvent {
    if (!runStreamEventMatchesInput(existing, normalized)) {
      throw new RunEventConflictError(
        `Run event ${existing.id} already exists with different content`,
      );
    }
    return existing;
  }

  private rowToEvent(row: any): RunStreamEvent {
    if (Number(row.schemaVersion) !== RUN_STREAM_EVENT_SCHEMA_VERSION) {
      throw new RunDeliveryValidationError(
        `Unsupported run event schema version ${String(row.schemaVersion)}`,
      );
    }
    return materializeRunStreamEvent(
      row.runId,
      Number(row.sequence),
      {
        id: row.eventId,
        type: row.type,
        data: deserializeJson(row.data, {}, this.dialect),
        createdAt: row.createdAt,
        createdAtExplicit: true,
      },
    );
  }
}

export interface DrizzleRunExecutionLeaseStoreOptions {
  now?: () => Date;
}

export class DrizzleRunExecutionLeaseStore implements RunExecutionLeaseStore {
  private readonly now: () => Date;

  constructor(
    private readonly db: any,
    private readonly leases: any,
    options: DrizzleRunExecutionLeaseStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async claim(runId: string, input: RunExecutionLease): Promise<boolean> {
    const now = this.currentTime();
    const lease = normalizeRunExecutionLease(runId, input, { now, requireFuture: true });
    const timestamp = now.toISOString();
    const inserted: any[] = await this.db.insert(this.leases).values({
      runId,
      ...lease,
      updatedAt: timestamp,
    }).onConflictDoNothing().returning();
    if (inserted[0]) return true;

    const current = await this.get(runId);
    if (current && this.sameLease(current, lease)) return true;

    const replaced: any[] = await this.db.update(this.leases).set({
      ...lease,
      updatedAt: timestamp,
    }).where(and(
      eq(this.leases.runId, runId),
      lte(this.leases.expiresAt, timestamp),
    )).returning();
    if (replaced[0]) return true;

    const winner = await this.get(runId);
    return winner !== null && this.sameLease(winner, lease);
  }

  async renew(runId: string, input: RunExecutionLease): Promise<boolean> {
    const now = this.currentTime();
    const lease = normalizeRunExecutionLease(runId, input, { now, requireFuture: true });
    const current = await this.get(runId);
    if (!current || current.owner !== lease.owner || current.token !== lease.token) return false;
    if (Date.parse(current.expiresAt) <= now.getTime()) return false;
    if (Date.parse(lease.expiresAt) < Date.parse(current.expiresAt)) {
      throw new RunExecutionLeaseValidationError("A run execution lease cannot be shortened");
    }
    const rows: any[] = await this.db.update(this.leases).set({
      expiresAt: lease.expiresAt,
      updatedAt: now.toISOString(),
    }).where(and(
      eq(this.leases.runId, runId),
      eq(this.leases.owner, lease.owner),
      eq(this.leases.token, lease.token),
      gt(this.leases.expiresAt, now.toISOString()),
      lte(this.leases.expiresAt, lease.expiresAt),
    )).returning();
    return rows.length > 0;
  }

  async release(runId: string, input: RunExecutionLease): Promise<boolean> {
    const lease = normalizeRunExecutionLease(runId, input, {
      now: this.currentTime(),
      requireFuture: false,
    });
    const rows: any[] = await this.db.delete(this.leases).where(and(
      eq(this.leases.runId, runId),
      eq(this.leases.owner, lease.owner),
      eq(this.leases.token, lease.token),
    )).returning();
    return rows.length > 0;
  }

  async get(runId: string): Promise<RunExecutionLease | null> {
    validateRunDeliveryRunId(runId);
    const rows: any[] = await this.db.select().from(this.leases)
      .where(eq(this.leases.runId, runId)).limit(1);
    const row = rows[0];
    return row ? {
      owner: row.owner,
      token: row.token,
      expiresAt: row.expiresAt,
    } : null;
  }

  private currentTime(): Date {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new RunDeliveryValidationError("Run execution lease clock returned an invalid date");
    }
    return value;
  }

  private sameLease(left: RunExecutionLease, right: RunExecutionLease): boolean {
    return left.owner === right.owner
      && left.token === right.token
      && left.expiresAt === right.expiresAt;
  }
}

export class DrizzleRunCancellationStore implements RunCancellationStore {
  constructor(
    private readonly db: any,
    private readonly requests: any,
  ) {}

  async request(runId: string, input: RunCancellationRequest): Promise<RunCancellationRequest> {
    const request = normalizeRunCancellationRequest(runId, input);
    await this.db.insert(this.requests).values({
      runId,
      requestedAt: request.requestedAt,
      reason: request.reason ?? null,
    }).onConflictDoNothing();
    const persisted = await this.get(runId);
    if (!persisted) {
      throw new RunDeliveryValidationError("Run cancellation request was not persisted");
    }
    return persisted;
  }

  async get(runId: string): Promise<RunCancellationRequest | null> {
    validateRunDeliveryRunId(runId);
    const rows: any[] = await this.db.select().from(this.requests)
      .where(eq(this.requests.runId, runId)).limit(1);
    const row = rows[0];
    return row ? {
      requestedAt: row.requestedAt,
      ...(row.reason == null ? {} : { reason: row.reason }),
    } : null;
  }

  async clear(runId: string): Promise<boolean> {
    validateRunDeliveryRunId(runId);
    const rows: any[] = await this.db.delete(this.requests)
      .where(eq(this.requests.runId, runId)).returning();
    return rows.length > 0;
  }
}
