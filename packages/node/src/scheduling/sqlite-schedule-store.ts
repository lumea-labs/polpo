import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import { nanoid } from "nanoid";
import {
  ScheduleConflictError,
  ScheduleInvalidStateError,
  ScheduleNotFoundError,
  assertSameScheduleOccurrence,
  assertScheduleRunStatusTransition,
  assertScheduleStatusTransition,
  isTerminalScheduleRunStatus,
  normalizeCompleteScheduleRunInput,
  normalizeCreateScheduleInput,
  normalizeCreateScheduleRunInput,
  normalizeScheduleLease,
  normalizeScheduleOperationalStatePatch,
  normalizeUpdateScheduleInput,
  type CompleteScheduleRunInput,
  type CreateScheduleInput,
  type CreateScheduleRunInput,
  type Schedule,
  type ScheduleFilter,
  type ScheduleLease,
  type ScheduleMutationOptions,
  type ScheduleOperationalStatePatch,
  type ScheduleRun,
  type ScheduleRunFilter,
  type ScheduleRunStatus,
  type ScheduleStatus,
  type ScheduleStore,
  type UpdateScheduleInput,
} from "@polpo-ai/core/scheduling";

interface SQLiteScheduleStoreOptions {
  now?: () => Date | string;
  createId?: (kind: "schedule" | "schedule-run") => string;
}

interface ScheduleRow {
  id: string;
  status: string;
  surface: string;
  revision: number;
  created_at: string;
  updated_at: string;
  data: string;
}

