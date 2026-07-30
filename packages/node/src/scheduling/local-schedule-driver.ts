import { nanoid } from "nanoid";
import {
  ScheduleConflictError,
  ScheduleInvalidStateError,
  listScheduleOccurrences,
  nextScheduleOccurrence,
  previousScheduleOccurrence,
  scheduleOccurrenceIdentity,
  type CompleteScheduleRunInput,
  type Schedule,
  type ScheduleDriver,
  type ScheduleDriverRegistration,
  type ScheduleLease,
  type ScheduleRun,
  type ScheduleRunError,
  type ScheduleRunReferences,
  type ScheduleStore,
} from "@polpo-ai/core/scheduling";

const DEFAULT_LEASE_DURATION_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_MAX_OCCURRENCES_PER_TICK = 100;
const DEFAULT_MAX_RUNS_PER_TICK = 250;

export interface LocalScheduleDriverOptions {
  now?: () => Date | string;
}

export class LocalScheduleDriver implements ScheduleDriver {
  private readonly nowProvider: () => Date | string;

  constructor(options: LocalScheduleDriverOptions = {}) {
    this.nowProvider = options.now ?? (() => new Date());
  }

  async register(schedule: Schedule): Promise<ScheduleDriverRegistration> {
    return this.registration(schedule);
  }

  async update(schedule: Schedule): Promise<ScheduleDriverRegistration> {
    return this.registration(schedule);
  }

  async pause(_schedule: Schedule): Promise<void> {}

  async resume(_schedule: Schedule): Promise<void> {}

  async delete(_schedule: Schedule): Promise<void> {}

  private registration(schedule: Schedule): ScheduleDriverRegistration {
    const now = validClock(this.nowProvider(), "Local schedule driver");
    if (!schedule.id) {
      throw new ScheduleInvalidStateError("Local schedule driver requires an id");
    }
    return {
      kind: "local",
      status: "registered",
      providerId: `local:${schedule.id}`,
      updatedAt: now.toISOString(),
    };
  }
}

export interface LocalScheduleRunResult {
  status: Extract<
    CompleteScheduleRunInput["status"],
    "succeeded" | "failed" | "skipped" | "cancelled"
  >;
  references: ScheduleRunReferences;
  result?: CompleteScheduleRunInput["result"];
  error?: ScheduleRunError;
}

export interface LocalScheduleRunContext {
  schedule: Schedule;
  run: ScheduleRun;
  lease: ScheduleLease;
  signal: AbortSignal;
}

export type LocalScheduleRunHandler = (
  context: LocalScheduleRunContext,
) => Promise<LocalScheduleRunResult>;

export interface LocalScheduleWorkerErrorContext {
  phase: "materialize" | "dispatch" | "heartbeat" | "poll";
  scheduleId?: string;
  runId?: string;
}

export interface LocalScheduleWorkerOptions {
  store: ScheduleStore;
  handler: LocalScheduleRunHandler;
  workerId?: string;
  now?: () => Date | string;
  createLeaseToken?: () => string;
  leaseDurationMs?: number;
  pollIntervalMs?: number;
  maxOccurrencesPerSchedulePerTick?: number;
  maxRunsPerTick?: number;
  onError?: (
    error: unknown,
    context: LocalScheduleWorkerErrorContext,
  ) => void;
}

export interface LocalScheduleTickResult {
  alreadyRunning: boolean;
  materialized: number;
  dispatched: number;
  succeeded: number;
  skipped: number;
  cancelled: number;
  failed: number;
  deferred: number;
  conflicts: number;
}

export class LocalScheduleWorker {
  private readonly store: ScheduleStore;
  private readonly handler: LocalScheduleRunHandler;
  private readonly workerId: string;
  private readonly nowProvider: () => Date | string;
  private readonly createLeaseToken: () => string;
  private readonly leaseDurationMs: number;
  private readonly pollIntervalMs: number;
  private readonly maxOccurrencesPerSchedulePerTick: number;
  private readonly maxRunsPerTick: number;
  private readonly onError?: LocalScheduleWorkerOptions["onError"];
  private tickInProgress = false;
  private timer?: ReturnType<typeof setTimeout>;
  private polling = false;

