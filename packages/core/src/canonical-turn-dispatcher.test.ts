import { describe, expect, it, vi } from "vitest";
import type { CanonicalTurnCommitted } from "./canonical-turn.js";
import {
  CanonicalTurnOutboxDispatcher,
  MAX_CANONICAL_TURN_DISPATCH_LIMIT,
} from "./canonical-turn-dispatcher.js";
import type { CanonicalTurnOutboxEntry, SessionStore } from "./session-store.js";

function turn(turnId: string): CanonicalTurnCommitted {
  return {
    turnId,
    sessionId: "session-1",
    agentName: "assistant",
    surface: "chat",
    terminalStatus: "succeeded",
    userMessage: { id: `user-${turnId}`, role: "user" },
    assistantMessage: { id: `assistant-${turnId}`, role: "assistant" },
    trustedInvocation: { externalUserId: "user-1" },
    occurredAt: "2026-08-30T10:00:00.000Z",
  };
}

function entry(turnId: string, attempts = 0): CanonicalTurnOutboxEntry {
  return {
    turn: turn(turnId),
    status: "pending",
    attempts,
    createdAt: "2026-08-30T10:00:00.000Z",
    updatedAt: "2026-08-30T10:00:00.000Z",
  };
}

function store(overrides: Partial<SessionStore> = {}): SessionStore {
  return {
    listPendingCanonicalTurns: vi.fn(async () => []),
    markCanonicalTurnDispatched: vi.fn(async () => true),
    recordCanonicalTurnDispatchFailure: vi.fn(async () => true),
    ...overrides,
  } as unknown as SessionStore;
}

describe("CanonicalTurnOutboxDispatcher", () => {
  it("dispatches committed turns and acknowledges them only after delivery", async () => {
    const calls: string[] = [];
    const sessionStore = store({
      listPendingCanonicalTurns: vi.fn(async () => [entry("turn-1"), entry("turn-2")]),
      markCanonicalTurnDispatched: vi.fn(async (turnId) => {
        calls.push(`ack:${turnId}`);
        return true;
      }),
    });
    const dispatcher = new CanonicalTurnOutboxDispatcher({
      sessionStore,
      handler: {
        dispatch: vi.fn(async (value) => {
          calls.push(`dispatch:${value.turnId}`);
        }),
      },
    });

    await expect(dispatcher.dispatchPending(2)).resolves.toEqual({
      scanned: 2,
      dispatched: 2,
      failed: 0,
      superseded: 0,
    });
    expect(calls).toEqual([
      "dispatch:turn-1",
      "ack:turn-1",
      "dispatch:turn-2",
      "ack:turn-2",
    ]);
  });

  it("keeps a failed delivery pending and increments its durable attempt count", async () => {
    const recordFailure = vi.fn(async () => true);
    const acknowledge = vi.fn(async () => true);
    const sessionStore = store({
      listPendingCanonicalTurns: vi.fn(async () => [entry("turn-1")]),
      markCanonicalTurnDispatched: acknowledge,
      recordCanonicalTurnDispatchFailure: recordFailure,
    });
    const dispatcher = new CanonicalTurnOutboxDispatcher({
      sessionStore,
      handler: { dispatch: vi.fn(async () => { throw new Error("queue unavailable"); }) },
    });

    await expect(dispatcher.dispatchPending()).resolves.toEqual({
      scanned: 1,
      dispatched: 0,
      failed: 1,
      superseded: 0,
    });
    expect(recordFailure).toHaveBeenCalledWith("turn-1");
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it("treats an already acknowledged row as a concurrent supersession", async () => {
    const sessionStore = store({
      listPendingCanonicalTurns: vi.fn(async () => [entry("turn-1")]),
      markCanonicalTurnDispatched: vi.fn(async () => false),
    });
    const dispatcher = new CanonicalTurnOutboxDispatcher({
      sessionStore,
      handler: { dispatch: vi.fn(async () => {}) },
    });

    await expect(dispatcher.dispatchPending()).resolves.toEqual({
      scanned: 1,
      dispatched: 0,
      failed: 0,
      superseded: 1,
    });
  });

  it("fails closed when the store cannot provide a durable outbox", async () => {
    const dispatcher = new CanonicalTurnOutboxDispatcher({
      sessionStore: store({ listPendingCanonicalTurns: undefined }),
      handler: { dispatch: vi.fn(async () => {}) },
    });
    await expect(dispatcher.dispatchPending()).rejects.toThrow(
      "requires durable outbox support",
    );
  });

  it.each([0, -1, 1.5, Number.NaN, MAX_CANONICAL_TURN_DISPATCH_LIMIT + 1])(
    "rejects an invalid batch limit (%s)",
    async (limit) => {
      const sessionStore = store();
      const dispatcher = new CanonicalTurnOutboxDispatcher({
        sessionStore,
        handler: { dispatch: vi.fn(async () => {}) },
      });
      await expect(dispatcher.dispatchPending(limit)).rejects.toThrow("limit must be an integer");
      expect(sessionStore.listPendingCanonicalTurns).not.toHaveBeenCalled();
    },
  );
});