interface RunRow {
  id: string;
  schedule_id: string;
  idempotency_key: string;
  status: string;
  attempts: number;
  occurrence_at: string;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  created_at: string;
  updated_at: string;
  data: string;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS polpo_schedules_v2 (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    surface TEXT NOT NULL,
    revision INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    data TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS polpo_schedules_v2_status_idx
    ON polpo_schedules_v2 (status, updated_at);
  CREATE INDEX IF NOT EXISTS polpo_schedules_v2_surface_idx
    ON polpo_schedules_v2 (surface, created_at);

  CREATE TABLE IF NOT EXISTS polpo_schedule_runs_v2 (
    id TEXT PRIMARY KEY,
    schedule_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL,
    occurrence_at TEXT NOT NULL,
    lease_owner TEXT,
    lease_token TEXT,
    lease_expires_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    data TEXT NOT NULL,
    FOREIGN KEY (schedule_id) REFERENCES polpo_schedules_v2(id)
  );

  CREATE INDEX IF NOT EXISTS polpo_schedule_runs_v2_schedule_idx
    ON polpo_schedule_runs_v2 (schedule_id, occurrence_at DESC);
  CREATE INDEX IF NOT EXISTS polpo_schedule_runs_v2_status_idx
    ON polpo_schedule_runs_v2 (status, occurrence_at);
  CREATE INDEX IF NOT EXISTS polpo_schedule_runs_v2_lease_idx
    ON polpo_schedule_runs_v2 (lease_expires_at)
    WHERE lease_expires_at IS NOT NULL;
`;

/**
 * Durable local ScheduleStore backed by SQLite.
 *
 * The optional native dependency is loaded only by `open()`, so importing the
 * rest of @polpo-ai/node remains safe in environments without better-sqlite3.
 */
export class SQLiteScheduleStore implements ScheduleStore {
  private readonly nowProvider: () => Date | string;
  private readonly createId: (kind: "schedule" | "schedule-run") => string;

  private constructor(
    private readonly db: BetterSqlite3.Database,
    options: SQLiteScheduleStoreOptions,
  ) {
    this.nowProvider = options.now ?? (() => new Date());
    this.createId = options.createId ?? ((kind) => `${kind}-${nanoid()}`);
  }

  static async open(
    path: string,
    options: SQLiteScheduleStoreOptions = {},
  ): Promise<SQLiteScheduleStore> {
    if (typeof path !== "string" || !path.trim()) {
      throw new Error("SQLite schedule store path must be a non-empty string");
    }
    if (path !== ":memory:") {
      await mkdir(dirname(path), { recursive: true });
    }

    let Database: typeof import("better-sqlite3");
    try {
      Database = (await import("better-sqlite3")).default;
    } catch (error) {
      throw new Error(
        "SQLite schedules require the optional better-sqlite3 dependency",
        { cause: error },
      );
    }
    const db = new Database(path);
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    if (path !== ":memory:") db.pragma("journal_mode = WAL");
    db.exec(SCHEMA);
    return new SQLiteScheduleStore(db, options);
  }

  async create(input: CreateScheduleInput): Promise<Schedule> {
    const now = this.now();
    const normalized = normalizeCreateScheduleInput(input, { now });
    const id = normalized.id ?? this.createId("schedule");
    const schedule: Schedule = {
      id,
      ...(normalized.name === undefined ? {} : { name: normalized.name }),
      ...(normalized.description === undefined
        ? {}
        : { description: normalized.description }),
      timing: normalized.timing,
      invocation: normalized.invocation,
      status: normalized.status,
      policy: normalized.policy,
      metadata: normalized.metadata,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      revision: 1,
    };

    try {
      this.insertSchedule(schedule);
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ScheduleConflictError(`Schedule "${id}" already exists`);
      }
      throw error;
    }
    return clone(schedule);
  }

  async list(filter: ScheduleFilter = {}): Promise<Schedule[]> {
    const statuses = statusSet(filter.status);
    return this.db.prepare(
      "SELECT * FROM polpo_schedules_v2 ORDER BY created_at ASC, id ASC",
    ).all()
      .map((row) => decodeSchedule(row as ScheduleRow))
      .filter((schedule) =>
        (filter.includeDeleted || schedule.status !== "deleted")
        && (!statuses || statuses.has(schedule.status))
        && (!filter.surface || schedule.invocation.surface === filter.surface)
      )
      .map(clone);
  }

  async get(id: string): Promise<Schedule | null> {
    const row = this.db.prepare(
      "SELECT * FROM polpo_schedules_v2 WHERE id = ?",
    ).get(id) as ScheduleRow | undefined;
    return row ? clone(decodeSchedule(row)) : null;
  }

  async update(
    id: string,
    patch: UpdateScheduleInput,
    options: ScheduleMutationOptions = {},
  ): Promise<Schedule> {
    return this.db.transaction(() => {
      const existing = this.requireSchedule(id);
      assertExpectedRevision(existing, options.expectedRevision);
      if (existing.status === "deleted") {
        throw new ScheduleInvalidStateError(`Schedule "${id}" is deleted`);
      }
      const now = this.now();
      const normalized = normalizeUpdateScheduleInput(patch, { now });
      const status = normalized.status ?? existing.status;
      try {
        assertScheduleStatusTransition(existing.status, status);
      } catch (error) {
        throw new ScheduleInvalidStateError(errorMessage(error));
      }
      const updated: Schedule = {
        ...existing,
        ...(normalized.timing === undefined ? {} : { timing: normalized.timing }),
        ...(normalized.invocation === undefined
          ? {}
          : { invocation: normalized.invocation }),
        ...(normalized.status === undefined ? {} : { status: normalized.status }),
        ...(normalized.policy === undefined
          ? {}
          : { policy: { ...existing.policy, ...normalized.policy } }),
        ...(normalized.metadata === undefined
          ? {}
          : { metadata: normalized.metadata }),
        revision: existing.revision + 1,
        updatedAt: now.toISOString(),
      };
      applyNullableString(updated, "name", normalized.name);
      applyNullableString(updated, "description", normalized.description);
      const changes = this.db.prepare(`
        UPDATE polpo_schedules_v2
        SET status = ?, surface = ?, revision = ?, updated_at = ?, data = ?
        WHERE id = ? AND revision = ?
      `).run(
        updated.status,
        updated.invocation.surface,
        updated.revision,
        updated.updatedAt,
        JSON.stringify(updated),
        id,
        existing.revision,
      ).changes;
      if (changes !== 1) {
        throw new ScheduleConflictError(`Schedule "${id}" revision conflict`);
      }
      return clone(updated);
    })();
  }

  async markDeleted(
    id: string,
    options: ScheduleMutationOptions = {},
  ): Promise<void> {
    this.db.transaction(() => {
      const existing = this.requireSchedule(id);
      assertExpectedRevision(existing, options.expectedRevision);
      if (existing.status === "deleted") return;
      try {
        assertScheduleStatusTransition(existing.status, "deleted");
      } catch (error) {
        throw new ScheduleInvalidStateError(errorMessage(error));
      }
      const deleted: Schedule = {
        ...existing,
        status: "deleted",
        revision: existing.revision + 1,
        updatedAt: this.now().toISOString(),
      };
      const changes = this.db.prepare(`
        UPDATE polpo_schedules_v2
        SET status = ?, revision = ?, updated_at = ?, data = ?
        WHERE id = ? AND revision = ?
      `).run(
        deleted.status,
        deleted.revision,
        deleted.updatedAt,
        JSON.stringify(deleted),
        id,
        existing.revision,
      ).changes;
      if (changes !== 1) {
        throw new ScheduleConflictError(`Schedule "${id}" revision conflict`);
      }
    })();
  }

  async updateOperationalState(
    id: string,
    patch: ScheduleOperationalStatePatch,
    options: ScheduleMutationOptions = {},
  ): Promise<Schedule> {
    return this.db.transaction(() => {
      const existing = this.requireSchedule(id);
      assertExpectedRevision(existing, options.expectedRevision);
      const normalized = normalizeScheduleOperationalStatePatch(patch);
      const updated: Schedule = {
        ...existing,
        revision: existing.revision + 1,
        updatedAt: this.now().toISOString(),
      };
      applyOperationalField(
        updated,
        "nextOccurrenceAt",
        normalized.nextOccurrenceAt,
      );
      applyOperationalField(
        updated,
        "lastOccurrenceAt",
        normalized.lastOccurrenceAt,
      );
      applyOperationalField(updated, "driver", normalized.driver);
      const changes = this.db.prepare(`
        UPDATE polpo_schedules_v2
        SET revision = ?, updated_at = ?, data = ?
        WHERE id = ? AND revision = ?
      `).run(
        updated.revision,
        updated.updatedAt,
        JSON.stringify(updated),
        id,
        existing.revision,
      ).changes;
      if (changes !== 1) {
        throw new ScheduleConflictError(`Schedule "${id}" revision conflict`);
      }
      return clone(updated);
    })();
  }

  async createRun(input: CreateScheduleRunInput): Promise<ScheduleRun> {
    return this.db.transaction(() => {
      const normalized = normalizeCreateScheduleRunInput(input);
      const duplicate = this.getRunByIdempotencyKey(normalized.idempotencyKey);
      if (duplicate) {
        assertSameScheduleOccurrence(duplicate, normalized);
        return clone(duplicate);
      }
      const schedule = this.requireSchedule(normalized.scheduleId);
      if (schedule.status !== "active") {
        throw new ScheduleInvalidStateError(
          `Schedule "${schedule.id}" is not active`,
        );
      }
      const now = this.now().toISOString();
      const run: ScheduleRun = {
        id: normalized.id ?? this.createId("schedule-run"),
        scheduleId: normalized.scheduleId,
        occurrenceAt: normalized.occurrenceAt,
        triggerId: normalized.triggerId,
        idempotencyKey: normalized.idempotencyKey,
        status: "pending",
        attempts: 0,
        references: {},
        createdAt: now,
        updatedAt: now,
      };
      try {
        this.insertRun(run);
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
        const racedDuplicate = this.getRunByIdempotencyKey(run.idempotencyKey);
        if (racedDuplicate) {
          assertSameScheduleOccurrence(racedDuplicate, normalized);
          return clone(racedDuplicate);
        }
        throw new ScheduleConflictError(
          `Schedule run "${run.id}" already exists`,
        );
      }
      return clone(run);
    })();
  }

  async getRun(id: string): Promise<ScheduleRun | null> {
    const row = this.db.prepare(
      "SELECT * FROM polpo_schedule_runs_v2 WHERE id = ?",
    ).get(id) as RunRow | undefined;
    return row ? clone(decodeRun(row)) : null;
  }

  async listRuns(filter: ScheduleRunFilter = {}): Promise<ScheduleRun[]> {
    const statuses = runStatusSet(filter.status);
    const limit = normalizeLimit(filter.limit);
    return this.db.prepare(`
      SELECT * FROM polpo_schedule_runs_v2
      ORDER BY occurrence_at DESC, created_at DESC
    `).all()
      .map((row) => decodeRun(row as RunRow))
      .filter((run) =>
        (!filter.scheduleId || run.scheduleId === filter.scheduleId)
        && (!statuses || statuses.has(run.status))
      )
      .slice(0, limit)
      .map(clone);
  }

  async claimRun(id: string, lease: ScheduleLease): Promise<ScheduleRun | null> {
    return this.db.transaction(() => {
      const now = this.now();
      const normalizedLease = normalizeScheduleLease(lease, now);
      const run = this.requireRun(id);
      if (isTerminalScheduleRunStatus(run.status)) return null;
      if (this.requireSchedule(run.scheduleId).status !== "active") return null;
      if (
        (run.status === "claimed" || run.status === "running")
        && run.lease
        && Date.parse(run.lease.expiresAt) > now.getTime()
      ) {
        return null;
      }
      if (!["pending", "claimed", "running"].includes(run.status)) return null;
      try {
        assertScheduleRunStatusTransition(run.status, "claimed");
      } catch (error) {
        throw new ScheduleInvalidStateError(errorMessage(error));
      }
      const claimed: ScheduleRun = {
        ...run,
        status: "claimed",
        attempts: run.attempts + 1,
        lease: normalizedLease,
        updatedAt: now.toISOString(),
      };
      if (!this.casRun(run, claimed)) return null;
      return clone(claimed);
    })();
  }

  async renewLease(id: string, lease: ScheduleLease): Promise<boolean> {
    return this.db.transaction(() => {
      const now = this.now();
      const normalizedLease = normalizeScheduleLease(lease, now);
      const run = this.requireRun(id);
      if (
        !activeRun(run)
        || !run.lease
        || !leasesMatch(run.lease, normalizedLease)
        || Date.parse(run.lease.expiresAt) <= now.getTime()
        || Date.parse(normalizedLease.expiresAt) < Date.parse(run.lease.expiresAt)
      ) {
        return false;
      }
      const renewed: ScheduleRun = {
        ...run,
        lease: normalizedLease,
        updatedAt: now.toISOString(),
      };
      return this.casRun(run, renewed);
    })();
  }

  async startRun(id: string, lease: ScheduleLease): Promise<ScheduleRun> {
    return this.db.transaction(() => {
      const now = this.now();
      const normalizedLease = normalizeScheduleLease(lease, now);
      const run = this.requireOwnedRun(id, normalizedLease, now);
      if (run.status !== "claimed") {
        throw new ScheduleInvalidStateError(
          `Schedule run "${id}" must be claimed before it can start`,
        );
      }
      const started: ScheduleRun = {
        ...run,
        status: "running",
        lease: normalizedLease,
        startedAt: run.startedAt ?? now.toISOString(),
        updatedAt: now.toISOString(),
      };
      if (!this.casRun(run, started)) {
        throw new ScheduleConflictError(`Schedule run "${id}" changed while starting`);
      }
      return clone(started);
    })();
  }

  async releaseRun(id: string, lease: ScheduleLease): Promise<ScheduleRun> {
    return this.db.transaction(() => {
      const now = this.now();
      const normalizedLease = normalizeScheduleLease(lease, now);
      const run = this.requireOwnedRun(id, normalizedLease, now);
      const released: ScheduleRun = {
        ...run,
        status: "pending",
        updatedAt: now.toISOString(),
      };
      delete released.lease;
      if (!this.casRun(run, released)) {
        throw new ScheduleConflictError(`Schedule run "${id}" changed while releasing`);
      }
      return clone(released);
    })();
  }

  async completeRun(
    id: string,
    input: CompleteScheduleRunInput,
  ): Promise<ScheduleRun> {
    return this.db.transaction(() => {
      const now = this.now();
      const completion = normalizeCompleteScheduleRunInput(input, now);
      const run = this.requireRun(id);
      if (isTerminalScheduleRunStatus(run.status)) {
        throw new ScheduleConflictError(`Schedule run "${id}" is already terminal`);
      }
      const owned = this.requireOwnedRun(id, completion.lease, now);
      try {
        assertScheduleRunStatusTransition(owned.status, completion.status);
      } catch (error) {
        throw new ScheduleInvalidStateError(errorMessage(error));
      }
      const completed: ScheduleRun = {
        ...owned,
        status: completion.status,
        references: completion.references,
        ...(completion.result === undefined ? {} : { result: completion.result }),
        ...(completion.error === undefined ? {} : { error: completion.error }),
        completedAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
      delete completed.lease;
      if (!this.casRun(owned, completed)) {
        throw new ScheduleConflictError(`Schedule run "${id}" changed while completing`);
      }
      return clone(completed);
    })();
  }

  async countActiveRuns(scheduleId: string): Promise<number> {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM polpo_schedule_runs_v2
      WHERE schedule_id = ?
        AND status IN ('claimed', 'running')
        AND lease_expires_at > ?
    `).get(scheduleId, this.now().toISOString()) as { count: number };
    return Number(row.count);
  }

  close(): void {
    this.db.close();
  }

  private insertSchedule(schedule: Schedule): void {
    this.db.prepare(`
      INSERT INTO polpo_schedules_v2 (
        id, status, surface, revision, created_at, updated_at, data
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      schedule.id,
      schedule.status,
      schedule.invocation.surface,
      schedule.revision,
      schedule.createdAt,
      schedule.updatedAt,
      JSON.stringify(schedule),
    );
  }

  private insertRun(run: ScheduleRun): void {
    this.db.prepare(`
      INSERT INTO polpo_schedule_runs_v2 (
        id, schedule_id, idempotency_key, status, attempts, occurrence_at,
        lease_owner, lease_token, lease_expires_at, created_at, updated_at, data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.id,
      run.scheduleId,
      run.idempotencyKey,
      run.status,
      run.attempts,
      run.occurrenceAt,
      run.lease?.owner ?? null,
      run.lease?.token ?? null,
      run.lease?.expiresAt ?? null,
      run.createdAt,
      run.updatedAt,
      JSON.stringify(run),
    );
  }

  private casRun(previous: ScheduleRun, next: ScheduleRun): boolean {
    const changes = this.db.prepare(`
      UPDATE polpo_schedule_runs_v2
      SET status = ?, attempts = ?, lease_owner = ?, lease_token = ?,
          lease_expires_at = ?, updated_at = ?, data = ?
      WHERE id = ? AND status = ? AND attempts = ? AND updated_at = ?
        AND COALESCE(lease_owner, '') = ?
        AND COALESCE(lease_token, '') = ?
        AND COALESCE(lease_expires_at, '') = ?
    `).run(
      next.status,
      next.attempts,
      next.lease?.owner ?? null,
      next.lease?.token ?? null,
      next.lease?.expiresAt ?? null,
      next.updatedAt,
      JSON.stringify(next),
      previous.id,
      previous.status,
      previous.attempts,
      previous.updatedAt,
      previous.lease?.owner ?? "",
      previous.lease?.token ?? "",
      previous.lease?.expiresAt ?? "",
    ).changes;
    return changes === 1;
  }

  private requireSchedule(id: string): Schedule {
    const row = this.db.prepare(
      "SELECT * FROM polpo_schedules_v2 WHERE id = ?",
    ).get(id) as ScheduleRow | undefined;
    if (!row) throw new ScheduleNotFoundError("Schedule", id);
    return decodeSchedule(row);
  }

  private requireRun(id: string): ScheduleRun {
    const row = this.db.prepare(
      "SELECT * FROM polpo_schedule_runs_v2 WHERE id = ?",
    ).get(id) as RunRow | undefined;
    if (!row) throw new ScheduleNotFoundError("Schedule run", id);
    return decodeRun(row);
  }

  private getRunByIdempotencyKey(key: string): ScheduleRun | null {
    const row = this.db.prepare(
      "SELECT * FROM polpo_schedule_runs_v2 WHERE idempotency_key = ?",
    ).get(key) as RunRow | undefined;
    return row ? decodeRun(row) : null;
  }

  private requireOwnedRun(
    id: string,
    lease: ScheduleLease,
    now: Date,
  ): ScheduleRun {
    const run = this.requireRun(id);
    if (!activeRun(run) || !run.lease || !leasesMatch(run.lease, lease)) {
      throw new ScheduleConflictError(
        `Schedule run "${id}" is not owned by this lease`,
      );
    }
    if (Date.parse(run.lease.expiresAt) <= now.getTime()) {
      throw new ScheduleConflictError(`Schedule run "${id}" lease has expired`);
    }
    return run;
  }

  private now(): Date {
    const now = new Date(this.nowProvider());
    if (!Number.isFinite(now.getTime())) {
      throw new ScheduleInvalidStateError(
        "SQLite schedule store clock returned an invalid date",
      );
    }
    return now;
  }
}

