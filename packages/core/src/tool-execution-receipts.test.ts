import { describe, expect, it, vi } from "vitest";
import {
  InMemoryToolExecutionReceiptStore,
  ToolReceiptSettlementError,
  settleToolExecutionReceiptWithRetry,
  toolArgumentsFingerprint,
} from "./tool-execution-receipts.js";

describe("tool execution receipts", () => {
  it("replays a completed receipt without admitting a second execution", async () => {
    const store = new InMemoryToolExecutionReceiptStore();
    const argumentsFingerprint = toolArgumentsFingerprint("write", { b: 2, a: 1 });
    await expect(store.claim({ callId: "call-1", toolName: "write", contractFingerprint: "contract-1", argumentsFingerprint }))
      .resolves.toMatchObject({ action: "execute" });
    await store.settle({ callId: "call-1", state: "completed", result: "ok" });
    await expect(store.claim({
      callId: "call-1",
      toolName: "write",
      contractFingerprint: "contract-1",
      argumentsFingerprint: toolArgumentsFingerprint("write", { a: 1, b: 2 }),
    })).resolves.toMatchObject({ action: "replay", result: "ok" });
  });

  it("rejects concurrent or uncertain replay and changed contracts", async () => {
    const store = new InMemoryToolExecutionReceiptStore();
    const fingerprint = toolArgumentsFingerprint("charge", { cents: 100 });
    await store.claim({ callId: "call-1", toolName: "charge", contractFingerprint: "contract-1", argumentsFingerprint: fingerprint });
    await expect(store.claim({ callId: "call-1", toolName: "charge", contractFingerprint: "contract-1", argumentsFingerprint: fingerprint }))
      .resolves.toMatchObject({ action: "reject", code: "tool_outcome_unknown" });
    await expect(store.claim({
      callId: "call-1",
      toolName: "charge",
      contractFingerprint: "contract-1",
      argumentsFingerprint: toolArgumentsFingerprint("charge", { cents: 200 }),
    })).resolves.toMatchObject({ action: "reject", code: "resume_contract_mismatch" });
    await expect(store.claim({
      callId: "call-1",
      toolName: "charge",
      contractFingerprint: "contract-2",
      argumentsFingerprint: fingerprint,
    })).resolves.toMatchObject({ action: "reject", code: "resume_contract_mismatch" });
  });

  it("retries only the same settlement after a failure before commit", async () => {
    const input = { callId: "call-1", state: "completed" as const, result: "created" };
    const settle = vi.fn()
      .mockRejectedValueOnce(new Error("temporary write failure"))
      .mockResolvedValueOnce({
        callId: "call-1",
        toolName: "create",
        contractFingerprint: "contract-1",
        argumentsFingerprint: "arguments-1",
        state: "completed",
        result: "created",
      });

    await expect(settleToolExecutionReceiptWithRetry(
      { claim: vi.fn(), settle },
      input,
    )).resolves.toMatchObject({ state: "completed", result: "created" });

    expect(settle).toHaveBeenCalledTimes(2);
    expect(settle.mock.calls).toEqual([[input], [input]]);
  });

  it("confirms the same settlement after the first acknowledgement is lost", async () => {
    const store = new InMemoryToolExecutionReceiptStore();
    await store.claim({
      callId: "call-1",
      toolName: "create",
      contractFingerprint: "contract-1",
      argumentsFingerprint: "arguments-1",
    });
    const settle = vi.fn(async (...args: Parameters<typeof store.settle>) => {
      const receipt = await store.settle(...args);
      if (settle.mock.calls.length === 1) throw new Error("acknowledgement lost");
      return receipt;
    });
    const input = { callId: "call-1", state: "completed" as const, result: "created" };

    await expect(settleToolExecutionReceiptWithRetry(
      { claim: store.claim.bind(store), settle },
      input,
    )).resolves.toMatchObject({ state: "completed", result: "created" });

    expect(settle).toHaveBeenCalledTimes(2);
    await expect(store.claim({
      callId: "call-1",
      toolName: "create",
      contractFingerprint: "contract-1",
      argumentsFingerprint: "arguments-1",
    })).resolves.toMatchObject({ action: "replay", result: "created" });
  });

  it("bounds failed settlement attempts and exposes only structured safe diagnostics", async () => {
    const databaseError = Object.assign(
      new Error("UPDATE tool_execution_receipts params: secret customer payload"),
      { code: "40001" },
    );
    const settle = vi.fn(async () => { throw databaseError; });

    const failure = await settleToolExecutionReceiptWithRetry(
      { claim: vi.fn(), settle },
      { callId: "call-1", state: "completed", result: "secret customer payload" },
    ).catch((error: unknown) => error);

    expect(settle).toHaveBeenCalledTimes(3);
    expect(failure).toBeInstanceOf(ToolReceiptSettlementError);
    expect(failure).toMatchObject({
      message: "Tool receipt settlement failed",
      code: "tool_receipt_settlement_failed",
      operation: "tool_receipt_settle",
      attempts: 3,
      causeCode: "40001",
    });
    expect(JSON.stringify(failure)).not.toContain("secret customer payload");
  });

  it("does not begin another settlement attempt after abort", async () => {
    const controller = new AbortController();
    const settle = vi.fn(async () => {
      controller.abort("run_lease_lost");
      throw new Error("write interrupted");
    });

    const failure = await settleToolExecutionReceiptWithRetry(
      { claim: vi.fn(), settle },
      { callId: "call-1", state: "completed", result: "created" },
      { signal: controller.signal },
    ).catch((error: unknown) => error);

    expect(settle).toHaveBeenCalledTimes(1);
    expect(failure).toMatchObject({
      code: "tool_receipt_settlement_failed",
      attempts: 1,
    });
  });

  it("still makes the first settlement attempt for a result obtained before abort", async () => {
    const controller = new AbortController();
    controller.abort("run_lease_lost");
    const settle = vi.fn(async () => ({
      callId: "call-1",
      toolName: "create",
      contractFingerprint: "contract-1",
      argumentsFingerprint: "arguments-1",
      state: "completed" as const,
      result: "created",
    }));

    await expect(settleToolExecutionReceiptWithRetry(
      { claim: vi.fn(), settle },
      { callId: "call-1", state: "completed", result: "created" },
      { signal: controller.signal },
    )).resolves.toMatchObject({ state: "completed", result: "created" });
    expect(settle).toHaveBeenCalledOnce();
  });

  it("rechecks abort immediately before a retry after its timer resolves", async () => {
    let abortReads = 0;
    const signal = {
      get aborted() {
        abortReads += 1;
        return abortReads >= 3;
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;
    const settle = vi.fn()
      .mockRejectedValueOnce(new Error("temporary write failure"))
      .mockResolvedValueOnce({ state: "completed", result: "created" });

    const failure = await settleToolExecutionReceiptWithRetry(
      { claim: vi.fn(), settle },
      { callId: "call-1", state: "completed", result: "created" },
      { signal },
    ).catch((error: unknown) => error);

    expect(settle).toHaveBeenCalledOnce();
    expect(failure).toMatchObject({
      code: "tool_receipt_settlement_failed",
      attempts: 1,
    });
  });

  it("does not expose arbitrary alphanumeric error codes", async () => {
    const controller = new AbortController();
    controller.abort("run_lease_lost");
    const settle = vi.fn(async () => {
      throw Object.assign(new Error("database failure"), { code: "INTERNAL42" });
    });

    const failure = await settleToolExecutionReceiptWithRetry(
      { claim: vi.fn(), settle },
      { callId: "call-1", state: "completed", result: "secret" },
      { signal: controller.signal },
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "tool_receipt_settlement_failed",
      attempts: 1,
    });
    expect((failure as ToolReceiptSettlementError).causeCode).toBeUndefined();
    expect(JSON.stringify(failure)).not.toContain("INTERNAL42");
  });

  it("keeps diagnostic extraction best-effort when code and cause getters throw", async () => {
    const controller = new AbortController();
    controller.abort("run_lease_lost");
    const hostile = new Error("database failure");
    Object.defineProperties(hostile, {
      code: { get: () => { throw new Error("code getter failure"); } },
      cause: { get: () => { throw new Error("cause getter failure"); } },
    });
    const settle = vi.fn(async () => { throw hostile; });

    const failure = await settleToolExecutionReceiptWithRetry(
      { claim: vi.fn(), settle },
      { callId: "call-1", state: "completed", result: "secret" },
      { signal: controller.signal },
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      message: "Tool receipt settlement failed",
      code: "tool_receipt_settlement_failed",
      attempts: 1,
    });
    expect((failure as ToolReceiptSettlementError).causeCode).toBeUndefined();
  });
});
