import { describe, expect, it } from "vitest";
import {
  InMemoryToolExecutionReceiptStore,
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
});
