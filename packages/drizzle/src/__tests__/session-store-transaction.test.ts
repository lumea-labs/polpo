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
});
