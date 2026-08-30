import { normalizeBrainScope } from "./scope.js";
import {
  BrainIngestionError,
  BrainStoreConflictError,
  BrainStoreValidationError,
} from "./store-errors.js";
import type { BrainIngestionJobStore } from "./stores.js";
import type {
  BrainFailure,
  BrainIngestionJob,
  BrainScope,
} from "./types.js";

const MAX_DELAY_MS = 86_400_000;
const DEFAULT_LEASE_MS = 60_000;

export type BrainIngestionWorkerOutcome =
  | { readonly outcome: "idle" }
  | {
      readonly outcome: "completed" | "stale";
      readonly jobId: string;
      readonly attempt: number;
    }
  | {
      readonly outcome: "retry_scheduled" | "failed";
      readonly jobId: string;
      readonly attempt: number;
      readonly errorCode: string;
    };

export interface BrainIngestionExecutionContext {
  readonly job: BrainIngestionJob;
  /** Aborted when the worker shuts down or loses its lease. */
  readonly signal: AbortSignal;
}

export interface ProcessNextBrainIngestionJobInput {
  readonly jobStore: BrainIngestionJobStore;
  readonly scope: BrainScope;
  readonly workerId: string;
  readonly execute: (
    context: BrainIngestionExecutionContext,
  ) => void | Promise<void>;
  readonly now?: () => Date | string;
  readonly leaseMs?: number;
  readonly heartbeatMs?: number;
  readonly signal?: AbortSignal;
  readonly classifyFailure?: (
    error: unknown,
    job: BrainIngestionJob,
  ) => BrainFailure;
  readonly retryDelayMs?: (
    job: BrainIngestionJob,
    failure: BrainFailure,
  ) => number;
}

