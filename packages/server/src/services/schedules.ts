import {
  SCHEDULE_LIMITS,
  ScheduleNotFoundError,
  nextScheduleOccurrence,
  normalizeCreateScheduleInput,
  normalizeUpdateScheduleInput,
  type CreateScheduleInput,
  type Schedule,
  type ScheduleDriver,
  type ScheduleDriverRegistration,
  type ScheduleFilter,
  type ScheduleMutationOptions,
  type ScheduleRun,
  type ScheduleRunFilter,
  type ScheduleStore,
  type UpdateScheduleInput,
} from "@polpo-ai/core/scheduling";

export type ScheduleServiceErrorCode =
  | "INVALID_REQUEST"
  | "INVALID_STATE"
  | "NOT_FOUND";

export class ScheduleServiceError extends Error {
  constructor(
    readonly code: ScheduleServiceErrorCode,
    message: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ScheduleServiceError";
  }
}

export interface ScheduleServiceOptions {
  store: ScheduleStore;
  driver: ScheduleDriver;
  now?: () => Date | string;
  onRunCreated?: (run: ScheduleRun) => void | Promise<void>;
}

export interface ManualScheduleTriggerInput {
  idempotencyKey: string;
}

/**
 * Host-neutral application service for schedule lifecycle and durable runs.
 *
 * Provider registration failures are persisted on the Schedule instead of
 * rolling back local truth. Reconciliation can then repair external state.
 */
export class ScheduleService {
  private readonly store: ScheduleStore;
  private readonly driver: ScheduleDriver;
  private readonly nowProvider: () => Date | string;
  private readonly onRunCreated?: ScheduleServiceOptions["onRunCreated"];
  private readonly manualTriggers = new Map<string, Promise<ScheduleRun>>();

  constructor(options: ScheduleServiceOptions) {
    if (!options?.store) throw new Error("Schedule service requires a store");
    if (!options.driver) throw new Error("Schedule service requires a driver");
    this.store = options.store;
    this.driver = options.driver;
    this.nowProvider = options.now ?? (() => new Date());
    this.onRunCreated = options.onRunCreated;
  }

  list(filter?: ScheduleFilter): Promise<Schedule[]> {
    return this.store.list(filter);
  }

  async get(id: string): Promise<Schedule> {
    const normalizedId = identifier(id, "Schedule id");
    const schedule = await this.store.get(normalizedId);
    if (!schedule) throw new ScheduleNotFoundError("Schedule", normalizedId);
    return schedule;
  }

  async create(input: CreateScheduleInput): Promise<Schedule> {
    const now = this.now();
    const normalized = normalizeRequest(
      () => normalizeCreateScheduleInput(input, { now }),
    );
    let schedule = await this.store.create(normalized);
    const next = nextScheduleOccurrence(schedule, now);
    schedule = await this.store.updateOperationalState(
      schedule.id,
      { nextOccurrenceAt: next?.occurrenceAt ?? null },
      { expectedRevision: schedule.revision },
    );
    const registration = await this.registerDriver("register", schedule);
    return this.store.updateOperationalState(
      schedule.id,
      { driver: registration },
      { expectedRevision: schedule.revision },
    );
  }

  async update(
    id: string,
    patch: UpdateScheduleInput,
    options: ScheduleMutationOptions = {},
  ): Promise<Schedule> {
    const normalizedId = identifier(id, "Schedule id");
    const previous = await this.get(normalizedId);
    const now = this.now();
    const normalizedPatch = normalizeRequest(
      () => normalizeUpdateScheduleInput(patch, { now }),
    );
    let schedule = await this.store.update(
      normalizedId,
      normalizedPatch,
      options,
    );
    if (normalizedPatch.timing !== undefined) {
      const next = nextScheduleOccurrence(schedule, now);
      schedule = await this.store.updateOperationalState(
        schedule.id,
        { nextOccurrenceAt: next?.occurrenceAt ?? null },
        { expectedRevision: schedule.revision },
      );
    }
    if (
      normalizedPatch.status !== undefined
      && normalizedPatch.status !== previous.status
    ) {
      return this.applyDriverLifecycle(
        normalizedPatch.status === "active" ? "resume" : "pause",
        schedule,
      );
    }
    const registration = await this.registerDriver("update", schedule);
    return this.store.updateOperationalState(
      schedule.id,
      { driver: registration },
      { expectedRevision: schedule.revision },
    );
  }

  async pause(
    id: string,
    options: ScheduleMutationOptions = {},
  ): Promise<Schedule> {
    const schedule = await this.store.update(
      identifier(id, "Schedule id"),
      { status: "paused" },
      options,
    );
    return this.applyDriverLifecycle("pause", schedule);
  }

  async resume(
    id: string,
    options: ScheduleMutationOptions = {},
  ): Promise<Schedule> {
    const schedule = await this.store.update(
      identifier(id, "Schedule id"),
      { status: "active" },
      options,
    );
    return this.applyDriverLifecycle("resume", schedule);
  }

  async delete(
    id: string,
    options: ScheduleMutationOptions = {},
  ): Promise<Schedule> {
    const normalizedId = identifier(id, "Schedule id");
    await this.get(normalizedId);
    await this.store.markDeleted(normalizedId, options);
    const deleted = await this.get(normalizedId);
    return this.applyDriverLifecycle("delete", deleted);
  }