function decodeSchedule(row: ScheduleRow): Schedule {
  const schedule = parseRecord<Schedule>(row.data, `schedule "${row.id}"`);
  if (
    schedule.id !== row.id
    || schedule.status !== row.status
    || schedule.invocation?.surface !== row.surface
    || schedule.revision !== row.revision
    || schedule.createdAt !== row.created_at
    || schedule.updatedAt !== row.updated_at
  ) {
    throw new ScheduleInvalidStateError(
      `Persisted schedule "${row.id}" does not match its index columns`,
    );
  }
  return schedule;
}

function decodeRun(row: RunRow): ScheduleRun {
  const run = parseRecord<ScheduleRun>(row.data, `schedule run "${row.id}"`);
  if (
    run.id !== row.id
    || run.scheduleId !== row.schedule_id
    || run.idempotencyKey !== row.idempotency_key
    || run.status !== row.status
    || run.attempts !== row.attempts
    || run.occurrenceAt !== row.occurrence_at
    || run.createdAt !== row.created_at
    || run.updatedAt !== row.updated_at
    || (run.lease?.owner ?? null) !== row.lease_owner
    || (run.lease?.token ?? null) !== row.lease_token
    || (run.lease?.expiresAt ?? null) !== row.lease_expires_at
  ) {
    throw new ScheduleInvalidStateError(
      `Persisted schedule run "${row.id}" does not match its index columns`,
    );
  }
  return run;
}

