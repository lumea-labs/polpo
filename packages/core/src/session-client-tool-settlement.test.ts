import { describe, expect, it } from "vitest";
import type { Message, Session } from "./session-store.js";
import {
  assertClientToolSettlementScope,
  normalizeClientToolSettlement,
  projectClientToolSettlements,
  publicClientToolSettlementReceipt,
  resolveClientToolSettlementTarget,
  type SettleClientToolInput,
  type StoredClientToolSettlement,
} from "./session-client-tool-settlement.js";

const input: SettleClientToolInput = {
  sessionId: "session-ncc-fixture", toolCallId: "call_never_accepted_fixture_c",
  agent: "leo", user: "external-user", expectedSessionVersion: 44,
  idempotencyKey: "recover-call", outcome: "cancelled", reason: "Request was never accepted",
};
const session: Session = {
  id: input.sessionId, agent: input.agent, user: input.user,
  createdAt: "2026-10-17T00:00:00Z", updatedAt: "2026-10-17T00:00:00Z", messageCount: 1,
};
const assistant: Message = {
  id: "assistant", role: "assistant", content: "", ts: "2026-10-17T00:00:00Z",
  toolCalls: [{
    id: input.toolCallId, name: "apply_site_change", state: "interrupted",
    continuationClientTools: [{ type: "function", function: { name: "apply_site_change" } }],
  }],
};
const receipt: StoredClientToolSettlement = {
  id: "settlement", sessionId: input.sessionId, toolCallId: input.toolCallId,
  sourceAssistantMessageId: "assistant", resultMessageId: "result", outcome: "cancelled",
  sessionVersion: 45, settledAt: "2026-10-17T01:00:00Z", idempotencyKey: "key", fingerprint: "a".repeat(64),
};
const result: Message = {
  id: "result", role: "tool", content: '{"ok":false,"outcome":"cancelled","error":"Cancelled"}',
  toolCallId: input.toolCallId, ts: receipt.settledAt,
};

