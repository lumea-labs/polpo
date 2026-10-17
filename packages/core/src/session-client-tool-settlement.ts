import type { SessionContinuationScope } from "./session-continuation.js";
import { projectResolvedClientToolCalls } from "./session-continuation.js";
import type { Message, Session, ToolCallInfo } from "./session-store.js";

export type ClientToolSettlementOutcome = "success" | "failed" | "cancelled";

export interface ClientToolResolutionInput {
  sessionId: string;
  toolCallId: string;
  agent?: string;
  user?: string;
  /** Trusted host partition; never copied from the public JSON body. */
  scope?: SessionContinuationScope;
}

export type SettleClientToolInput = ClientToolResolutionInput & {
  expectedSessionVersion: number;
  idempotencyKey: string;
} & (
  | { outcome: "success"; result: string; reason?: never }
  | { outcome: "failed" | "cancelled"; result?: string; reason?: string }
);

/** Immutable receipt for settlement-only; it never creates or asserts a Run. */
export interface ClientToolSettlementReceipt {
  id: string;
  sessionId: string;
  toolCallId: string;
  sourceAssistantMessageId: string;
  resultMessageId: string;
  outcome: ClientToolSettlementOutcome;
  sessionVersion: number;
  settledAt: string;
}

/** Internal persisted record. Fingerprint and key are not public response fields. */
export interface StoredClientToolSettlement extends ClientToolSettlementReceipt {
  idempotencyKey: string;
  fingerprint: string;
}

/** The accepted continuation receipt is independent of whether its Run survives. */
export interface ClientToolContinuationReceipt {
  sessionId: string;
  toolCallId: string;
  runId: string;
  sessionVersion: number;
  acceptedAt?: string;
}

export type ClientToolResolution = {
  sessionId: string;
  toolCallId: string;
  sessionVersion: number;
} & (
  | { status: "pending"; continuationAccepted: false }
  | { status: "settled"; continuationAccepted: false; receipt: ClientToolSettlementReceipt }
  | { status: "continuation"; continuationAccepted: true; receipt: ClientToolContinuationReceipt }
);

export interface SettledClientTool {
  status: "settled" | "replay";
  receipt: ClientToolSettlementReceipt;
}

export type ClientToolSettlementErrorCode =
  | "invalid_client_tool_settlement"
  | "session_not_found"
  | "session_version_conflict"
  | "client_tool_settlement_scope_mismatch"
  | "client_tool_call_not_found"
  | "client_tool_call_not_pending"
  | "client_tool_call_unverifiable"
  | "client_tool_settlement_conflict"
  | "continuation_already_accepted"
  | "idempotency_conflict"
  | "client_tool_settlement_corrupt"
  | "client_tool_settlement_unavailable";

export class ClientToolSettlementError extends Error {
  constructor(
    readonly code: ClientToolSettlementErrorCode,
    message: string,
    readonly continuation?: ClientToolContinuationReceipt,
  ) {
    super(message);
    this.name = "ClientToolSettlementError";
  }
}

export interface NormalizedClientToolSettlement {
  fingerprint: string;
  /** A bounded JSON object string, compatible with every SessionStore. */
  content: string;
}

export const MAX_CLIENT_TOOL_SETTLEMENT_RESULT_BYTES = 64 * 1024;
export const MAX_CLIENT_TOOL_SETTLEMENT_REASON_BYTES = 4096;
/** JSON escaping can expand a valid result; bound the stored envelope too. */
export const MAX_CLIENT_TOOL_SETTLEMENT_CONTENT_BYTES = 6 * (64 * 1024 + 4096) + 256;

function invalid(message: string): never {
  throw new ClientToolSettlementError("invalid_client_tool_settlement", message);
}

function bounded(value: unknown, name: string, limit: number, required = false): void {
  if (value === undefined && !required) return;
  if (typeof value !== "string" || (required && !value.trim())
    || new TextEncoder().encode(value).byteLength > limit) invalid(`Invalid ${name}`);
}

