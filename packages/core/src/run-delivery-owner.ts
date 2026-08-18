import {
  RunDeliveryValidationError,
  type RunCancellationStore,
  type RunEventStore,
  type RunExecutionLease,
  type RunExecutionLeaseStore,
} from "./run-delivery.js";
import { RunEventJournal } from "./run-delivery-follower.js";

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

/** Execute one run under a renewable lease. Only explicit cancellation aborts an owner. */
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
      const renewed = makeLease();
      if (!await options.leaseStore.renew(options.runId, renewed)) {
        lostLease = true;
        controller.abort("run_lease_lost");
        return;
      }
      activeLease = renewed;
    }
  };

  let heartbeatPromise: Promise<void> | undefined;
  try {
    await options.journal.append(options.runId, {
      id: "run.started",
      type: "run.started",
      data: {},
    });
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
      heartbeatPromise = heartbeat();
    }

    try {
      await options.producer({
        runId: options.runId,
        signal: controller.signal,
        journal: options.journal,
      });
    } catch (error) {
      if (lostLease) return { status: "lost-lease" };
      if (!cancellationObserved) {
        const message = safeErrorMessage(error);
        await options.journal.append(options.runId, {
          id: "run.failed",
          type: "run.failed",
          data: { message },
        });
        return { status: "failed", error: message };
      }
    }

    if (lostLease) return { status: "lost-lease" };
    if (cancellationObserved) {
      await options.journal.append(options.runId, {
        id: "run.cancelled",
        type: "run.cancelled",
        data: {},
      });
      await options.cancellationStore?.clear(options.runId);
      return { status: "cancelled" };
    }
    await options.journal.append(options.runId, {
      id: "run.completed",
      type: "run.completed",
      data: {},
    });
    return { status: "completed" };
  } finally {
    stopHeartbeat = true;
    releaseHeartbeatWait?.();
    await heartbeatPromise;
    await options.leaseStore.release(options.runId, activeLease);
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