describe("client-tool settlement domain", () => {
  it("fingerprints semantics independently of delivery version/key and binds exact scope", async () => {
    const first = await normalizeClientToolSettlement(input);
    expect(await normalizeClientToolSettlement({ ...input, expectedSessionVersion: 45, idempotencyKey: "retry" }))
      .toEqual(first);
    for (const change of [{ user: "other" }, { agent: "other" }, { reason: "different" }, { scope: { key: "partition" } }]) {
      expect((await normalizeClientToolSettlement({ ...input, ...change })).fingerprint).not.toBe(first.fingerprint);
    }
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(first.content)).toEqual({ ok: false, outcome: "cancelled", error: input.reason });
  });

  it.each(["success", "failed", "cancelled"] as const)("preserves exact JSON-looking result strings for %s", async (outcome) => {
    const value = '[1, {"text":"à\\n"}]';
    const normalized = await normalizeClientToolSettlement({
      sessionId: "s", toolCallId: "c", expectedSessionVersion: 0,
      idempotencyKey: "k", outcome, result: value,
    });
    expect(JSON.parse(normalized.content).result).toBe(value);
    expect(JSON.parse(normalized.content).ok).toBe(outcome === "success");
  });

  it.each([
    { expectedSessionVersion: -1 }, { expectedSessionVersion: 1.5 },
    { idempotencyKey: " " }, { outcome: "completed" }, { outcome: "success", result: undefined },
    { result: { unvalidated: true } }, { result: "🍋".repeat(20_000) }, { reason: "x".repeat(5000) },
  ])("rejects malformed or oversized input before a store transaction %#", async (change) => {
    await expect(normalizeClientToolSettlement({ ...input, ...change } as any))
      .rejects.toMatchObject({ code: "invalid_client_tool_settlement" });
  });

  it("requires exact agent, external user and trusted partition", () => {
    expect(() => assertClientToolSettlementScope(session, input)).not.toThrow();
    for (const change of [{ user: undefined }, { agent: undefined }, { scope: { key: "forged" } }]) {
      expect(() => assertClientToolSettlementScope(session, { ...input, ...change }))
        .toThrowError(expect.objectContaining({ code: "client_tool_settlement_scope_mismatch" }));
    }
  });

  it("resolves an exact older pending client call and rejects ambiguity or server tools", () => {
    const later: Message = { id: "later", role: "user", content: "later", ts: result.ts };
    expect(resolveClientToolSettlementTarget([assistant, later], input.toolCallId).message.id).toBe("assistant");
    expect(() => resolveClientToolSettlementTarget([assistant, { ...assistant, id: "duplicate" }], input.toolCallId))
      .toThrowError(expect.objectContaining({ code: "client_tool_settlement_corrupt" }));
    const server = structuredClone(assistant);
    delete server.toolCalls![0]!.continuationClientTools;
    expect(() => resolveClientToolSettlementTarget([server], input.toolCallId))
      .toThrowError(expect.objectContaining({ code: "client_tool_call_unverifiable" }));
    expect(() => resolveClientToolSettlementTarget([assistant, result], input.toolCallId))
      .toThrowError(expect.objectContaining({ code: "client_tool_call_not_pending" }));
  });

  it("places a late result next to its source and keeps cancellation terminal on every read", () => {
    const later: Message = { id: "later", role: "user", content: "later", ts: result.ts };
    const physical = [assistant, later, result];
    const projected = projectClientToolSettlements(physical, [receipt]);
    expect(projected.map(message => message.id)).toEqual(["assistant", "result", "later"]);
    expect(projected[0]!.toolCalls![0]).toMatchObject({ state: "error", settlementOutcome: "cancelled" });
    expect(projected[0]!.toolCalls![0]).not.toHaveProperty("continuationClientTools");
    expect(projectClientToolSettlements(projected, [receipt])).toEqual(projected);
    expect(physical[0]!.toolCalls![0]!.state).toBe("interrupted");
  });

  it.each(["success", "failed", "cancelled"] as const)("materializes %s without changing the stored result", (outcome) => {
    const typedResult = { ...result, content: JSON.stringify({ ok: outcome === "success", outcome,
      ...(outcome === "success" ? { result: "complete" } : { error: "Stopped" }) }) };
    const projected = projectClientToolSettlements([assistant, typedResult], [{ ...receipt, outcome }]);
    expect(projected[0]!.toolCalls![0]).toMatchObject({
      state: outcome === "success" ? "completed" : "error", settlementOutcome: outcome, result: typedResult.content,
    });
  });

  it("fails closed on a receipt missing its result and on duplicate receipt identities", () => {
    expect(() => projectClientToolSettlements([assistant], [receipt]))
      .toThrowError(expect.objectContaining({ code: "client_tool_settlement_corrupt" }));
    expect(() => projectClientToolSettlements([assistant, result], [receipt, receipt]))
      .toThrowError(expect.objectContaining({ code: "client_tool_settlement_corrupt" }));
  });

  it("keeps legacy ordinary continuation projection and never exposes internal receipt fields", () => {
    expect(projectClientToolSettlements([assistant, result], [])[0]!.toolCalls![0]!.state).toBe("completed");
    const publicReceipt = publicClientToolSettlementReceipt(receipt);
    expect(publicReceipt).not.toHaveProperty("fingerprint");
    expect(publicReceipt).not.toHaveProperty("idempotencyKey");
    expect(publicReceipt).not.toHaveProperty("runId");
  });

  it("orders settled and ordinary sibling results by the assistant declaration", () => {
    const source: Message = { ...assistant, toolCalls: [
      { id: "ordinary", name: "ordinary", state: "completed", result: "ok" },
      assistant.toolCalls![0]!,
    ] };
    const ordinary: Message = { id: "ordinary-result", role: "tool", content: "ok", toolCallId: "ordinary", ts: assistant.ts };
    const later: Message = { id: "later", role: "user", content: "next", ts: result.ts };
    const projected = projectClientToolSettlements([source, ordinary, later, result], [receipt]);
    expect(projected.map(message => message.id)).toEqual(["assistant", "ordinary-result", "result", "later"]);
  });

  it("uses declared order for multiple settlements even when receipt and physical order differ", () => {
    const secondCall = { ...assistant.toolCalls![0]!, id: "second-call" };
    const source: Message = { ...assistant, toolCalls: [secondCall, assistant.toolCalls![0]!] };
    const secondResult: Message = { ...result, id: "second-result", toolCallId: secondCall.id };
    const secondReceipt: StoredClientToolSettlement = { ...receipt, id: "second-settlement", toolCallId: secondCall.id, resultMessageId: secondResult.id };
    expect(projectClientToolSettlements([source, result, secondResult], [receipt, secondReceipt]).map(message => message.id))
      .toEqual(["assistant", "second-result", "result"]);
  });

  it("does not depend on trusted scope object property order", async () => {
    const scoped = { ...input, scope: { key: "project:prod", version: "2" } };
    const reordered = { ...input, scope: { version: "2", key: "project:prod" } };
    expect(await normalizeClientToolSettlement(scoped)).toEqual(await normalizeClientToolSettlement(reordered));
    expect(() => assertClientToolSettlementScope({ ...session, scope: scoped.scope }, reordered)).not.toThrow();
  });

  it.each(["invalid-json", '[{"ok":false}]', '{"ok":true,"outcome":"success","result":"forged"}'])("rejects inconsistent persisted result content %#", content => {
    expect(() => projectClientToolSettlements([assistant, { ...result, content }], [receipt]))
      .toThrowError(expect.objectContaining({ code: "client_tool_settlement_corrupt" }));
  });

  it.each([
    { sessionVersion: "garbage" }, { sessionVersion: -1 }, { sessionVersion: 1.5 },
    { settledAt: 17 }, { settledAt: "not-a-date" }, { id: "" }, { sourceAssistantMessageId: 8 },
    { fingerprint: "invalid" }, { idempotencyKey: "" },
  ])("rejects corrupt stored receipt fields %#", change => {
    expect(() => projectClientToolSettlements([assistant, result], [{ ...receipt, ...change } as any]))
      .toThrowError(expect.objectContaining({ code: "client_tool_settlement_corrupt" }));
  });
});
