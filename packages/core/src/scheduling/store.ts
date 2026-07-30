import { nanoid } from "nanoid";
import {
  assertScheduleRunStatusTransition,
  assertScheduleStatusTransition,
  isTerminalScheduleRunStatus,
} from "./state-machine.js";
import type {
  CreateScheduleInput,
  Schedule,
  ScheduleDriverRegistration,
  ScheduleJsonValue,
  ScheduleLease,
  ScheduleMetadata,
  ScheduleRun,
  ScheduleRunError,
  ScheduleRunReferences,
  ScheduleRunStatus,
  ScheduleStatus,
  UpdateScheduleInput,
} from "./types.js";
import {
  normalizeCreateScheduleInput,
  normalizeScheduleMetadata,
  normalizeUpdateScheduleInput,
} from "./validation.js";

export interface ScheduleFilter {
  status?: ScheduleStatus | ScheduleStatus[];
  surface?: Schedule["invocation"]["surface"];
  includeDeleted?: boolean;
}

export interface ScheduleRunFilter {
  scheduleId?: string;
  status?: ScheduleRunStatus | ScheduleRunStatus[];
  limit?: number;
  order?: "asc" | "desc";
}

export interface ScheduleMutationOptions {
  expectedRevision?: number;
}

export interface CreateScheduleRunInput {
  id?: string;
  scheduleId: string;
  occurrenceAt: string;
  triggerId: string;
  idempotencyKey: string;
}

export interface CompleteScheduleRunInput {
  lease: ScheduleLease;
  status: Extract<
    ScheduleRunStatus,
    "succeeded" | "failed" | "skipped" | "cancelled"
  >;
  references: ScheduleRunReferences;
  result?: ScheduleMetadata;
  error?: ScheduleRunError;
}

export interface ScheduleOperationalStatePatch {
  nextOccurrenceAt?: string | null;
  lastOccurrenceAt?: string | null;
  driver?: ScheduleDriverRegistration | null;
}

export interface ScheduleStore {
  create(input: CreateScheduleInput): Promise<Schedule>;
  list(filter?: ScheduleFilter): Promise<Schedule[]>;
  get(id: string): Promise<Schedule | null>;
  update(
    id: string,
    patch: UpdateScheduleInput,
    options?: ScheduleMutationOptions,
  ): Promise<Schedule>;
  markDeleted(id: string, options?: ScheduleMutationOptions): Promise<void>;
  updateOperationalState(
    id: string,
    patch: ScheduleOperationalStatePatch,
    options?: ScheduleMutationOptions,
  ): Promise<Schedule>;

  createRun(input: CreateScheduleRunInput): Promise<ScheduleRun>;
  getRun(id: string): Promise<ScheduleRun | null>;
  listRuns(filter?: ScheduleRunFilter): Promise<ScheduleRun[]>;
  claimRun(id: string, lease: ScheduleLease): Promise<ScheduleRun | null>;
  renewLease(id: string, lease: ScheduleLease): Promise<boolean>;
  startRun(id: string, lease: ScheduleLease): Promise<ScheduleRun>;
  releaseRun(id: string, lease: ScheduleLease): Promise<ScheduleRun>;
  completeRun(id: string, input: CompleteScheduleRunInput): Promise<ScheduleRun>;
  countActiveRuns(scheduleId: string): Promise<number>;
}

export interface InMemoryScheduleStoreOptions {
  now?: () => Date | string;
  createId?: (kind: "schedule" | "schedule-run") => string;
}

