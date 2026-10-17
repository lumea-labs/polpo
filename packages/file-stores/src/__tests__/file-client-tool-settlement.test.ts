import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileSessionStore } from "../file-session-store.js";
import type { SettleClientToolInput } from "@polpo-ai/core/session-client-tool-settlement";

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function fixture(call = "call_never_accepted_fixture_c") {
  const dir = mkdtempSync(join(tmpdir(), "polpo-settlement-")); dirs.push(dir);
  const store = new FileSessionStore(dir);
  const sessionId = await store.create({ agent: "leo", user: "fabio-fixture", scope: { key: "tenant:prod", version: "1" } });
  const assistant = await store.addMessage(sessionId, "assistant", "prepared");
  const toolCalls = [{ id: call, name: "change_site", state: "interrupted" as const,
    continuationClientTools: [{ type: "function" as const, function: { name: "change_site" } }] }];
  await store.updateMessage(sessionId, assistant.id, assistant.content, toolCalls);
  const input: SettleClientToolInput = { sessionId, toolCallId: call, agent: "leo", user: "fabio-fixture",
    scope: { key: "tenant:prod", version: "1" }, expectedSessionVersion: 1, idempotencyKey: "repair",
    outcome: "cancelled", reason: "No continuation accepted" };
  return { dir, store, assistant, toolCalls, input };
}

function continuation(input: SettleClientToolInput) {
  return { ...input, result: "executed", fingerprint: "continuation-payload", runId: "run-accepted" };
}

