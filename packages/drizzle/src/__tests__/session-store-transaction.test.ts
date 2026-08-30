import { describe, expect, it, vi } from "vitest";
import { DrizzleSessionStore } from "../stores/session-store.js";

describe("DrizzleSessionStore transaction provider", () => {
  it("prefers the explicit provider and fails without falling back to the primary driver", async () => {
    const providerError = new Error("transaction provider unavailable");
    const primaryTransaction = vi.fn(() => {
      throw new Error("No transactions support in primary driver");
    });
    const transactionProvider = vi.fn(async () => {
      throw providerError;
    });
    const store = new DrizzleSessionStore(
      { transaction: primaryTransaction },
      {},
      {},
      {},
      "pg",
      transactionProvider,
      {},
    );

    await expect(store.prepareContinuation({
      sessionId: "session-1",
      toolCallId: "call-1",
      result: "configured",
      expectedSessionVersion: 1,
      idempotencyKey: "idem-1",
      fingerprint: "fingerprint-1",
      runId: "run-1",
    })).rejects.toBe(providerError);

    expect(transactionProvider).toHaveBeenCalledOnce();
    expect(primaryTransaction).not.toHaveBeenCalled();
  });

  it("does not fall back when canonical-turn transaction acquisition fails", async () => {
    const providerError = new Error("canonical transaction provider unavailable");
    const primaryTransaction = vi.fn(() => {
      throw new Error("No transactions support in primary driver");
    });
    const transactionProvider = vi.fn(async () => {
      throw providerError;
    });
    const store = new DrizzleSessionStore(
      { transaction: primaryTransaction },
      {},
      {},
      {},
      "pg",
      transactionProvider,
      {},
    );

    await expect(store.commitCanonicalTurn({
      turn: {
        turnId: "turn-1",
        sessionId: "session-1",
        agentName: "assistant",
        surface: "chat",
        terminalStatus: "succeeded",
        userMessage: { id: "user-message-1", role: "user" },
        assistantMessage: { id: "assistant-message-1", role: "assistant" },
        trustedInvocation: {},
        occurredAt: "2026-08-30T10:00:00.000Z",
      },
      assistant: {
        messageId: "assistant-message-1",
        content: "done",
      },
    })).rejects.toBe(providerError);

    expect(transactionProvider).toHaveBeenCalledOnce();
    expect(primaryTransaction).not.toHaveBeenCalled();
  });
});