export class ScheduleStoreError extends Error {
  constructor(
    message: string,
    readonly code: "NOT_FOUND" | "CONFLICT" | "INVALID_STATE",
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ScheduleNotFoundError extends ScheduleStoreError {
  constructor(entity: "Schedule" | "Schedule run", id: string) {
    super(`${entity} "${id}" was not found`, "NOT_FOUND");
  }
}

export class ScheduleConflictError extends ScheduleStoreError {
  constructor(message: string) {
    super(message, "CONFLICT");
  }
}

export class ScheduleInvalidStateError extends ScheduleStoreError {
  constructor(message: string) {
    super(message, "INVALID_STATE");
  }
}

export class InMemoryScheduleStore implements ScheduleStore {
  private readonly schedules = new Map<string, Schedule>();
  private readonly runs = new Map<string, ScheduleRun>();
  private readonly runIdsByIdempotencyKey = new Map<string, string>();
  private readonly options: Required<InMemoryScheduleStoreOptions>;

  constructor(options: InMemoryScheduleStoreOptions = {}) {
    this.options = {
      now: options.now ?? (() => new Date()),
      createId: options.createId ?? ((kind) => `${kind}-${nanoid()}`),
    };
  }

  async create(input: CreateScheduleInput): Promise<Schedule> {
    const now = this.now();
    const normalized = normalizeCreateScheduleInput(input, { now });
    const id = normalized.id ?? this.options.createId("schedule");
    if (this.schedules.has(id)) {
      throw new ScheduleConflictError(`Schedule "${id}" already exists`);
    }

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
    this.schedules.set(id, clone(schedule));
    return clone(schedule);
  }

  async list(filter: ScheduleFilter = {}): Promise<Schedule[]> {
    const statuses = normalizeStatusFilter(filter.status);
    return [...this.schedules.values()]
      .filter((schedule) =>
        (filter.includeDeleted || schedule.status !== "deleted")
        && (!statuses || statuses.has(schedule.status))
        && (!filter.surface || schedule.invocation.surface === filter.surface)
      )
      .sort(compareCreated)
      .map(clone);
  }

  async get(id: string): Promise<Schedule | null> {
    const schedule = this.schedules.get(id);
    return schedule ? clone(schedule) : null;
  }

  async update(
    id: string,
    patch: UpdateScheduleInput,
    options: ScheduleMutationOptions = {},
  ): Promise<Schedule> {
    const existing = this.requireSchedule(id);
    assertRevision(existing, options.expectedRevision);
    if (existing.status === "deleted") {
      throw new ScheduleInvalidStateError(`Schedule "${id}" is deleted`);
    }

    const now = this.now();
    const normalized = normalizeUpdateScheduleInput(patch, { now });
    const nextStatus = normalized.status ?? existing.status;
    try {
      assertScheduleStatusTransition(existing.status, nextStatus);
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
      updatedAt: now.toISOString(),
      revision: existing.revision + 1,
    };
    applyNullableStringPatch(updated, "name", normalized.name);
    applyNullableStringPatch(updated, "description", normalized.description);
    this.schedules.set(id, clone(updated));
    return clone(updated);
  }

  async markDeleted(
    id: string,
    options: ScheduleMutationOptions = {},
  ): Promise<void> {
    const existing = this.requireSchedule(id);
    assertRevision(existing, options.expectedRevision);
    if (existing.status === "deleted") return;
    try {
      assertScheduleStatusTransition(existing.status, "deleted");
    } catch (error) {
      throw new ScheduleInvalidStateError(errorMessage(error));
    }
    const now = this.now().toISOString();
    this.schedules.set(id, {
      ...existing,
      status: "deleted",
      updatedAt: now,
      revision: existing.revision + 1,
    });
  }

  async updateOperationalState(
    id: string,
    patch: ScheduleOperationalStatePatch,
    options: ScheduleMutationOptions = {},
  ): Promise<Schedule> {
    const existing = this.requireSchedule(id);
    assertRevision(existing, options.expectedRevision);
    const normalized = normalizeScheduleOperationalStatePatch(patch);
    const updated: Schedule = {
      ...existing,
      revision: existing.revision + 1,
      updatedAt: this.now().toISOString(),
    };
    applyNullableField(updated, "nextOccurrenceAt", normalized.nextOccurrenceAt);
    applyNullableField(updated, "lastOccurrenceAt", normalized.lastOccurrenceAt);
    applyNullableField(updated, "driver", normalized.driver);
    this.schedules.set(id, clone(updated));
    return clone(updated);
  }

  async createRun(input: CreateScheduleRunInput): Promise<ScheduleRun> {
    const normalized = normalizeCreateScheduleRunInput(input);
    const duplicateId = this.runIdsByIdempotencyKey.get(normalized.idempotencyKey);
    if (duplicateId) {
      const duplicate = this.runs.get(duplicateId);
      if (!duplicate) {
        throw new ScheduleInvalidStateError(
          `Schedule run idempotency index is corrupted for "${normalized.idempotencyKey}"`,
        );
      }
      assertSameScheduleOccurrence(duplicate, normalized);
      return clone(duplicate);
    }

    const schedule = this.requireSchedule(normalized.scheduleId);
    if (schedule.status !== "active") {
      throw new ScheduleInvalidStateError(
        `Schedule "${schedule.id}" is not active`,
      );
    }

    const id = normalized.id ?? this.options.createId("schedule-run");
    if (this.runs.has(id)) {
      throw new ScheduleConflictError(`Schedule run "${id}" already exists`);
    }
    const now = this.now().toISOString();
    const run: ScheduleRun = {
      id,
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
    this.runs.set(id, clone(run));
    this.runIdsByIdempotencyKey.set(run.idempotencyKey, id);
    return clone(run);
  }

  async getRun(id: string): Promise<ScheduleRun | null> {
    const run = this.runs.get(id);
    return run ? clone(run) : null;
  }

  async listRuns(filter: ScheduleRunFilter = {}): Promise<ScheduleRun[]> {
    const statuses = normalizeRunStatusFilter(filter.status);
    const limit = normalizeLimit(filter.limit);
    const direction = normalizeRunOrder(filter.order);
    return [...this.runs.values()]
      .filter((run) =>
        (!filter.scheduleId || run.scheduleId === filter.scheduleId)
        && (!statuses || statuses.has(run.status))
      )
      .sort((a, b) => direction * (
        a.occurrenceAt.localeCompare(b.occurrenceAt)
        || a.createdAt.localeCompare(b.createdAt)
        || a.id.localeCompare(b.id)
      ))
      .slice(0, limit)
      .map(clone);
  }

  async claimRun(id: string, lease: ScheduleLease): Promise<ScheduleRun | null> {
    const now = this.now();
    const normalizedLease = normalizeScheduleLease(lease, now);
    const run = this.requireRun(id);
    if (isTerminalScheduleRunStatus(run.status)) return null;
    const schedule = this.requireSchedule(run.scheduleId);
    if (schedule.status !== "active") return null;

    if (
      (run.status === "claimed" || run.status === "running")
      && run.lease
      && Date.parse(run.lease.expiresAt) > now.getTime()
    ) {
      return null;
    }
    if (
      run.status !== "pending"
      && run.status !== "claimed"
      && run.status !== "running"
    ) {
      return null;
    }
    const activeRuns = [...this.runs.values()].filter((candidate) =>
      candidate.id !== run.id
      && candidate.scheduleId === run.scheduleId
      && isActiveRun(candidate)
      && Boolean(candidate.lease)
      && Date.parse(candidate.lease!.expiresAt) > now.getTime()
    ).length;
    if (activeRuns >= schedule.policy.maxConcurrency) return null;

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
    this.runs.set(id, clone(claimed));
    return clone(claimed);
  }

  async renewLease(id: string, lease: ScheduleLease): Promise<boolean> {
    const now = this.now();
    const normalizedLease = normalizeScheduleLease(lease, now);
    const run = this.requireRun(id);
    if (!isActiveRun(run) || !leaseMatches(run.lease, normalizedLease)) return false;
    if (!run.lease || Date.parse(run.lease.expiresAt) <= now.getTime()) return false;
    if (Date.parse(normalizedLease.expiresAt) < Date.parse(run.lease.expiresAt)) {
      return false;
    }
    this.runs.set(id, {
      ...run,
      lease: normalizedLease,
      updatedAt: now.toISOString(),
    });
    return true;
  }

  async startRun(id: string, lease: ScheduleLease): Promise<ScheduleRun> {
    const now = this.now();
    const normalizedLease = normalizeScheduleLease(lease, now);
    const run = this.requireOwnedActiveRun(id, normalizedLease, now);
    const schedule = this.requireSchedule(run.scheduleId);
    if (schedule.status !== "active") {
      throw new ScheduleInvalidStateError(
        `Schedule "${schedule.id}" is not active`,
      );
    }
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
    this.runs.set(id, clone(started));
    return clone(started);
  }

  async releaseRun(id: string, lease: ScheduleLease): Promise<ScheduleRun> {
    const now = this.now();
    const normalizedLease = normalizeScheduleLease(lease, now);
    const run = this.requireOwnedActiveRun(id, normalizedLease, now);
    const released: ScheduleRun = {
      ...run,
      status: "pending",
      updatedAt: now.toISOString(),
    };
    delete released.lease;
    this.runs.set(id, clone(released));
    return clone(released);
  }

  async completeRun(
    id: string,
    input: CompleteScheduleRunInput,
  ): Promise<ScheduleRun> {
    const now = this.now();
    const completion = normalizeCompleteScheduleRunInput(input, now);
    const run = this.requireRun(id);
    if (isTerminalScheduleRunStatus(run.status)) {
      throw new ScheduleConflictError(`Schedule run "${id}" is already terminal`);
    }
    const owned = this.requireOwnedActiveRun(id, completion.lease, now);
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
    this.runs.set(id, clone(completed));
    return clone(completed);
  }

  async countActiveRuns(scheduleId: string): Promise<number> {
    const now = this.now().getTime();
    return [...this.runs.values()].filter((run) =>
      run.scheduleId === scheduleId
      && isActiveRun(run)
      && Boolean(run.lease)
      && Date.parse(run.lease!.expiresAt) > now
    ).length;
  }

  private requireSchedule(id: string): Schedule {
    const schedule = this.schedules.get(id);
    if (!schedule) throw new ScheduleNotFoundError("Schedule", id);
    return schedule;
  }

  private requireRun(id: string): ScheduleRun {
    const run = this.runs.get(id);
    if (!run) throw new ScheduleNotFoundError("Schedule run", id);
    return run;
  }

  private requireOwnedActiveRun(
    id: string,
    lease: ScheduleLease,
    now: Date,
  ): ScheduleRun {
    const run = this.requireRun(id);
    if (!isActiveRun(run) || !run.lease || !leaseMatches(run.lease, lease)) {
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
    const now = new Date(this.options.now());
    if (!Number.isFinite(now.getTime())) {
      throw new ScheduleInvalidStateError("Schedule store clock returned an invalid date");
    }
    return now;
  }
}

export function normalizeCreateScheduleRunInput(
  input: CreateScheduleRunInput,
): CreateScheduleRunInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Schedule run input must be an object");
  }
  assertOnlyKeys(
    input as unknown as Record<string, unknown>,
    ["id", "scheduleId", "occurrenceAt", "triggerId", "idempotencyKey"],
    "Schedule run input",
  );
  return {
    ...(input.id === undefined ? {} : { id: nonEmpty(input.id, "Schedule run id") }),
    scheduleId: nonEmpty(input.scheduleId, "Schedule run scheduleId"),
    occurrenceAt: absoluteTimestamp(
      input.occurrenceAt,
      "Schedule run occurrenceAt",
    ),
    triggerId: nonEmpty(input.triggerId, "Schedule run triggerId"),
    idempotencyKey: nonEmpty(
      input.idempotencyKey,
      "Schedule run idempotencyKey",
    ),
  };
}

export function normalizeScheduleLease(
  value: ScheduleLease,
  now: Date,
  requireFuture = true,
): ScheduleLease {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Schedule run lease must be an object");
  }
  assertOnlyKeys(
    value as unknown as Record<string, unknown>,
    ["owner", "token", "expiresAt"],
    "Schedule run lease",
  );
  const normalized = {
    owner: nonEmpty(value.owner, "Schedule run lease owner"),
    token: nonEmpty(value.token, "Schedule run lease token"),
    expiresAt: absoluteTimestamp(
      value.expiresAt,
      "Schedule run lease expiresAt",
    ),
  };
  if (requireFuture && Date.parse(normalized.expiresAt) <= now.getTime()) {
    throw new Error("Schedule run lease expiresAt must be in the future");
  }
  return normalized;
}

export function normalizeCompleteScheduleRunInput(
  value: CompleteScheduleRunInput,
  now: Date,
): CompleteScheduleRunInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Schedule run completion must be an object");
  }
  assertOnlyKeys(
    value as unknown as Record<string, unknown>,
    ["lease", "status", "references", "result", "error"],
    "Schedule run completion",
  );
  if (!["succeeded", "failed", "skipped", "cancelled"].includes(value.status)) {
    throw new Error("Schedule run completion status is invalid");
  }
  const references = normalizeReferences(value.references);
  const result = value.result === undefined
    ? undefined
    : normalizeScheduleMetadata(value.result, "Schedule run result");
  const error = value.error === undefined ? undefined : normalizeRunError(value.error);
  if (value.status === "failed" && !error) {
    throw new Error("A failed schedule run completion requires error details");
  }
  if (value.status === "succeeded" && error) {
    throw new Error("A succeeded schedule run completion cannot include an error");
  }
  return {
    lease: normalizeScheduleLease(value.lease, now, false),
    status: value.status,
    references,
    ...(result === undefined ? {} : { result }),
    ...(error === undefined ? {} : { error }),
  };
}

