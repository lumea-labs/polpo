import {
  MAX_RUN_EVENT_PAGE_SIZE,
  RunDeliveryValidationError,
  RunEventCursorExpiredError,
  parseRunEventCursor,
  type RunCancellationStore,
  type RunEventStore,
  type RunEventJsonValue,
  type RunExecutionLease,
  type RunExecutionLeaseStore,
} from "./run-delivery.js";
import {
  RunEventJournal,
  isTerminalRunStreamEvent,
} from "./run-delivery-follower.js";
import { ToolReceiptSettlementError } from "./tool-execution-receipts.js";

export interface OwnedRunProducerContext {
  runId: string;
  signal: AbortSignal;
  journal: RunEventJournal;
}

export type OwnedRunExecutionResult =
  | { status: "not-owner" }
  | { status: "completed" }
  | { status: "cancelled" }
  | { status: "lost-lease" }
  | { status: "failed"; error: string };

export interface ExecuteOwnedRunOptions {
  runId: string;
  owner: string;
  token: string;
  journal: RunEventJournal;
  leaseStore: RunExecutionLeaseStore;
  cancellationStore?: RunCancellationStore;
  producer: (context: OwnedRunProducerContext) => Promise<void>;
  leaseDurationMs?: number;
  heartbeatIntervalMs?: number;
  now?: () => Date;
}

/** Execute one run under a renewable lease with cooperative abort on cancellation or lost ownership. */
export async function executeOwnedRun(
  options: ExecuteOwnedRunOptions,
): Promise<OwnedRunExecutionResult> {
  const leaseDurationMs = options.leaseDurationMs ?? 30_000;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
  validateTimings(heartbeatIntervalMs, leaseDurationMs);
  const now = options.now ?? (() => new Date());
  const currentTime = () => {
    const value = now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new RunDeliveryValidationError("Run execution owner clock returned an invalid date");
    }
    return value;
  };
  const makeLease = (): RunExecutionLease => ({
    owner: options.owner,
    token: options.token,
    expiresAt: new Date(currentTime().getTime() + leaseDurationMs).toISOString(),
  });
  let activeLease = makeLease();
  if (!await options.leaseStore.claim(options.runId, activeLease)) {
    return { status: "not-owner" };
  }

  const controller = new AbortController();
  let stopHeartbeat = false;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let releaseHeartbeatWait: (() => void) | undefined;
  let lostLease = false;
  let cancellationObserved = false;

  const renewLease = async (): Promise<boolean> => {
    const renewed = makeLease();
    if (!await options.leaseStore.renew(options.runId, renewed)) {
      lostLease = true;
      controller.abort("run_lease_lost");
      return false;
    }
    activeLease = renewed;
    return true;
  };

  const holdsLiveLease = async (): Promise<boolean> => {
    const current = await options.leaseStore.get(options.runId);
    return current !== null
      && current.owner === activeLease.owner
      && current.token === activeLease.token
      && Date.parse(current.expiresAt) > currentTime().getTime();
  };

  const waitForHeartbeat = () => new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      heartbeatTimer = undefined;
      releaseHeartbeatWait = undefined;
      resolve();
    };
    releaseHeartbeatWait = finish;
    heartbeatTimer = setTimeout(finish, heartbeatIntervalMs);
  });

  const heartbeat = async () => {
    while (!stopHeartbeat) {
      await waitForHeartbeat();
      if (stopHeartbeat) return;
      const cancellation = await options.cancellationStore?.get(options.runId);
      if (cancellation) {
        cancellationObserved = true;
        await options.journal.append(options.runId, {
          id: "run.cancelling",
          type: "run.cancelling",
          data: {
            ...(cancellation.reason ? { reason: cancellation.reason } : {}),
          },
        });
        controller.abort("run_cancelled");
        return;
      }
      if (!await renewLease()) return;
    }
  };

  let heartbeatPromise: Promise<void> | undefined;
  let heartbeatFailed = false;
  const stopAndDrainHeartbeat = async (): Promise<void> => {
    stopHeartbeat = true;
    releaseHeartbeatWait?.();
    // Do not detach an in-flight store operation: it could otherwise renew or
    // observe cancellation after a terminal event has already been written.
    // Store implementations remain responsible for bounding their own I/O.
    await heartbeatPromise;
  };
  try {
    const history = await inspectOwnedRunHistory(options.journal.store, options.runId);
    if (history.terminal) {
      return { status: "not-owner" };
    }
    if (!await renewLease()) return { status: "lost-lease" };
    if (history.started) {
      const error = "Run execution was interrupted before completion";
      await options.journal.append(options.runId, {
        id: "run.failed:execution-interrupted",
        type: "run.failed",
        data: {
          code: "run_execution_interrupted",
          message: error,
          retryable: true,
        },
      });
      await options.cancellationStore?.clear(options.runId).catch(() => false);
      return { status: "failed", error };
    }
    await options.journal.append(options.runId, {
      id: "run.started",
      type: "run.started",
      data: {},
    });
    // Admission fence: a reconciler may terminalize an expired, never-started
    // lease between the renewal above and this append. Observing our own,
    // still-live lease afterwards proves no reconciler replaced it, so producer
    // side effects only begin under an owner nobody has superseded.
    if (!await holdsLiveLease()) return { status: "lost-lease" };
    const existingCancellation = await options.cancellationStore?.get(options.runId);
    if (existingCancellation) {
      cancellationObserved = true;
      await options.journal.append(options.runId, {
        id: "run.cancelling",
        type: "run.cancelling",
        data: {
          ...(existingCancellation.reason ? { reason: existingCancellation.reason } : {}),
        },
      });
      controller.abort("run_cancelled");
    } else {
      // Observe background failures immediately. Leaving this Promise without
      // a handler until producer completion lets Node treat a transient store
      // rejection as an uncaught exception and terminate the whole host.
      heartbeatPromise = heartbeat().catch(() => {
        heartbeatFailed = true;
        controller.abort("run_heartbeat_failed");
      });
    }

    let producerFailed = false;
    let producerFailure: unknown;
    try {
      await options.producer({
        runId: options.runId,
        signal: controller.signal,
        journal: options.journal,
      });
    } catch (error) {
      producerFailed = true;
      producerFailure = error;
    }

    // Settle every in-flight heartbeat read/renewal before choosing a terminal
    // event. In particular, a late store rejection must never race with and
    // follow a successful run.completed append.
    await stopAndDrainHeartbeat();

    if (lostLease) return { status: "lost-lease" };
    if (heartbeatFailed) {
      // A store transport failure means ownership is uncertain. Revalidate
      // before terminalizing; if that proof is unavailable, fail closed and
      // let durable reconnect/background reconciliation recover the journal.
      try {
        if (!await renewLease()) return { status: "lost-lease" };
      } catch {
        return { status: "lost-lease" };
      }
      const failure = heartbeatRunFailure();
      await options.journal.append(options.runId, {
        id: "run.failed:heartbeat",
        type: "run.failed",
        data: failure,
      });
      return { status: "failed", error: failure.message };
    }
    if (producerFailed && !cancellationObserved) {
      const failure = safeRunFailure(producerFailure);
      if (!await renewLease()) return { status: "lost-lease" };
      await options.journal.append(options.runId, {
        id: "run.failed",
        type: "run.failed",
        data: failure,
      });
      return { status: "failed", error: failure.message };
    }
    if (cancellationObserved) {
      if (!await renewLease()) return { status: "lost-lease" };
      await options.journal.append(options.runId, {
        id: "run.cancelled",
        type: "run.cancelled",
        data: {},
      });
      await options.cancellationStore?.clear(options.runId);
      return { status: "cancelled" };
    }
    if (!await renewLease()) return { status: "lost-lease" };
    await options.journal.append(options.runId, {
      id: "run.completed",
      type: "run.completed",
      data: {},
    });
    return { status: "completed" };
  } finally {
    try {
      await stopAndDrainHeartbeat();
    } catch {
      // heartbeatPromise installs its rejection handler when it is created;
      // this guard also keeps a cleanup defect from replacing the primary
      // producer/lifecycle result.
    }
    try {
      await options.leaseStore.release(options.runId, activeLease);
    } catch {
      // A release acknowledgement failure cannot invalidate an already
      // durable terminal result. The bounded lease remains the recovery fence.
    }
  }
}

