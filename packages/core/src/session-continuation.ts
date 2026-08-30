import type { Message, SessionContentPart, ToolCallInfo } from "./session-store.js";

export type SessionContinuationErrorCode =
  | "session_not_found"
  | "session_version_conflict"
  | "client_tool_call_not_pending"
  | "idempotency_conflict"
  | "continuation_scope_mismatch";

export class SessionContinuationError extends Error {
  constructor(
    readonly code: SessionContinuationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SessionContinuationError";
  }
}

export interface SessionContinuationScope {
  key: string;
  version?: string;
}

export interface PrepareSessionContinuationInput {
  sessionId: string;
  agent?: string;
  user?: string;
  scope?: SessionContinuationScope;
  toolCallId: string;
  result: string | SessionContentPart[];
  expectedSessionVersion: number;
  idempotencyKey: string;
  fingerprint: string;
  runId: string;
}

export interface PreparedSessionContinuation {
  status: "prepared" | "replay";
  sessionVersion: number;
  runId: string;
  /** Logical conversation turn resumed by this client-tool result. */
  turnId?: string;
  messages: Message[];
}

/** Resolve only the latest unresolved client call without exposing other IDs. */
export function resolvePendingClientToolCall(
  messages: readonly Message[],
  toolCallId: string,
): ToolCallInfo {
  const resolved = new Set(
    messages
      .filter((message) => message.role === "tool" && message.toolCallId)
      .map((message) => message.toolCallId!),
  );
  const pending = messages.flatMap((message) =>
    message.role === "assistant"
      ? (message.toolCalls ?? []).filter(
          (call) => call.state === "interrupted" && !resolved.has(call.id),
        )
      : [],
  );
  const latest = pending.at(-1);
  if (!latest || latest.id !== toolCallId) {
    throw new SessionContinuationError(
      "client_tool_call_not_pending",
      "Client tool call is not pending",
    );
  }
  return latest;
}

export function projectResolvedClientToolCalls(
  messages: readonly Message[],
): Message[] {
  const results = new Map(
    messages
      .filter((message) => message.role === "tool" && message.toolCallId)
      .map((message) => [message.toolCallId!, message.content]),
  );
  return messages.map((message) => {
    if (message.role !== "assistant" || !message.toolCalls?.length) return message;
    let changed = false;
    const toolCalls = message.toolCalls.map((call) => {
      const result = results.get(call.id);
      if (result === undefined || call.state !== "interrupted") return call;
      changed = true;
      return {
        ...call,
        state: "completed" as const,
        result: typeof result === "string" ? result : JSON.stringify(result),
      };
    });
    return changed ? { ...message, toolCalls } : message;
  });
}