export function normalizeScheduleOperationalStatePatch(
  value: ScheduleOperationalStatePatch,
): ScheduleOperationalStatePatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Schedule operational state patch must be an object");
  }
  assertOnlyKeys(
    value as unknown as Record<string, unknown>,
    ["nextOccurrenceAt", "lastOccurrenceAt", "driver"],
    "Schedule operational state patch",
  );
  if (Object.keys(value).length === 0) {
    throw new Error("Schedule operational state patch must include at least one field");
  }
  return {
    ...(value.nextOccurrenceAt === undefined
      ? {}
      : {
          nextOccurrenceAt: value.nextOccurrenceAt === null
            ? null
            : absoluteTimestamp(
              value.nextOccurrenceAt,
              "Schedule nextOccurrenceAt",
            ),
        }),
    ...(value.lastOccurrenceAt === undefined
      ? {}
      : {
          lastOccurrenceAt: value.lastOccurrenceAt === null
            ? null
            : absoluteTimestamp(
              value.lastOccurrenceAt,
              "Schedule lastOccurrenceAt",
            ),
        }),
    ...(value.driver === undefined
      ? {}
      : {
          driver: value.driver === null
            ? null
            : normalizeDriverRegistration(value.driver),
        }),
  };
}

function normalizeReferences(value: ScheduleRunReferences): ScheduleRunReferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Schedule run references must be an object");
  }
  const allowed = new Set([
    "runtimeId",
    "taskId",
    "loopRunId",
    "sessionId",
    "channelEventId",
    "providerDeliveryId",
  ]);
  const normalized: ScheduleRunReferences = {};
  for (const [key, child] of Object.entries(value)) {
    if (!allowed.has(key)) {
      throw new Error(`Schedule run references contains unsupported field "${key}"`);
    }
    (normalized as Record<string, string>)[key] = nonEmpty(
      child,
      `Schedule run reference ${key}`,
    );
  }
  return normalized;
}