function parseRecord<T>(raw: string, label: string): T {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected an object");
    }
    return parsed as T;
  } catch (error) {
    throw new ScheduleInvalidStateError(
      `Failed to decode persisted ${label}: ${errorMessage(error)}`,
    );
  }
}

function assertExpectedRevision(
  schedule: Schedule,
  expected: number | undefined,
): void {
  if (expected === undefined) return;
  if (!Number.isInteger(expected) || expected < 1) {
    throw new Error("Schedule expectedRevision must be a positive integer");
  }
  if (schedule.revision !== expected) {
    throw new ScheduleConflictError(
      `Schedule "${schedule.id}" revision conflict: expected ${expected}, found ${schedule.revision}`,
    );
  }
}

function applyNullableString(
  schedule: Schedule,
  key: "name" | "description",
  value: string | null | undefined,
): void {
  if (value === undefined) return;
  if (value === null) delete schedule[key];
  else schedule[key] = value;
}

function applyOperationalField<
  K extends "nextOccurrenceAt" | "lastOccurrenceAt" | "driver",
>(
  schedule: Schedule,
  key: K,
  value: Schedule[K] | null | undefined,
): void {
  if (value === undefined) return;
  if (value === null) delete schedule[key];
  else schedule[key] = value;
}

function statusSet(
  status: ScheduleFilter["status"],
): Set<ScheduleStatus> | undefined {
  if (status === undefined) return undefined;
  return new Set(Array.isArray(status) ? status : [status]);
}

function runStatusSet(
  status: ScheduleRunFilter["status"],
): Set<ScheduleRunStatus> | undefined {
  if (status === undefined) return undefined;
  return new Set(Array.isArray(status) ? status : [status]);
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return Number.POSITIVE_INFINITY;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error("Schedule run list limit must be an integer between 1 and 1000");
  }
  return limit;
}

function activeRun(run: ScheduleRun): boolean {
  return run.status === "claimed" || run.status === "running";
}

function leasesMatch(a: ScheduleLease, b: ScheduleLease): boolean {
  return a.owner === b.owner && a.token === b.token;
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error
    && /UNIQUE constraint failed|PRIMARY KEY constraint failed/i.test(error.message);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
