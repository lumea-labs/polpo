import type { ChatSuggestion } from "./chat-interactions.js";
import type {
  PreparedSessionContinuation,
  PrepareSessionContinuationInput,
  SessionContinuationScope,
} from "./session-continuation.js";
import type { CanonicalTurnCommitted } from "./canonical-turn.js";

/**
 * Chat session storage — persists conversation threads across TUI restarts.
 * Nomenclature aligned with OpenCode: Session, Message, SessionStore.
 */

export type MessageRole = "user" | "assistant" | "tool";

/** Multimodal content parts — mirrors OpenAI content-part format. */
export type SessionContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: string } }
  | { type: "file"; file_id: string };

export type ToolCallState = "preparing" | "calling" | "completed" | "error" | "interrupted";

export interface ToolCallInfo {
  /** Tool call ID from the LLM */
  id: string;
  /** Tool name (e.g. "create_task", "get_status") */
  name: string;
  /** Tool input arguments (present when state was "calling") */
  arguments?: Record<string, unknown>;
  /** Tool execution result (present when state is "completed" or "error") */
  result?: string;
  /** Final state of the tool call */
  state: ToolCallState;
}

export interface Message {
  id: string;              // nanoid(10)
  role: MessageRole;
  content: string | SessionContentPart[];
  ts: string;              // ISO timestamp
  /** Tool calls executed during this assistant message (only for role=assistant) */
  toolCalls?: ToolCallInfo[];
  /** Optional next messages generated for compatible chat clients. */
  suggestions?: ChatSuggestion[];
  /** Matching OpenAI tool call for role=tool messages. */
  toolCallId?: string;
  /** Provider-exposed reasoning summary. Kept separate from model-visible content. */
  reasoning?: string;
  /** True when the persisted reasoning summary reached the storage byte limit. */
  reasoningTruncated?: boolean;
  /** Stable logical user-to-assistant turn identity. */
  turnId?: string;
}

export interface PersistedReasoning {
  text: string;
  truncated?: boolean;
}

export const MAX_PERSISTED_REASONING_BYTES = 64 * 1024;

/** Bound provider-exposed reasoning summaries without splitting UTF-8 code points. */
export function preparePersistedReasoning(
  value: string | null | undefined,
  maxBytes = MAX_PERSISTED_REASONING_BYTES,
): PersistedReasoning | undefined {
  if (!value || maxBytes <= 0) return undefined;
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) return { text: value };

  let text = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = encoder.encode(character).byteLength;
    if (bytes + characterBytes > maxBytes) break;
    text += character;
    bytes += characterBytes;
  }
  return text ? { text, truncated: true } : undefined;
}

export interface Session {
  id: string;              // nanoid(10)
  title?: string;          // first 60 chars of first message
  createdAt: string;       // ISO timestamp
  updatedAt: string;       // ISO timestamp
  messageCount: number;
  /** Agent name when this session targets a specific agent (agent-direct mode). Null/undefined for orchestrator sessions. */
  agent?: string;
  /**
   * Opaque end-user identifier (OpenAI-compat `user` field).
   * Set by integrators to scope sessions to their authenticated end-user.
   * Polpo never verifies this — caller's API key auth is the trust anchor.
   */
  user?: string;
  /**
   * Arbitrary key/value tags (OpenAI-compat). Up to 16 keys, key ≤64 chars,
   * value ≤512 chars. Validation enforced at the API boundary, not here.
   */
  metadata?: Record<string, string>;
  /** Monotonic append version used for optimistic continuation. */
  version?: number;
  /** Trusted application partition captured when the session is created. */
  scope?: SessionContinuationScope;
}

export interface SessionCreateOptions {
  title?: string;
  agent?: string;
  user?: string;
  metadata?: Record<string, string>;
  scope?: SessionContinuationScope;
}

export interface SessionMessageOptions {
  toolCallId?: string;
  turnId?: string;
}