function boundedInteger(
  value: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new BrainStoreValidationError(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function timestamp(now: (() => Date | string) | undefined): string {
  const value = now?.() ?? new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new BrainStoreValidationError("Brain ingestion worker time is invalid");
  }
  return date.toISOString();
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function defaultFailure(error: unknown): BrainFailure {
  if (isAbortError(error)) {
    return {
      code: "worker_aborted",
      message: "Knowledge ingestion worker was interrupted",
      retryable: true,
    };
  }
  if (error instanceof BrainIngestionError) {
    const retryable = error.code === "ingestion_failed";
    return {
      code: error.code,
      message: retryable
        ? "Knowledge source ingestion failed"
        : "Knowledge source cannot be ingested",
      retryable,
    };
  }
  return {
    code: "ingestion_failed",
    message: "Knowledge source ingestion failed",
    retryable: true,
  };
}

function normalizedFailure(value: unknown): BrainFailure {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return defaultFailure(undefined);
  }
  const candidate = value as Record<string, unknown>;
  const code = typeof candidate.code === "string" ? candidate.code.trim() : "";
  const message = typeof candidate.message === "string"
    ? candidate.message.trim()
    : "";
  if (
    !/^[a-z][a-z0-9_]{0,127}$/.test(code)
    || message.length === 0
    || message.length > 1_024
    || typeof candidate.retryable !== "boolean"
  ) {
    return defaultFailure(undefined);
  }
  return Object.freeze({ code, message, retryable: candidate.retryable });
}

function defaultRetryDelay(job: BrainIngestionJob): number {
  return Math.min(5 * 60_000, 1_000 * (2 ** Math.max(0, job.attempt - 1)));
}

function staleResult(job: BrainIngestionJob): BrainIngestionWorkerOutcome {
  return { outcome: "stale", jobId: job.id, attempt: job.attempt };
}

export async function processNextBrainIngestionJob(
  input: ProcessNextBrainIngestionJobInput,
): Promise<BrainIngestionWorkerOutcome> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new BrainStoreValidationError("Brain ingestion worker input is required");
  }
  if (!input.jobStore || typeof input.jobStore.claimNextJob !== "function") {
    throw new BrainStoreValidationError("Brain ingestion job store is required");
  }
  if (typeof input.execute !== "function") {
    throw new BrainStoreValidationError("Brain ingestion executor is required");
  }
  const scope = normalizeBrainScope(input.scope);
  const leaseMs = boundedInteger(
    input.leaseMs ?? DEFAULT_LEASE_MS,
    "leaseMs",
    1,
    MAX_DELAY_MS,
  );
  const heartbeatMs = boundedInteger(
    input.heartbeatMs ?? Math.max(1, Math.floor(leaseMs / 3)),
    "heartbeatMs",
    1,
    MAX_DELAY_MS,
  );
  throwIfAborted(input.signal);
  const claimed = await input.jobStore.claimNextJob({
    scope,
    workerId: input.workerId,
    now: timestamp(input.now),
    leaseMs,
  });
  if (!claimed) return { outcome: "idle" };

  const execution = new AbortController();
  const onAbort = () => execution.abort(abortReason(input.signal!));
  if (input.signal?.aborted) {
    execution.abort(abortReason(input.signal));
  } else {
    input.signal?.addEventListener("abort", onAbort, { once: true });
  }
  let heartbeatFailure: unknown;
  let heartbeatChain = Promise.resolve();
  const renew = input.jobStore.renewJobLease;
  const timer = renew
    ? setInterval(() => {
        heartbeatChain = heartbeatChain.then(async () => {
          if (execution.signal.aborted || heartbeatFailure) return;
          try {
            await renew.call(input.jobStore, {
              scope,
              jobId: claimed.id,
              claimToken: claimed.claimToken!,
              now: timestamp(input.now),
              leaseMs,
            });
          } catch (error) {
            heartbeatFailure = error;
            execution.abort(error);
          }
        });
      }, heartbeatMs)
    : undefined;
  timer?.unref?.();

  let executionFailure: unknown = execution.signal.aborted
    ? abortReason(execution.signal)
    : undefined;
  try {
    if (executionFailure === undefined) {
      await input.execute({ job: claimed, signal: execution.signal });
    }
  } catch (error) {
    executionFailure = error;
  } finally {
    if (timer) clearInterval(timer);
    input.signal?.removeEventListener("abort", onAbort);
    await heartbeatChain;
  }

  if (heartbeatFailure) {
    if (heartbeatFailure instanceof BrainStoreConflictError) {
      return staleResult(claimed);
    }
    throw heartbeatFailure;
  }

  if (executionFailure === undefined) {
    try {
      await input.jobStore.completeJob({
        scope,
        jobId: claimed.id,
        claimToken: claimed.claimToken!,
        now: timestamp(input.now),
      });
      return { outcome: "completed", jobId: claimed.id, attempt: claimed.attempt };
    } catch (error) {
      if (error instanceof BrainStoreConflictError) return staleResult(claimed);
      throw error;
    }
  }

  let classified: unknown;
  try {
    classified = input.classifyFailure
      ? input.classifyFailure(executionFailure, claimed)
      : defaultFailure(executionFailure);
  } catch {
    classified = defaultFailure(executionFailure);
  }
  const failure = normalizedFailure(classified);
  let requestedDelay: number;
  try {
    requestedDelay = input.retryDelayMs
      ? input.retryDelayMs(claimed, failure)
      : defaultRetryDelay(claimed);
  } catch {
    requestedDelay = defaultRetryDelay(claimed);
  }
  let delay: number;
  try {
    delay = boundedInteger(requestedDelay, "retry delay", 0, MAX_DELAY_MS);
  } catch {
    delay = defaultRetryDelay(claimed);
  }
  const canRetry = failure.retryable && claimed.attempt < claimed.maxAttempts;
  const failedAt = timestamp(input.now);
  try {
    const updated = await input.jobStore.failJob({
      scope,
      jobId: claimed.id,
      claimToken: claimed.claimToken!,
      now: failedAt,
      ...(canRetry
        ? { retryAt: new Date(Date.parse(failedAt) + delay).toISOString() }
        : {}),
      failure,
    });
    return {
      outcome: updated.status === "pending" ? "retry_scheduled" : "failed",
      jobId: claimed.id,
      attempt: claimed.attempt,
      errorCode: failure.code,
    };
  } catch (error) {
    if (error instanceof BrainStoreConflictError) return staleResult(claimed);
    throw error;
  }
}