function normalizeRunError(value: ScheduleRunError): ScheduleRunError {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Schedule run error must be an object");
  }
  assertOnlyKeys(
    value as unknown as Record<string, unknown>,
    ["code", "message", "retryable", "metadata"],
    "Schedule run error",
  );
  if (typeof value.retryable !== "boolean") {
    throw new Error("Schedule run error retryable must be a boolean");
  }
  return {
    code: nonEmpty(value.code, "Schedule run error code"),
    message: nonEmpty(value.message, "Schedule run error message"),
    retryable: value.retryable,
    ...(value.metadata === undefined
      ? {}
      : {
          metadata: normalizeScheduleMetadata(
            value.metadata,
            "Schedule run error metadata",
          ),
        }),
  };
}

function normalizeDriverRegistration(
  value: ScheduleDriverRegistration,
): ScheduleDriverRegistration {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Schedule driver registration must be an object");
  }
  assertOnlyKeys(
    value as unknown as Record<string, unknown>,
    ["kind", "status", "providerId", "metadata", "error", "updatedAt"],
    "Schedule driver registration",
  );
  if (!["pending", "registered", "failed", "not_required"].includes(value.status)) {
    throw new Error("Schedule driver registration status is invalid");
  }
  if (value.status === "registered" && value.providerId === undefined) {
    throw new Error("A registered schedule driver requires providerId");
  }
  if (value.status === "failed" && value.error === undefined) {
    throw new Error("A failed schedule driver registration requires error details");
  }
  if (value.status !== "failed" && value.error !== undefined) {
    throw new Error("Only a failed schedule driver registration may include an error");
  }
  return {
    kind: nonEmpty(value.kind, "Schedule driver kind"),
    status: value.status,
    ...(value.providerId === undefined
      ? {}
      : { providerId: nonEmpty(value.providerId, "Schedule driver providerId") }),
    ...(value.metadata === undefined
      ? {}
      : {
          metadata: normalizeScheduleMetadata(
            value.metadata,
            "Schedule driver metadata",
          ),
        }),
    ...(value.error === undefined ? {} : { error: normalizeDriverError(value.error) }),
    updatedAt: absoluteTimestamp(
      value.updatedAt,
      "Schedule driver updatedAt",
    ),
  };
}