  constructor(options: LocalScheduleWorkerOptions) {
    if (!options?.store) throw new Error("Local schedule worker requires a store");
    if (typeof options.handler !== "function") {
      throw new Error("Local schedule worker requires a handler");
    }
    this.store = options.store;
    this.handler = options.handler;
    this.workerId = nonEmpty(options.workerId ?? `local-worker-${nanoid()}`, "workerId");
    this.nowProvider = options.now ?? (() => new Date());
    this.createLeaseToken = options.createLeaseToken ?? (() => nanoid());
    this.leaseDurationMs = boundedInteger(
      options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS,
      "leaseDurationMs",
      1_000,
      60 * 60 * 1_000,
    );
    this.pollIntervalMs = boundedInteger(
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      "pollIntervalMs",
      100,
      60_000,
    );
    this.maxOccurrencesPerSchedulePerTick = boundedInteger(
      options.maxOccurrencesPerSchedulePerTick
        ?? DEFAULT_MAX_OCCURRENCES_PER_TICK,
      "maxOccurrencesPerSchedulePerTick",
      1,
      1_000,
    );
    this.maxRunsPerTick = boundedInteger(
      options.maxRunsPerTick ?? DEFAULT_MAX_RUNS_PER_TICK,
      "maxRunsPerTick",
      1,
      1_000,
    );
    this.onError = options.onError;
  }

  start(): void {
    if (this.polling) return;
    this.polling = true;
    this.scheduleNextPoll(0);
  }