  async listRuns(
    scheduleId: string,
    filter: Omit<ScheduleRunFilter, "scheduleId"> = {},
  ): Promise<ScheduleRun[]> {
    const schedule = await this.get(scheduleId);
    return this.store.listRuns({ ...filter, scheduleId: schedule.id });
  }

  async trigger(
    scheduleId: string,
    input: ManualScheduleTriggerInput,
  ): Promise<ScheduleRun> {
    const schedule = await this.get(scheduleId);
    if (schedule.status !== "active") {
      throw new ScheduleServiceError(
        "INVALID_STATE",
        `Schedule "${schedule.id}" must be active to trigger a run`,
        false,
      );
    }
    const callerKey = identifier(
      input?.idempotencyKey,
      "Manual schedule idempotency key",
    );
    const identity = `manual:${schedule.id}:${callerKey}`;
    const pending = this.manualTriggers.get(identity);
    if (pending) return pending;

    const operation = this.triggerManualRun(schedule, identity);
    this.manualTriggers.set(identity, operation);
    try {
      return await operation;
    } finally {
      if (this.manualTriggers.get(identity) === operation) {
        this.manualTriggers.delete(identity);
      }
    }
  }

  private async triggerManualRun(
    schedule: Schedule,
    identity: string,
  ): Promise<ScheduleRun> {
    const existing = await this.store.getRunByIdempotencyKey(identity);
    if (existing && sameManualRun(existing, schedule.id, identity)) {
      return existing;
    }

    let run: ScheduleRun;
    try {
      run = await this.store.createRun({
        scheduleId: schedule.id,
        occurrenceAt: this.now().toISOString(),
        triggerId: identity,
        idempotencyKey: identity,
      });
    } catch (error) {
      const raced = await this.store.getRunByIdempotencyKey(identity);
      if (raced && sameManualRun(raced, schedule.id, identity)) return raced;
      throw error;
    }
    try {
      await this.onRunCreated?.(run);
    } catch {
      // The durable pending run remains discoverable by polling/reconciliation.
    }
    return run;
  }

  private async registerDriver(
    operation: "register" | "update",
    schedule: Schedule,
  ): Promise<ScheduleDriverRegistration> {
    try {
      return await this.driver[operation](schedule);
    } catch (error) {
      return failedRegistration(
        operation,
        schedule,
        this.now(),
        error,
      );
    }
  }

  private async applyDriverLifecycle(
    operation: "pause" | "resume" | "delete",
    schedule: Schedule,
  ): Promise<Schedule> {
    let registration: ScheduleDriverRegistration;
    try {
      const lifecycleRegistration = await this.driver[operation](schedule);
      registration = lifecycleRegistration ?? {
        kind: schedule.driver?.kind ?? "unknown",
        status: schedule.driver?.status === "not_required"
          ? "not_required"
          : "registered",
        ...(schedule.driver?.providerId === undefined
          ? {}
          : { providerId: schedule.driver.providerId }),
        ...(schedule.driver?.metadata === undefined
          ? {}
          : { metadata: schedule.driver.metadata }),
        updatedAt: this.now().toISOString(),
      };
    } catch (error) {
      registration = failedRegistration(
        operation,
        schedule,
        this.now(),
        error,
      );
    }
    return this.store.updateOperationalState(
      schedule.id,
      { driver: registration },
      { expectedRevision: schedule.revision },
    );
  }

  private now(): Date {
    const now = new Date(this.nowProvider());
    if (!Number.isFinite(now.getTime())) {
      throw new ScheduleServiceError(
        "INVALID_STATE",
        "Schedule service clock returned an invalid date",
        false,
      );
    }
    return now;
  }
}

function sameManualRun(
  run: ScheduleRun,
  scheduleId: string,
  identity: string,
): boolean {
  return run.scheduleId === scheduleId
    && run.triggerId === identity
    && run.idempotencyKey === identity;
}

function failedRegistration(
  operation: "register" | "update" | "pause" | "resume" | "delete",
  schedule: Schedule,
  now: Date,
  error: unknown,
): ScheduleDriverRegistration {
  void error;
  return {
    kind: schedule.driver?.kind ?? "unknown",
    status: "failed",
    ...(schedule.driver?.providerId === undefined
      ? {}
      : { providerId: schedule.driver.providerId }),
    error: {
      code: `DRIVER_${operation.toUpperCase()}_FAILED`,
      message: `Schedule driver ${operation} operation failed`,
      retryable: true,
    },
    updatedAt: now.toISOString(),
  };
}

function normalizeRequest<T>(operation: () => T): T {
  try {
    return operation();
  } catch (cause) {
    throw new ScheduleServiceError(
      "INVALID_REQUEST",
      cause instanceof Error ? cause.message : "Invalid schedule request",
      false,
      { cause },
    );
  }
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ScheduleServiceError(
      "INVALID_REQUEST",
      `${label} must be a non-empty string`,
      false,
    );
  }
  const normalized = value.trim();
  if (normalized.length > SCHEDULE_LIMITS.idLength) {
    throw new ScheduleServiceError(
      "INVALID_REQUEST",
      `${label} exceeds ${SCHEDULE_LIMITS.idLength} characters`,
      false,
    );
  }
  return normalized;
}