function normalizeDriverError(
  value: NonNullable<ScheduleDriverRegistration["error"]>,
): NonNullable<ScheduleDriverRegistration["error"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Schedule driver error must be an object");
  }
  assertOnlyKeys(
    value as unknown as Record<string, unknown>,
    ["code", "message", "retryable"],
    "Schedule driver error",
  );
  if (typeof value.retryable !== "boolean") {
    throw new Error("Schedule driver error retryable must be a boolean");
  }
  return {
    code: nonEmpty(value.code, "Schedule driver error code"),
    message: nonEmpty(value.message, "Schedule driver error message"),
    retryable: value.retryable,
  };
}

export function assertSameScheduleOccurrence(
  existing: ScheduleRun,
  input: CreateScheduleRunInput,
): void {
  if (
    existing.scheduleId !== input.scheduleId
    || existing.occurrenceAt !== input.occurrenceAt
    || existing.triggerId !== input.triggerId
  ) {
    throw new ScheduleConflictError(
      `Schedule run idempotency key "${input.idempotencyKey}" is already used by another occurrence`,
    );
  }
}

function assertRevision(schedule: Schedule, expected: number | undefined): void {
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

function applyNullableStringPatch(
  schedule: Schedule,
  key: "name" | "description",
  value: string | null | undefined,
): void {
  if (value === undefined) return;
  if (value === null) {
    delete schedule[key];
  } else {
    schedule[key] = value;
  }
}

function applyNullableField<
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

function normalizeStatusFilter(
  status: ScheduleFilter["status"],
): Set<ScheduleStatus> | undefined {
  if (status === undefined) return undefined;
  return new Set(Array.isArray(status) ? status : [status]);
}

function normalizeRunStatusFilter(
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

function normalizeRunOrder(order: ScheduleRunFilter["order"]): 1 | -1 {
  if (order === undefined || order === "desc") return -1;
  if (order === "asc") return 1;
  throw new Error('Schedule run order must be "asc" or "desc"');
}

function isActiveRun(run: ScheduleRun): boolean {
  return run.status === "claimed" || run.status === "running";
}

function leaseMatches(
  current: ScheduleLease | undefined,
  candidate: ScheduleLease,
): boolean {
  return Boolean(
    current
    && current.owner === candidate.owner
    && current.token === candidate.token,
  );
}

function compareCreated(a: Schedule, b: Schedule): number {
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

function absoluteTimestamp(value: unknown, label: string): string {
  const text = nonEmpty(value, label);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      text,
    )
  ) {
    throw new Error(`${label} must be an absolute ISO timestamp`);
  }
  const date = new Date(text);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`${label} must be a valid timestamp`);
  }
  return date.toISOString();
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (value.trim().length > 512) {
    throw new Error(`${label} exceeds the 512-character limit`);
  }
  return value.trim();
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw new Error(`${label} contains unsupported field "${key}"`);
    }
  }
}