async function inspectOwnedRunHistory(
  store: RunEventStore,
  runId: string,
): Promise<{ started: boolean; terminal: boolean }> {
  const bounds = await store.bounds(runId);
  if (bounds && parseRunEventCursor(bounds.firstCursor) !== 1) {
    throw new RunEventCursorExpiredError(
      "Run lifecycle history is incomplete; producer execution cannot be admitted safely",
    );
  }
  let cursor: string | undefined;
  let started = false;
  let executionObserved = false;
  while (true) {
    const page = await store.listAfter(runId, cursor, MAX_RUN_EVENT_PAGE_SIZE);
    for (const event of page.events) {
      if (event.type === "run.started") started = true;
      else if (event.type !== "run.accepted") executionObserved = true;
      if (isTerminalRunStreamEvent(event)) return { started, terminal: true };
    }
    if (!page.hasMore) {
      if (started || executionObserved) return { started: true, terminal: false };
      return { started: false, terminal: false };
    }
    if (page.nextCursor === cursor) {
      throw new RunDeliveryValidationError("Run event store did not advance its cursor");
    }
    cursor = page.nextCursor;
  }
}

function validateTimings(heartbeatIntervalMs: number, leaseDurationMs: number): void {
  if (!Number.isInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 1) {
    throw new RunDeliveryValidationError("heartbeatIntervalMs must be a positive integer");
  }
  if (!Number.isInteger(leaseDurationMs) || leaseDurationMs < 2) {
    throw new RunDeliveryValidationError("leaseDurationMs must be an integer greater than one");
  }
  if (heartbeatIntervalMs >= leaseDurationMs) {
    throw new RunDeliveryValidationError("heartbeatIntervalMs must be shorter than leaseDurationMs");
  }
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error && error.message.trim()
    ? error.message.trim()
    : "Run execution failed";
  return message.slice(0, 2_000);
}

type SafeRunFailure = Record<string, RunEventJsonValue> & { message: string };

function heartbeatRunFailure(): SafeRunFailure {
  // Store errors may contain SQL, credentials or transport internals. The
  // durable journal exposes only a stable retryable classification.
  return {
    message: "Run execution heartbeat failed",
    code: "run_heartbeat_failed",
    retryable: true,
  };
}

function safeRunFailure(error: unknown): SafeRunFailure {
  if (error instanceof ToolReceiptSettlementError) {
    return {
      message: error.message,
      code: error.code,
      errorClass: error.name,
      operation: error.operation,
      attempts: error.attempts,
      ...(error.causeCode ? { causeCode: error.causeCode } : {}),
    };
  }
  return { message: safeErrorMessage(error) };
}