export interface CommitCanonicalTurnInput {
  readonly turn: CanonicalTurnCommitted;
  readonly assistant: {
    readonly messageId: string;
    readonly content: string | SessionContentPart[];
    readonly toolCalls?: readonly ToolCallInfo[];
    readonly suggestions?: readonly ChatSuggestion[];
    readonly reasoning?: PersistedReasoning;
  };
}

export interface CommitCanonicalTurnResult {
  readonly turn: CanonicalTurnCommitted;
  readonly created: boolean;
}

export interface CanonicalTurnOutboxEntry {
  readonly turn: CanonicalTurnCommitted;
  readonly status: "pending" | "dispatched";
  readonly attempts: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SessionListFilter {
  /** Equality match on `Session.user` (OpenAI-compat end-user filter). */
  user?: string;
  /**
   * Equality match on metadata key/value pairs. ALL pairs must match.
   * Example: `{ tenant: "acme", env: "prod" }` → only sessions with both.
   */
  metadata?: Record<string, string>;
}

export interface SessionStore {
  /**
   * Create a new session. Pass an options object to scope it to an end-user
   * (`user`) or attach `metadata`. Backward-compatible with the legacy
   * positional form `(title, agent)` — internally normalised.
   */
  create(opts?: SessionCreateOptions): Promise<string>;
  addMessage(
    sessionId: string,
    role: MessageRole,
    content: string | SessionContentPart[],
    options?: SessionMessageOptions,
  ): Promise<Message>;
  /** Update the content of an existing message (e.g. finalize a streaming response). */
  updateMessage(
    sessionId: string,
    messageId: string,
    content: string | SessionContentPart[],
    toolCalls?: ToolCallInfo[],
    suggestions?: ChatSuggestion[],
    reasoning?: PersistedReasoning,
  ): Promise<boolean>;
  getMessages(sessionId: string): Promise<Message[]>;
  getRecentMessages(sessionId: string, limit: number): Promise<Message[]>;
  /**
   * List sessions, optionally filtered by `user` and/or `metadata`.
   * Filter is equality-only; no LIKE / regex / IN. YAGNI.
   */
  listSessions(filter?: SessionListFilter): Promise<Session[]>;
  getSession(sessionId: string): Promise<Session | undefined>;
  /** Get the most recent session, optionally filtered by agent name. Pass `null` to match only orchestrator sessions. */
  getLatestSession(agent?: string | null): Promise<Session | undefined>;
  /** Rename (update the title of) an existing session. */
  renameSession(sessionId: string, title: string): Promise<boolean>;
  deleteSession(sessionId: string): Promise<boolean>;
  prune(keepSessions: number): Promise<number>;
  /** Atomically append one pending client-tool result and reserve its continuation run. */
  prepareContinuation?(
    input: PrepareSessionContinuationInput,
  ): Promise<PreparedSessionContinuation>;
  /** Atomically finalize the assistant message and insert one durable turn outbox record. */
  commitCanonicalTurn?(
    input: CommitCanonicalTurnInput,
  ): Promise<CommitCanonicalTurnResult>;
  /** Read one committed identifier-only turn event for durable dispatch/reconcile. */
  getCanonicalTurn?(
    turnId: string,
  ): Promise<CanonicalTurnCommitted | undefined>;
  /** Reconcile committed turns whose host-side learning job was not acknowledged. */
  listPendingCanonicalTurns?(
    limit?: number,
  ): Promise<readonly CanonicalTurnOutboxEntry[]>;
  markCanonicalTurnDispatched?(turnId: string): Promise<boolean>;
  recordCanonicalTurnDispatchFailure?(turnId: string): Promise<boolean>;
  close(): Promise<void> | void;
}

/**
 * Normalise the legacy positional signature `create(title?, agent?)` into the
 * options-object form. Implementations call this so they only have to handle
 * one shape internally.
 */
export function normalizeSessionCreateArgs(
  arg1?: string | SessionCreateOptions,
  arg2?: string,
): SessionCreateOptions {
  if (arg1 && typeof arg1 === "object") return arg1;
  return { title: arg1, agent: arg2 };
}