  stop(): void {
    this.polling = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<LocalScheduleTickResult> {
    if (this.tickInProgress) return createTickResult(true);
    const now = validClock(this.nowProvider(), "Local schedule worker");
    const result = createTickResult(false);
    this.tickInProgress = true;
    try {
      const schedules = await this.store.list({ status: "active" });
      for (const schedule of schedules) {
        try {
          await this.materialize(schedule, now, result);
        } catch (error) {
          if (error instanceof ScheduleConflictError) result.conflicts += 1;
          else result.failed += 1;
          this.report(error, {
            phase: "materialize",
            scheduleId: schedule.id,
          });
        }
      }
      await this.processRuns(now, result);
      return result;
    } finally {
      this.tickInProgress = false;
    }
  }

  private async materialize(
    initialSchedule: Schedule,
    now: Date,
    result: LocalScheduleTickResult,
  ): Promise<void> {
    let schedule = initialSchedule;
    if (!schedule.nextOccurrenceAt) {
      const baseline = new Date(schedule.createdAt);
      const next = nextScheduleOccurrence(schedule, baseline);
      schedule = await this.store.updateOperationalState(
        schedule.id,
        { nextOccurrenceAt: next?.occurrenceAt ?? null },
        { expectedRevision: schedule.revision },
      );
    }

    if (
      !schedule.nextOccurrenceAt
      || Date.parse(schedule.nextOccurrenceAt) > now.getTime()
    ) {
      return;
    }

    let due = this.dueOccurrences(schedule, now);
    if (due.length === 0) return;

    if (schedule.policy.catchUp === "latest") {
      const last = due[due.length - 1];
      const following = nextScheduleOccurrence(schedule, last.occurrenceAt);
      if (
        due.length === this.maxOccurrencesPerSchedulePerTick
        && following
        && Date.parse(following.occurrenceAt) <= now.getTime()
      ) {
        const latest = previousScheduleOccurrence(schedule, now);
        due = latest ? [latest] : [];
      }
    }
    if (due.length === 0) return;

    const existing = new Set(
      (await this.store.listRuns({ scheduleId: schedule.id, limit: 1_000 }))
        .map((run) => run.idempotencyKey),
    );
    for (const occurrence of due) {
      await this.store.createRun({
        scheduleId: schedule.id,
        occurrenceAt: occurrence.occurrenceAt,
        triggerId: occurrence.triggerId,
        idempotencyKey: occurrence.idempotencyKey,
      });
      if (!existing.has(occurrence.idempotencyKey)) {
        existing.add(occurrence.idempotencyKey);
        result.materialized += 1;
      }
    }

    const last = due[due.length - 1];
    const next = nextScheduleOccurrence(schedule, last.occurrenceAt);
    await this.store.updateOperationalState(
      schedule.id,
      {
        lastOccurrenceAt: last.occurrenceAt,
        nextOccurrenceAt: next?.occurrenceAt ?? null,
      },
      { expectedRevision: schedule.revision },
    );
  }

  private dueOccurrences(schedule: Schedule, now: Date) {
    const first = scheduleOccurrenceIdentity(
      schedule,
      schedule.nextOccurrenceAt!,
    );
    if (Date.parse(first.occurrenceAt) > now.getTime()) return [];
    if (this.maxOccurrencesPerSchedulePerTick === 1) return [first];
    return [
      first,
      ...listScheduleOccurrences(schedule, {
        after: first.occurrenceAt,
        through: now,
        limit: this.maxOccurrencesPerSchedulePerTick - 1,
      }),
    ];
  }

  private async processRuns(
    now: Date,
    result: LocalScheduleTickResult,
  ): Promise<void> {
    const candidates = (await this.store.listRuns({
      status: ["pending", "claimed", "running"],
      limit: this.maxRunsPerTick,
      order: "asc",
    }));
    const latestRunBySchedule = new Map<string, string | undefined>();

    for (const candidate of candidates) {
      if (
        (candidate.status === "claimed" || candidate.status === "running")
        && candidate.lease
        && Date.parse(candidate.lease.expiresAt) > now.getTime()
      ) {
        continue;
      }
      const schedule = await this.store.get(candidate.scheduleId);
      if (!schedule || schedule.status !== "active") {
        result.deferred += 1;
        continue;
      }

      const expired =
        now.getTime() - Date.parse(candidate.occurrenceAt)
          > schedule.policy.misfireGraceSeconds * 1_000;
      let superseded = false;
      if (schedule.policy.catchUp === "latest") {
        if (!latestRunBySchedule.has(schedule.id)) {
          const [latest] = await this.store.listRuns({
            scheduleId: schedule.id,
            limit: 1,
            order: "desc",
          });
          latestRunBySchedule.set(schedule.id, latest?.id);
        }
        superseded = latestRunBySchedule.get(schedule.id) !== candidate.id;
      }
      if (expired || superseded) {
        await this.skipRun(
          candidate,
          schedule,
          now,
          expired ? "misfire_grace_exceeded" : "superseded_by_latest",
          result,
        );
        continue;
      }

      if (
        await this.store.countActiveRuns(schedule.id)
          >= schedule.policy.maxConcurrency
      ) {
        result.deferred += 1;
        continue;
      }

      const lease = this.createLease(now);
      const claimed = await this.store.claimRun(candidate.id, lease);
      if (!claimed) continue;
      let running: ScheduleRun;
      try {
        running = await this.store.startRun(candidate.id, lease);
      } catch (error) {
        try {
          await this.store.releaseRun(candidate.id, lease);
        } catch {
          // A stale lease is recoverable by the next worker tick.
        }
        result.deferred += 1;
        this.report(error, {
          phase: "dispatch",
          scheduleId: schedule.id,
          runId: candidate.id,
        });
        continue;
      }

      result.dispatched += 1;
      const controller = new AbortController();
      const stopHeartbeat = this.startHeartbeat(running, lease, controller);
      try {
        const completion = await this.handler({
          schedule,
          run: running,
          lease,
          signal: controller.signal,
        });
        stopHeartbeat();
        const completed = await this.store.completeRun(candidate.id, {
          lease,
          ...completion,
        });
        incrementTerminalResult(result, completed.status);
        if (schedule.timing.kind === "once") {
          await this.completeOnceSchedule(schedule.id, result);
        }
      } catch (error) {
        stopHeartbeat();
        controller.abort(error);
        try {
          await this.store.releaseRun(candidate.id, lease);
        } catch {
          // Expired ownership is intentionally left for lease reclamation.
        }
        result.failed += 1;
        this.report(error, {
          phase: "dispatch",
          scheduleId: schedule.id,
          runId: candidate.id,
        });
      }
    }
  }

  private async skipRun(
    candidate: ScheduleRun,
    schedule: Schedule,
    now: Date,
    reason: string,
    result: LocalScheduleTickResult,
  ): Promise<void> {
    const lease = this.createLease(now);
    const claimed = await this.store.claimRun(candidate.id, lease);
    if (!claimed) {
      result.deferred += 1;
      return;
    }
    await this.store.completeRun(candidate.id, {
      lease,
      status: "skipped",
      references: {},
      result: { reason },
    });
    result.skipped += 1;
    if (schedule.timing.kind === "once") {
      await this.completeOnceSchedule(schedule.id, result);
    }
  }

  private async completeOnceSchedule(
    scheduleId: string,
    result: LocalScheduleTickResult,
  ): Promise<void> {
    const latest = await this.store.get(scheduleId);
    if (!latest || latest.status !== "active") return;
    try {
      await this.store.update(
        scheduleId,
        { status: "completed" },
        { expectedRevision: latest.revision },
      );
    } catch (error) {
      if (error instanceof ScheduleConflictError) result.conflicts += 1;
      else throw error;
    }
  }

  private createLease(now: Date): ScheduleLease {
    const token = nonEmpty(this.createLeaseToken(), "lease token");
    return {
      owner: this.workerId,
      token,
      expiresAt: new Date(now.getTime() + this.leaseDurationMs).toISOString(),
    };
  }

  private startHeartbeat(
    run: ScheduleRun,
    lease: ScheduleLease,
    controller: AbortController,
  ): () => void {
    let stopped = false;
    let renewing = false;
    const interval = setInterval(async () => {
      if (stopped || renewing) return;
      renewing = true;
      try {
        const now = validClock(this.nowProvider(), "Local schedule worker");
        const renewed = {
          ...lease,
          expiresAt: new Date(
            now.getTime() + this.leaseDurationMs,
          ).toISOString(),
        };
        if (!await this.store.renewLease(run.id, renewed)) {
          controller.abort(
            new ScheduleConflictError(
              `Schedule run "${run.id}" lease ownership was lost`,
            ),
          );
          stopped = true;
          clearInterval(interval);
        }
      } catch (error) {
        controller.abort(error);
        this.report(error, {
          phase: "heartbeat",
          scheduleId: run.scheduleId,
          runId: run.id,
        });
        stopped = true;
        clearInterval(interval);
      } finally {
        renewing = false;
      }
    }, Math.max(100, Math.floor(this.leaseDurationMs / 3)));
    interval.unref?.();
    return () => {
      stopped = true;
      clearInterval(interval);
    };
  }

  private scheduleNextPoll(delay: number): void {
    if (!this.polling) return;
    this.timer = setTimeout(async () => {
      try {
        await this.tick();
      } catch (error) {
        this.report(error, { phase: "poll" });
      } finally {
        this.scheduleNextPoll(this.pollIntervalMs);
      }
    }, delay);
    this.timer.unref?.();
  }

  private report(
    error: unknown,
    context: LocalScheduleWorkerErrorContext,
  ): void {
    this.onError?.(error, context);
  }
}

function createTickResult(alreadyRunning: boolean): LocalScheduleTickResult {
  return {
    alreadyRunning,
    materialized: 0,
    dispatched: 0,
    succeeded: 0,
    skipped: 0,
    cancelled: 0,
    failed: 0,
    deferred: 0,
    conflicts: 0,
  };
}

function incrementTerminalResult(
  result: LocalScheduleTickResult,
  status: ScheduleRun["status"],
): void {
  if (status === "succeeded") result.succeeded += 1;
  else if (status === "skipped") result.skipped += 1;
  else if (status === "cancelled") result.cancelled += 1;
  else if (status === "failed") result.failed += 1;
}

function validClock(value: Date | string, label: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new ScheduleInvalidStateError(`${label} clock returned an invalid date`);
  }
  return date;
}

function boundedInteger(
  value: number,
  label: string,
  min: number,
  max: number,
): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function nonEmpty(value: string, label: string): string {
  if (!value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}
