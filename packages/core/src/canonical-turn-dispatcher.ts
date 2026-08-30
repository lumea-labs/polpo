import type { CanonicalTurnCommitted } from "./canonical-turn.js";
import type { SessionStore } from "./session-store.js";

export const DEFAULT_CANONICAL_TURN_DISPATCH_LIMIT = 100;
export const MAX_CANONICAL_TURN_DISPATCH_LIMIT = 1_000;

export interface CanonicalTurnDispatchHandler {
  /**
   * Deliver one committed turn to a durable host queue.
   *
   * Delivery is at-least-once. Consumers must use `turn.turnId` as their
   * idempotency key because a process may stop after delivery and before ack.
   */
  dispatch(turn: CanonicalTurnCommitted): Promise<void>;
}

export interface CanonicalTurnDispatchResult {
  readonly scanned: number;
  readonly dispatched: number;
  readonly failed: number;
  readonly superseded: number;
}

export interface CanonicalTurnOutboxDispatcherOptions {
  readonly sessionStore: SessionStore;
  readonly handler: CanonicalTurnDispatchHandler;
}

/** Reconciles committed canonical turns into a host-owned durable queue. */
export class CanonicalTurnOutboxDispatcher {
  constructor(private readonly options: CanonicalTurnOutboxDispatcherOptions) {}

  async dispatchPending(
    limit = DEFAULT_CANONICAL_TURN_DISPATCH_LIMIT,
  ): Promise<CanonicalTurnDispatchResult> {
    assertDispatchLimit(limit);
    const {
      listPendingCanonicalTurns,
      markCanonicalTurnDispatched,
      recordCanonicalTurnDispatchFailure,
    } = this.options.sessionStore;
    if (
      !listPendingCanonicalTurns
      || !markCanonicalTurnDispatched
      || !recordCanonicalTurnDispatchFailure
    ) {
      throw new Error("Canonical turn dispatch requires durable outbox support");
    }

    const pending = await listPendingCanonicalTurns.call(this.options.sessionStore, limit);
    let dispatched = 0;
    let failed = 0;
    let superseded = 0;
    for (const entry of pending) {
      try {
        await this.options.handler.dispatch(entry.turn);
        const acknowledged = await markCanonicalTurnDispatched.call(
          this.options.sessionStore,
          entry.turn.turnId,
        );
        if (acknowledged) dispatched += 1;
        else superseded += 1;
      } catch {
        failed += 1;
        await recordCanonicalTurnDispatchFailure.call(
          this.options.sessionStore,
          entry.turn.turnId,
        );
      }
    }
    return {
      scanned: pending.length,
      dispatched,
      failed,
      superseded,
    };
  }
}

function assertDispatchLimit(limit: number): void {
  if (
    !Number.isSafeInteger(limit)
    || limit < 1
    || limit > MAX_CANONICAL_TURN_DISPATCH_LIMIT
  ) {
    throw new TypeError(
      `limit must be an integer between 1 and ${MAX_CANONICAL_TURN_DISPATCH_LIMIT}`,
    );
  }
}