/** Normalize before entering a store transaction. No caller-provided fingerprint. */
export async function normalizeClientToolSettlement(
  input: SettleClientToolInput,
): Promise<NormalizedClientToolSettlement> {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid("Invalid settlement input");
  bounded(input.sessionId, "sessionId", 256, true);
  bounded(input.toolCallId, "toolCallId", 256, true);
  bounded(input.idempotencyKey, "idempotencyKey", 256, true);
  bounded(input.agent, "agent", 1024);
  bounded(input.user, "user", 1024);
  if (!Number.isSafeInteger(input.expectedSessionVersion) || input.expectedSessionVersion < 0) {
    invalid("Invalid expectedSessionVersion");
  }
  if (!["success", "failed", "cancelled"].includes(input.outcome)) invalid("Invalid outcome");
  if (input.outcome === "success" && (typeof input.result !== "string" || input.reason !== undefined)) {
    invalid("Success requires a string result and no reason");
  }
  bounded(input.result, "result", MAX_CLIENT_TOOL_SETTLEMENT_RESULT_BYTES);
  bounded(input.reason, "reason", MAX_CLIENT_TOOL_SETTLEMENT_REASON_BYTES);
  if (input.scope !== undefined) {
    if (!input.scope || typeof input.scope !== "object") invalid("Invalid scope");
    bounded(input.scope.key, "scope.key", 4096, true);
    bounded(input.scope.version, "scope.version", 1024);
  }
  const content = JSON.stringify({
    ok: input.outcome === "success",
    outcome: input.outcome,
    ...(input.result !== undefined ? { result: input.result } : {}),
    ...(input.outcome !== "success" ? { error: input.reason ?? `Client tool ${input.outcome}` } : {}),
  });
  if (new TextEncoder().encode(content).byteLength > MAX_CLIENT_TOOL_SETTLEMENT_CONTENT_BYTES) {
    invalid("Settlement envelope is too large");
  }
  const semantics = JSON.stringify({
    sessionId: input.sessionId, toolCallId: input.toolCallId,
    agent: input.agent ?? null, user: input.user ?? null,
    scope: input.scope ? { key: input.scope.key, version: input.scope.version ?? null } : null,
    content,
  });
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(semantics));
  return { content, fingerprint: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("") };
}

export function assertClientToolSettlementScope(session: Session, input: ClientToolResolutionInput): void {
  if (session.id !== input.sessionId || session.agent !== input.agent || session.user !== input.user
    || session.scope?.key !== input.scope?.key || session.scope?.version !== input.scope?.version
    || Boolean(session.scope) !== Boolean(input.scope)) {
    throw new ClientToolSettlementError("client_tool_settlement_scope_mismatch", "Client tool scope does not match the session");
  }
}

export function resolveClientToolSettlementTarget(
  messages: readonly Message[], toolCallId: string,
): { message: Message; call: ToolCallInfo } {
  const targets = messages.flatMap(message => message.role === "assistant"
    ? (message.toolCalls ?? []).filter(call => call.id === toolCallId).map(call => ({ message, call })) : []);
  if (targets.length === 0) throw new ClientToolSettlementError("client_tool_call_not_found", "Client tool call not found");
  if (targets.length !== 1) throw new ClientToolSettlementError("client_tool_settlement_corrupt", "Client tool call is ambiguous");
  const target = targets[0]!;
  if (target.call.state !== "interrupted" || messages.some(message => message.role === "tool" && message.toolCallId === toolCallId)) {
    throw new ClientToolSettlementError("client_tool_call_not_pending", "Client tool call is not pending");
  }
  if (!target.call.continuationClientTools?.some(tool => tool.type === "function" && tool.function?.name === target.call.name)) {
    throw new ClientToolSettlementError("client_tool_call_unverifiable", "The frozen client tool definition is unavailable");
  }
  return target;
}

function assertStoredClientToolSettlement(receipt: StoredClientToolSettlement): void {
  const identifiers = [receipt?.id, receipt?.sessionId, receipt?.toolCallId,
    receipt?.sourceAssistantMessageId, receipt?.resultMessageId, receipt?.idempotencyKey];
  if (identifiers.some(value => typeof value !== "string" || !value.trim()
      || new TextEncoder().encode(value).byteLength > 256)
    || !Number.isSafeInteger(receipt?.sessionVersion) || receipt.sessionVersion < 0
    || typeof receipt.settledAt !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(receipt.settledAt)
    || !Number.isFinite(Date.parse(receipt.settledAt))
    || typeof receipt.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(receipt.fingerprint)
    || !["success", "failed", "cancelled"].includes(receipt.outcome)) {
    throw new ClientToolSettlementError("client_tool_settlement_corrupt", "Client tool settlement receipt is invalid");
  }
}