describe("FileSessionStore settlement", () => {
  it.each(["call_never_accepted_fixture_a", "call_never_accepted_fixture_b", "call_never_accepted_fixture_c"])("settles the never-accepted production shape %s, reopens and retries", async call => {
    const { store, dir, input } = await fixture(call);
    expect(await store.getClientToolResolution(input)).toMatchObject({ status: "pending", continuationAccepted: false });
    const settled = await store.settleClientTool(input);
    expect(settled).toMatchObject({ status: "settled", receipt: { outcome: "cancelled", sessionVersion: 2, toolCallId: call } });
    expect(settled.receipt).not.toHaveProperty("runId");
    expect(settled.receipt).not.toHaveProperty("fingerprint");
    const reopened = new FileSessionStore(dir);
    expect(await reopened.getClientToolResolution(input)).toMatchObject({ status: "settled", receipt: settled.receipt });
    expect(await reopened.settleClientTool({ ...input, expectedSessionVersion: 0, idempotencyKey: "retry-new-key" }))
      .toEqual({ status: "replay", receipt: settled.receipt });
    const messages = await reopened.getMessages(input.sessionId);
    expect(messages).toHaveLength(2);
    expect(messages[0]!.toolCalls![0]).toMatchObject({ state: "error", settlementOutcome: "cancelled" });
    expect(messages[0]!.toolCalls![0]).not.toHaveProperty("continuationClientTools");
    expect(JSON.parse(messages[1]!.content as string)).toEqual({ ok: false, outcome: "cancelled", error: input.reason });
  });

  it("acceptance stays authoritative and cannot be overwritten even with a missing Run", async () => {
    const { store, input } = await fixture();
    await store.prepareContinuation(continuation(input));
    expect(await store.getClientToolResolution(input)).toMatchObject({ status: "continuation", continuationAccepted: true,
      receipt: { runId: "run-accepted", toolCallId: input.toolCallId } });
    await expect(store.settleClientTool(input)).rejects.toMatchObject({ code: "continuation_already_accepted",
      continuation: { runId: "run-accepted" } });
    expect(await store.getMessages(input.sessionId)).toHaveLength(2);
  });

  it("serializes competing outcomes and accepts exactly one receipt", async () => {
    const { store, dir, input } = await fixture();
    const other = new FileSessionStore(dir);
    const results = await Promise.allSettled(Array.from({ length: 30 }, (_, index) =>
      (index % 2 ? store : other).settleClientTool({ ...input, idempotencyKey: `key-${index}`, outcome: index % 2 ? "failed" : "cancelled" })));
    expect(results.filter(result => result.status === "fulfilled" && result.value.status === "settled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(15);
    expect(await store.getMessages(input.sessionId)).toHaveLength(2);
  });

  it("serializes settlement against continuation and never produces both receipts", async () => {
    const { store, input } = await fixture();
    const results = await Promise.allSettled([store.settleClientTool(input), store.prepareContinuation(continuation(input))]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const resolution = await store.getClientToolResolution(input);
    expect(["settled", "continuation"]).toContain(resolution.status);
    expect(await store.getMessages(input.sessionId)).toHaveLength(2);
  });

  it("keeps scope, stale version, conflicting replay and reused keys fail closed", async () => {
    const { store, input } = await fixture();
    await expect(store.settleClientTool({ ...input, user: "other" })).rejects.toMatchObject({ code: "client_tool_settlement_scope_mismatch" });
    await expect(store.getClientToolResolution({ ...input, scope: undefined })).rejects.toMatchObject({ code: "client_tool_settlement_scope_mismatch" });
    await expect(store.settleClientTool({ ...input, expectedSessionVersion: 0 })).rejects.toMatchObject({ code: "session_version_conflict" });
    await store.settleClientTool(input);
    await expect(store.settleClientTool({ ...input, reason: "different" })).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(store.settleClientTool({ ...input, idempotencyKey: "other", reason: "different" })).rejects.toMatchObject({ code: "client_tool_settlement_conflict" });
  });

  it("protects settled calls from stale finalizer and rename writes", async () => {
    const { store, input, assistant, toolCalls } = await fixture();
    await store.settleClientTool(input);
    await Promise.all([store.updateMessage(input.sessionId, assistant.id, "final", toolCalls), store.renameSession(input.sessionId, "new title")]);
    expect(await store.getSession(input.sessionId)).toMatchObject({ title: "new title", version: 2 });
    expect((await store.getMessages(input.sessionId))[0]!.toolCalls![0]).toMatchObject({ state: "error", settlementOutcome: "cancelled" });
    expect(await store.getClientToolResolution(input)).toMatchObject({ status: "settled" });
  });

  it("reorders old pending calls before recent-message limiting", async () => {
    const { store, input, assistant } = await fixture();
    const later = await store.addMessage(input.sessionId, "user", "later");
    const settled = await store.settleClientTool({ ...input, expectedSessionVersion: 2 });
    expect((await store.getMessages(input.sessionId)).map(message => message.id)).toEqual([assistant.id, settled.receipt.resultMessageId, later.id]);
    expect(await store.getRecentMessages(input.sessionId, 1)).toEqual([later]);
  });

  it("does not acknowledge an atomic-write failure and does not lose the pending call", async () => {
    const { store, input } = await fixture();
    vi.spyOn(store as any, "writeSessionFileAtomic").mockImplementationOnce(() => { throw new Error("disk full"); });
    await expect(store.settleClientTool(input)).rejects.toThrow("disk full");
    expect(await store.getClientToolResolution(input)).toMatchObject({ status: "pending" });
    expect(await store.getMessages(input.sessionId)).toHaveLength(1);
    expect((await store.settleClientTool(input)).status).toBe("settled");
  });

  it("fails closed on a missing result, even when the receipt already exists", async () => {
    const { store, input, dir } = await fixture();
    await store.settleClientTool(input);
    const file = join(dir, "sessions", `${input.sessionId}.jsonl`);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    writeFileSync(file, lines.slice(0, -1).join("\n") + "\n");
    await expect(store.getMessages(input.sessionId)).rejects.toMatchObject({ code: "client_tool_settlement_corrupt" });
    await expect(store.getClientToolResolution(input)).rejects.toMatchObject({ code: "client_tool_settlement_corrupt" });
    await expect(store.settleClientTool(input)).rejects.toMatchObject({ code: "client_tool_settlement_corrupt" });
  });

  it.each([{ sessionVersion: "garbage" }, { settledAt: 17 }, { fingerprint: "invalid" }])("rejects corrupt receipt metadata after reopening %#", async change => {
    const { store, input, dir } = await fixture();
    await store.settleClientTool(input);
    const file = join(dir, "sessions", `${input.sessionId}.jsonl`);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    const header = JSON.parse(lines[0]!);
    Object.assign(header.clientToolSettlements[0], change);
    lines[0] = JSON.stringify(header);
    writeFileSync(file, lines.join("\n") + "\n");
    const reopened = new FileSessionStore(dir);
    await expect(reopened.getClientToolResolution(input)).rejects.toMatchObject({ code: "client_tool_settlement_corrupt" });
    await expect(reopened.settleClientTool(input)).rejects.toMatchObject({ code: "client_tool_settlement_corrupt" });
  });

  it.each(["success", "failed", "cancelled"] as const)("persists exact %s outcome and rejects later continuation", async outcome => {
    const { store, input } = await fixture();
    const { reason: _reason, ...base } = input;
    const settled = await store.settleClientTool({ ...base, outcome, result: '[1,{"value":"exact"}]' });
    expect(settled.receipt.outcome).toBe(outcome);
    await expect(store.prepareContinuation({ ...continuation(input), expectedSessionVersion: 2 }))
      .rejects.toMatchObject({ code: "client_tool_call_not_pending" });
    expect((await store.getMessages(input.sessionId))[0]!.toolCalls![0]).toMatchObject({
      state: outcome === "success" ? "completed" : "error", settlementOutcome: outcome,
    });
  });

  it("keeps settled calls when a canonical finalizer omits its stale tool list", async () => {
    const { store, input, toolCalls } = await fixture();
    const sessionId = await store.create({ agent: input.agent, user: input.user });
    const user = await store.addMessage(sessionId, "user", "change site", { turnId: "turn" });
    const assistant = await store.addMessage(sessionId, "assistant", "", { turnId: "turn" });
    await store.updateMessage(sessionId, assistant.id, "", toolCalls);
    await store.settleClientTool({ ...input, sessionId, scope: undefined, expectedSessionVersion: 2 });
    expect(await store.listPendingCanonicalTurns()).toEqual([]);
    await store.commitCanonicalTurn({
      turn: { turnId: "turn", sessionId, agentName: "leo", surface: "chat", terminalStatus: "succeeded",
        userMessage: { id: user.id, role: "user" }, assistantMessage: { id: assistant.id, role: "assistant" },
        trustedInvocation: { externalUserId: input.user }, occurredAt: "2026-10-17T10:00:00Z" },
      assistant: { messageId: assistant.id, content: "final" },
    });
    expect((await store.getMessages(sessionId))[1]!.toolCalls![0]).toMatchObject({ state: "error", settlementOutcome: "cancelled" });
    expect((await store.getMessages(sessionId))[2]!.turnId).toBe("turn");
  });

  it("does not permit rewriting a settlement result", async () => {
    const { store, input } = await fixture();
    const settled = await store.settleClientTool(input);
    await expect(store.updateMessage(input.sessionId, settled.receipt.resultMessageId, "forged success"))
      .rejects.toMatchObject({ code: "client_tool_settlement_conflict" });
    expect(await store.getClientToolResolution(input)).toMatchObject({ status: "settled", receipt: settled.receipt });
  });

  it("rejects a settlement replay key already used by another continuation", async () => {
    const { store, input, toolCalls } = await fixture();
    await store.settleClientTool(input);
    const second = await store.addMessage(input.sessionId, "assistant", "next");
    await store.updateMessage(input.sessionId, second.id, "next", [{ ...toolCalls[0]!, id: "second-call" }]);
    await store.prepareContinuation({ ...continuation(input), toolCallId: "second-call", expectedSessionVersion: 3, idempotencyKey: "other-operation" });
    await expect(store.settleClientTool({ ...input, idempotencyKey: "other-operation" }))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("serializes repeated update/rename operations with the atomic settlement", async () => {
    const { store, input, assistant, toolCalls } = await fixture();
    const writes = Array.from({ length: 40 }, (_, index) => index % 2
      ? store.renameSession(input.sessionId, `title-${index}`)
      : store.updateMessage(input.sessionId, assistant.id, `text-${index}`, toolCalls));
    const settled = await store.settleClientTool(input);
    await Promise.all(writes);
    expect(await store.getClientToolResolution(input)).toMatchObject({ status: "settled", receipt: settled.receipt });
    expect(await store.getMessages(input.sessionId)).toHaveLength(2);
  });
});