/** Receipt-backed projection, also used before stale assistant writes can replace a settled call. */
export function projectClientToolSettlements(
  messages: readonly Message[], receipts: readonly StoredClientToolSettlement[],
): Message[] {
  const corrupt = (): never => { throw new ClientToolSettlementError("client_tool_settlement_corrupt", "Client tool settlement history is inconsistent"); };
  const receiptIds = new Set<string>();
  const calls = new Map<string, StoredClientToolSettlement>();
  const results = new Map<string, Message>();
  const sources = new Map<string, StoredClientToolSettlement[]>();
  for (const receipt of receipts) {
    assertStoredClientToolSettlement(receipt);
    if (!receipt.id || receiptIds.has(receipt.id) || calls.has(receipt.toolCallId) || results.has(receipt.resultMessageId)
      || !["success", "failed", "cancelled"].includes(receipt.outcome)) corrupt();
    receiptIds.add(receipt.id);
    const source = messages.filter(message => message.id === receipt.sourceAssistantMessageId);
    const result = messages.filter(message => message.id === receipt.resultMessageId);
    const declared = messages.flatMap(message => message.role === "assistant"
      ? (message.toolCalls ?? []).filter(call => call.id === receipt.toolCallId) : []);
    if (source.length !== 1 || source[0]!.role !== "assistant" || declared.length !== 1
      || !source[0]!.toolCalls?.some(call => call.id === receipt.toolCallId)
      || result.length !== 1 || result[0]!.role !== "tool" || result[0]!.toolCallId !== receipt.toolCallId
      || messages.filter(message => message.role === "tool" && message.toolCallId === receipt.toolCallId).length !== 1) corrupt();
    let envelope: any;
    try { envelope = typeof result[0]!.content === "string" ? JSON.parse(result[0]!.content) : null; }
    catch { corrupt(); }
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)
      || envelope.outcome !== receipt.outcome || envelope.ok !== (receipt.outcome === "success")
      || (envelope.result !== undefined && typeof envelope.result !== "string")
      || (receipt.outcome === "success"
        ? typeof envelope.result !== "string" || envelope.error !== undefined
        : typeof envelope.error !== "string")) corrupt();
    calls.set(receipt.toolCallId, receipt);
    results.set(receipt.resultMessageId, result[0]!);
    sources.set(receipt.sourceAssistantMessageId, [...(sources.get(receipt.sourceAssistantMessageId) ?? []), receipt]);
  }
  // A source can mix ordinarily completed calls and later settlements. Move all
  // its existing results together, preserving the declaration order.
  const sourceResults = new Map<string, Map<string, Message>>();
  for (const sourceId of sources.keys()) {
    const source = messages.find(message => message.id === sourceId)!;
    const byCall = new Map<string, Message>();
    for (const call of source.toolCalls ?? []) {
      const matches = messages.filter(message => message.role === "tool" && message.toolCallId === call.id);
      if (matches.length > 1) corrupt();
      if (matches[0]) {
        byCall.set(call.id, matches[0]);
        results.set(matches[0].id, matches[0]);
      }
    }
    sourceResults.set(sourceId, byCall);
  }
  const projected = projectResolvedClientToolCalls(messages);
  const output: Message[] = [];
  for (const message of projected) {
    if (results.has(message.id)) continue;
    const settled = sources.get(message.id);
    if (!settled) { output.push(message); continue; }
    const toolCalls = message.toolCalls!.map(call => {
      const receipt = calls.get(call.id);
      if (!receipt) return call;
      const { continuationClientTools: _catalog, ...rest } = call;
      const content = results.get(receipt.resultMessageId)!.content;
      return { ...rest, state: receipt.outcome === "success" ? "completed" as const : "error" as const,
        settlementOutcome: receipt.outcome, result: typeof content === "string" ? content : JSON.stringify(content) };
    });
    output.push({ ...message, toolCalls });
    for (const call of toolCalls) {
      const result = sourceResults.get(message.id)?.get(call.id);
      if (result) output.push(result);
    }
  }
  return output;
}

export function publicClientToolSettlementReceipt(receipt: StoredClientToolSettlement): ClientToolSettlementReceipt {
  assertStoredClientToolSettlement(receipt);
  const { id, sessionId, toolCallId, sourceAssistantMessageId, resultMessageId, outcome, sessionVersion, settledAt } = receipt;
  return { id, sessionId, toolCallId, sourceAssistantMessageId, resultMessageId, outcome, sessionVersion, settledAt };
}
