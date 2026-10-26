import { withProjectFileTransaction } from "./project-file-transaction.js";
import { admittedSessionTitleState, initialSessionTitleState, manualSessionTitleState, sessionTitleSnapshot, sessionTitleWorkPending, sessionTitleInput, type SessionTitleState, type SessionTitleAdmission } from "@polpo-ai/core/session-titles";
import {
  existsSync,
  mkdirSync,
  appendFileSync,
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  unlinkSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { nanoid } from "nanoid";
import type {
  SessionStore,
  Session,
  Message,
  MessageRole,
  ToolCallInfo,
  SessionContentPart,
  SessionCreateOptions,
  SessionListFilter,
  SessionMessageOptions,
  PersistedReasoning,
  CommitCanonicalTurnInput,
  CommitCanonicalTurnResult,
  CanonicalTurnOutboxEntry,
} from "@polpo-ai/core/session-store";
import { normalizeSessionCreateArgs } from "@polpo-ai/core/session-store";
import type { ChatSuggestion } from "@polpo-ai/core/chat-interactions";
import {
  normalizeCanonicalTurnCommitted,
  type CanonicalTurnCommitted,
} from "@polpo-ai/core/canonical-turn";
import {
  requestClientToolsForContinuation,
  resolvePendingClientToolCall,
  SessionContinuationError,
  type PreparedSessionContinuation,
  type PrepareSessionContinuationInput,
} from "@polpo-ai/core/session-continuation";
import {
  assertClientToolSettlementScope,
  ClientToolSettlementError,
  normalizeClientToolSettlement,
  projectClientToolSettlements,
  publicClientToolSettlementReceipt,
  resolveClientToolSettlementTarget,
  type ClientToolContinuationReceipt,
  type ClientToolResolution,
  type ClientToolResolutionInput,
  type SettleClientToolInput,
  type SettledClientTool,
  type StoredClientToolSettlement,
} from "@polpo-ai/core/session-client-tool-settlement";

/**
 * File-backed SessionStore.
 * Writes JSONL files to `.polpo/sessions/`, one per session.
 *
 * File naming: `{sessionId}.jsonl`
 * First line of each file: `{"_session":true,"id":"...","title":"...","createdAt":"..."}`
 */
export class FileSessionStore implements SessionStore {
  private static readonly sessionLocks = new Map<string, Promise<void>>();
  private readonly sessionsDir: string;

  constructor(private readonly polpoDir: string) {
    this.sessionsDir = resolve(polpoDir, "sessions");
  }

  async create(arg1?: string | SessionCreateOptions, arg2?: string): Promise<string> {
    const opts = normalizeSessionCreateArgs(arg1, arg2);
    if (!existsSync(this.sessionsDir)) {
      mkdirSync(this.sessionsDir, { recursive: true });
    }
    const sessionId = nanoid(10);
    const header: Record<string, unknown> = {
      _session: true,
      id: sessionId,
      title: opts.title,
      createdAt: new Date().toISOString(),
      version: 0,
    };
    header.titleState = initialSessionTitleState(sessionId, opts.title, opts.titleSource ?? "manual", header.createdAt as string);
    if (opts.agent) header.agent = opts.agent;
    if (opts.user) header.user = opts.user;
    if (opts.metadata) header.metadata = opts.metadata;
    if (opts.scope) header.scope = opts.scope;
    try {
      appendFileSync(this.sessionFile(sessionId), JSON.stringify(header) + "\n", "utf-8");
    } catch { /* best-effort: non-critical */
    }
    return sessionId;
  }

  async addMessage(
    sessionId: string,
    role: MessageRole,
    content: string | SessionContentPart[],
    options?: SessionMessageOptions,
  ): Promise<Message> {
    const message: Message = {
      id: nanoid(10),
      role,
      content,
      ts: new Date().toISOString(),
      ...(options?.toolCallId ? { toolCallId: options.toolCallId } : {}),
      ...(options?.turnId ? { turnId: options.turnId } : {}),
    };
    await this.withSessionLock(sessionId, () => {
      try {
        const state = this.readSessionFile(sessionId);
        state.header.version = Number(state.header.version ?? 0) + 1;
        if (role === "user" && options?.sessionTitle && !state.messages.some(m => m.role === "user")) {
          state.header.titleState = admittedSessionTitleState(this.titleStateFromHeader(state.header), {
            ...options.sessionTitle, sessionId, messageId: message.id, text: sessionTitleInput(content), createdAt: message.ts,
          });
        }
        state.messages.push(message);
        this.writeSessionFileAtomic(sessionId, state.header, state.messages);
      } catch { /* best-effort: non-critical */ }
    });
    return message;
  }

  async updateMessage(
    sessionId: string,
    messageId: string,
    content: string | SessionContentPart[],
    toolCalls?: ToolCallInfo[],
    suggestions?: ChatSuggestion[],
    reasoning?: PersistedReasoning,
  ): Promise<boolean> {
    return this.withSessionLock(sessionId, () => {
      if (!existsSync(this.sessionFile(sessionId))) return false;
      try {
        const state = this.readSessionFile(sessionId);
        const index = state.messages.findIndex(message => message.id === messageId);
        if (index < 0) return false;
        const original = state.messages[index]!;
        const patched: Message = { ...original, content,
          ...(toolCalls?.length ? { toolCalls } : {}),
          ...(suggestions?.length ? { suggestions } : {}),
          ...(reasoning?.text ? { reasoning: reasoning.text, ...(reasoning.truncated ? { reasoningTruncated: true } : {}) } : {}),
        };
        state.messages[index] = this.protectSettledMessage(state, original, patched);
        this.writeSessionFileAtomic(sessionId, state.header, state.messages);
        return true;
      } catch (error) {
        if (error instanceof ClientToolSettlementError) throw error;
        return false;
      }
    });
  }

  async getMessages(sessionId: string): Promise<Message[]> {
    const file = this.sessionFile(sessionId);
    if (!existsSync(file)) return [];
    try {
      const state = this.readSessionFile(sessionId);
      return this.projectMessages(state);
    } catch (error) { /* unreadable legacy session file */
      if (error instanceof ClientToolSettlementError) throw error;
      return [];
    }
  }

  async getRecentMessages(sessionId: string, limit: number): Promise<Message[]> {
    const messages = await this.getMessages(sessionId);
    return messages.slice(-limit);
  }

  /** Build a Session out of a session file's first line + mtime. */
  private headerToSession(header: any, filePath: string, fallbackId: string): Session {
    const updatedAt = header.updatedAt ?? new Date(statSync(filePath).mtimeMs).toISOString();
    return {
      ...sessionTitleSnapshot(this.titleStateFromHeader({ ...header, id: header.id ?? fallbackId })),
      createdAt: header.createdAt ?? updatedAt,
      updatedAt,
      messageCount: 0,
      version: Number(header.version ?? 0),
      ...(header.agent ? { agent: header.agent } : {}),
      ...(header.user ? { user: header.user } : {}),
      ...(header.metadata ? { metadata: header.metadata } : {}),
      ...(header.scope ? { scope: header.scope } : {}),
    };
  }

  async prepareContinuation(
    input: PrepareSessionContinuationInput,
  ): Promise<PreparedSessionContinuation> {
    return this.withSessionLock(input.sessionId, () => {
      let state: { header: any; messages: Message[] };
      try {
        state = this.readSessionFile(input.sessionId);
      } catch {
        throw new SessionContinuationError("session_not_found", "Session not found");
      }

      if (
        (state.header.agent ?? undefined) !== input.agent
        || (state.header.user ?? undefined) !== input.user
        || JSON.stringify(state.header.scope ?? undefined) !== JSON.stringify(input.scope)
      ) {
        throw new SessionContinuationError(
          "continuation_scope_mismatch",
          "Continuation scope does not match the session",
        );
      }

      const continuations = (state.header.continuations ?? {}) as Record<string, {
        fingerprint: string;
        toolCallId: string;
        runId: string;
        sessionVersion: number;
      }>;
      const settlements = this.settlements(state.header);
      this.projectMessages(state);
      if (settlements.some(receipt => receipt.toolCallId === input.toolCallId)) {
        throw new SessionContinuationError("client_tool_call_not_pending", "Client tool call was already settled");
      }
      if (settlements.some(receipt => receipt.idempotencyKey === input.idempotencyKey)) {
        throw new SessionContinuationError("idempotency_conflict", "Idempotency key was already used for settlement");
      }
      const existing = Object.hasOwn(continuations, input.idempotencyKey) ? continuations[input.idempotencyKey] : undefined;
      if (existing) {
        if (existing.fingerprint !== input.fingerprint) {
          throw new SessionContinuationError(
            "idempotency_conflict",
            "Idempotency key was already used with a different continuation",
          );
        }
        const turnId = this.continuationTurnId(state.messages, input.toolCallId);
        const requestClientTools = requestClientToolsForContinuation(state.messages, input.toolCallId);
        return {
          status: "replay",
          sessionVersion: existing.sessionVersion,
          runId: existing.runId,
          ...(turnId ? { turnId } : {}),
          ...(requestClientTools ? { requestClientTools } : {}),
          messages: this.projectMessages(state),
        };
      }

      if (Number(state.header.version ?? 0) !== input.expectedSessionVersion) {
        throw new SessionContinuationError(
          "session_version_conflict",
          "Session version does not match",
        );
      }
      resolvePendingClientToolCall(
        this.projectMessages(state),
        input.toolCallId,
      );
      const turnId = this.continuationTurnId(state.messages, input.toolCallId);
      const requestClientTools = requestClientToolsForContinuation(state.messages, input.toolCallId);

      const nextVersion = input.expectedSessionVersion + 1;
      const message: Message = {
        id: nanoid(10),
        role: "tool",
        content: input.result,
        ts: new Date().toISOString(),
        toolCallId: input.toolCallId,
        ...(turnId ? { turnId } : {}),
      };
      state.header.version = nextVersion;
      state.header.continuations = {
        ...continuations,
        [input.idempotencyKey]: {
          fingerprint: input.fingerprint,
          toolCallId: input.toolCallId,
          runId: input.runId,
          sessionVersion: nextVersion,
          acceptedAt: message.ts,
        },
      };
      state.messages.push(message);
      this.writeSessionFileAtomic(input.sessionId, state.header, state.messages);

      return {
        status: "prepared",
        sessionVersion: nextVersion,
        runId: input.runId,
        ...(turnId ? { turnId } : {}),
        ...(requestClientTools ? { requestClientTools } : {}),
        messages: this.projectMessages(state),
      };
    });
  }

  async getClientToolResolution(input: ClientToolResolutionInput): Promise<ClientToolResolution> {
    return this.withSessionLock(input.sessionId, () => {
      const state = this.readSettlementSession(input.sessionId);
      const session = this.headerToSession(state.header, this.sessionFile(input.sessionId), input.sessionId);
      assertClientToolSettlementScope(session, input);
      const resolution = this.existingClientToolResolution(state, input);
      if (resolution) return resolution;
      resolveClientToolSettlementTarget(state.messages, input.toolCallId);
      return { sessionId: input.sessionId, toolCallId: input.toolCallId, sessionVersion: session.version ?? 0,
        status: "pending", continuationAccepted: false };
    });
  }

  async settleClientTool(input: SettleClientToolInput): Promise<SettledClientTool> {
    const normalized = await normalizeClientToolSettlement(input);
    return this.withSessionLock(input.sessionId, () => {
      const state = this.readSettlementSession(input.sessionId);
      const session = this.headerToSession(state.header, this.sessionFile(input.sessionId), input.sessionId);
      assertClientToolSettlementScope(session, input);
      const resolution = this.existingClientToolResolution(state, input);
      const receipts = this.settlements(state.header);
      const byKey = receipts.find(receipt => receipt.idempotencyKey === input.idempotencyKey);
      if (byKey && byKey.fingerprint !== normalized.fingerprint) {
        throw new ClientToolSettlementError("idempotency_conflict", "Idempotency key was already used for a different settlement");
      }
      if (resolution?.status !== "continuation" && Object.hasOwn(state.header.continuations ?? {}, input.idempotencyKey)) {
        throw new ClientToolSettlementError("idempotency_conflict", "Idempotency key was already used for continuation");
      }
      if (resolution?.status === "settled") {
        const existing = receipts.find(receipt => receipt.toolCallId === input.toolCallId)!;
        if (existing.fingerprint !== normalized.fingerprint) {
          throw new ClientToolSettlementError("client_tool_settlement_conflict", "Client tool call was already settled differently");
        }
        return { status: "replay", receipt: resolution.receipt };
      }
      if (resolution?.status === "continuation") {
        throw new ClientToolSettlementError("continuation_already_accepted", "Continuation was already accepted", resolution.receipt);
      }
      if (Object.hasOwn(state.header.continuations ?? {}, input.idempotencyKey)) {
        throw new ClientToolSettlementError("idempotency_conflict", "Idempotency key was already used for continuation");
      }
      if (session.version !== input.expectedSessionVersion) {
        throw new ClientToolSettlementError("session_version_conflict", "Session version does not match");
      }
      const target = resolveClientToolSettlementTarget(state.messages, input.toolCallId);
      const now = new Date().toISOString();
      const message: Message = { id: nanoid(10), role: "tool", content: normalized.content, ts: now,
        toolCallId: input.toolCallId, ...(target.message.turnId ? { turnId: target.message.turnId } : {}) };
      const receipt: StoredClientToolSettlement = {
        id: nanoid(20), sessionId: input.sessionId, toolCallId: input.toolCallId,
        sourceAssistantMessageId: target.message.id, resultMessageId: message.id,
        outcome: input.outcome, sessionVersion: input.expectedSessionVersion + 1, settledAt: now,
        idempotencyKey: input.idempotencyKey, fingerprint: normalized.fingerprint,
      };
      state.header.clientToolSettlements = [...receipts, receipt];
      state.header.version = receipt.sessionVersion;
      state.messages.push(message);
      // Persist only this terminal call, leaving the raw catalogs of accepted
      // continuations intact for their replay path.
      const { continuationClientTools: _catalog, ...terminal } = target.call;
      target.message.toolCalls = target.message.toolCalls!.map(call => call.id === input.toolCallId
        ? { ...terminal, state: input.outcome === "success" ? "completed" : "error",
          settlementOutcome: input.outcome, result: normalized.content }
        : call);
      this.projectMessages(state);
      this.writeSessionFileAtomic(input.sessionId, state.header, state.messages);
      return { status: "settled", receipt: publicClientToolSettlementReceipt(receipt) };
    });
  }

  async commitCanonicalTurn(
    input: CommitCanonicalTurnInput,
  ): Promise<CommitCanonicalTurnResult> {
    const turn = normalizeCanonicalTurnCommitted(input.turn);
    if (turn.assistantMessage?.id !== input.assistant.messageId) {
      throw new Error("Canonical turn assistant identity does not match persistence input");
    }
    return this.withSessionLock(turn.sessionId, () => {
      const state = this.readSessionFile(turn.sessionId);
      const outbox = this.canonicalOutbox(state.header);
      const existing = outbox[turn.turnId];
      if (existing) {
        if (JSON.stringify(existing.turn) !== JSON.stringify(turn)) {
          throw new Error("Canonical turn id was already committed with different metadata");
        }
        return { turn, created: false };
      }
      const user = state.messages.find((message) => message.id === turn.userMessage.id);
      const assistantIndex = state.messages.findIndex(
        (message) => message.id === turn.assistantMessage!.id,
      );
      const assistant = state.messages[assistantIndex];
      if (
        !user
        || user.role !== "user"
        || user.turnId !== turn.turnId
        || !assistant
        || assistant.role !== "assistant"
        || assistant.turnId !== turn.turnId
      ) {
        throw new Error("Canonical turn messages do not match the committed turn");
      }

      const patched: Message = {
        ...assistant,
        content: input.assistant.content,
        ...(input.assistant.toolCalls?.length
          ? { toolCalls: [...input.assistant.toolCalls] }
          : { toolCalls: undefined }),
        ...(input.assistant.suggestions?.length
          ? { suggestions: [...input.assistant.suggestions] }
          : { suggestions: undefined }),
        ...(input.assistant.reasoning?.text
          ? {
              reasoning: input.assistant.reasoning.text,
              ...(input.assistant.reasoning.truncated
                ? { reasoningTruncated: true }
                : { reasoningTruncated: undefined }),
            }
          : { reasoning: undefined, reasoningTruncated: undefined }),
      };
      state.messages[assistantIndex] = this.protectSettledMessage(state, assistant, patched);
      state.header.canonicalTurnOutbox = {
        ...outbox,
        [turn.turnId]: {
          turn,
          status: "pending",
          attempts: 0,
          createdAt: turn.occurredAt,
          updatedAt: turn.occurredAt,
        },
      };
      this.writeSessionFileAtomic(turn.sessionId, state.header, state.messages);
      return { turn, created: true };
    });
  }

  async getCanonicalTurn(turnId: string): Promise<CanonicalTurnCommitted | undefined> {
    const located = this.findCanonicalTurn(turnId);
    return located ? normalizeCanonicalTurnCommitted(located.entry.turn) : undefined;
  }

  async listPendingCanonicalTurns(limit = 100): Promise<readonly CanonicalTurnOutboxEntry[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new TypeError("Canonical turn outbox limit must be between 1 and 1000");
    }
    if (!existsSync(this.sessionsDir)) return [];
    const pending: CanonicalTurnOutboxEntry[] = [];
    for (const file of readdirSync(this.sessionsDir).filter((value) => value.endsWith(".jsonl"))) {
      const sessionId = file.slice(0, -".jsonl".length);
      let state: { header: any; messages: Message[] };
      try {
        state = this.readSessionFile(sessionId);
      } catch {
        continue;
      }
      for (const raw of Object.values(this.canonicalOutbox(state.header))) {
        if (raw.status !== "pending") continue;
        pending.push(Object.freeze({
          turn: normalizeCanonicalTurnCommitted(raw.turn),
          status: "pending",
          attempts: Number(raw.attempts ?? 0),
          createdAt: raw.createdAt,
          updatedAt: raw.updatedAt,
        }));
      }
    }
    return pending
      .sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt)
        || left.turn.turnId.localeCompare(right.turn.turnId)
      )
      .slice(0, limit);
  }

  async markCanonicalTurnDispatched(turnId: string): Promise<boolean> {
    return this.updateCanonicalTurnOutbox(turnId, (entry) => {
      if (entry.status !== "pending") return false;
      entry.status = "dispatched";
      entry.updatedAt = new Date().toISOString();
      return true;
    });
  }

  async recordCanonicalTurnDispatchFailure(turnId: string): Promise<boolean> {
    return this.updateCanonicalTurnOutbox(turnId, (entry) => {
      if (entry.status !== "pending") return false;
      entry.attempts = Number(entry.attempts ?? 0) + 1;
      entry.updatedAt = new Date().toISOString();
      return true;
    });
  }

  async listSessions(filter?: SessionListFilter): Promise<Session[]> {
    if (!existsSync(this.sessionsDir)) return [];
    const files = readdirSync(this.sessionsDir)
      .filter(f => f.endsWith(".jsonl"));

    // Sort by modification time (most recent first)
    const withMtime = files.map(f => ({
      file: f,
      mtime: statSync(join(this.sessionsDir, f)).mtimeMs,
    }));
    withMtime.sort((a, b) => b.mtime - a.mtime);

    const sessions: Session[] = [];
    for (const { file } of withMtime) {
      const filePath = join(this.sessionsDir, file);
      try {
        const content = readFileSync(filePath, "utf-8");
        const lines = content.split("\n").filter(Boolean);
        const header = JSON.parse(lines[0]);
        const session = this.headerToSession(header, filePath, file.replace(".jsonl", ""));
        session.messageCount = lines.length - 1;

        // In-memory filter — file store has no index, so we scan + filter.
        // Acceptable here because file store is for dev/CLI, not high-traffic.
        if (filter?.user && session.user !== filter.user) continue;
        if (filter?.metadata) {
          const sessMeta = session.metadata ?? {};
          const allMatch = Object.entries(filter.metadata).every(
            ([k, v]) => sessMeta[k] === v,
          );
          if (!allMatch) continue;
        }
        sessions.push(session);
      } catch { /* skip corrupt file */
      }
    }
    return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getSession(sessionId: string): Promise<Session | undefined> {
    const file = this.sessionFile(sessionId);
    if (!existsSync(file)) return undefined;
    try {
      const content = readFileSync(file, "utf-8");
      const lines = content.split("\n").filter(Boolean);
      const header = JSON.parse(lines[0]);
      const session = this.headerToSession(header, file, sessionId);
      session.messageCount = lines.length - 1;
      return session;
    } catch { /* unreadable session file */
      return undefined;
    }
  }

  async getLatestSession(agent?: string | null): Promise<Session | undefined> {
    const sessions = await this.listSessions();
    if (agent === undefined) {
      // No filter — return the most recent session regardless of agent
      return sessions[0];
    }
    if (agent === null) {
      // Orchestrator sessions only (no agent)
      return sessions.find(s => !s.agent);
    }
    // Agent-specific sessions
    return sessions.find(s => s.agent === agent);
  }

  private titleStateFromHeader(header: any): SessionTitleState {
    return header.titleState ?? initialSessionTitleState(header.id, header.title, "legacy", header.createdAt);
  }

  async getSessionTitleState(sessionId: string): Promise<SessionTitleState | undefined> {
    if (!existsSync(this.sessionFile(sessionId))) return undefined;
    return this.titleStateFromHeader(this.readSessionFile(sessionId).header);
  }

  async compareAndSetSessionTitleState(sessionId: string, expected: SessionTitleState, next: SessionTitleState): Promise<boolean> {
    return this.withSessionLock(sessionId, () => {
      if (!existsSync(this.sessionFile(sessionId))) return false;
      const state = this.readSessionFile(sessionId);
      if (JSON.stringify(this.titleStateFromHeader(state.header)) !== JSON.stringify(expected)) return false;
      state.header.title = next.snapshot.title;
      state.header.titleState = next;
      const manual = next.snapshot.titleSource === "manual" && next.snapshot.titleRevision > expected.snapshot.titleRevision;
      if (!manual) state.header.updatedAt ??= new Date(statSync(this.sessionFile(sessionId)).mtimeMs).toISOString();
      this.writeSessionFileAtomic(sessionId, state.header, state.messages, !manual);
      return true;
    });
  }

  async listPendingSessionTitles(limit = 32): Promise<string[]> {
    if (!existsSync(this.sessionsDir)) return [];
    const pending: string[] = [];
    for (const file of readdirSync(this.sessionsDir).filter(f => f.endsWith(".jsonl"))) {
      const id = file.slice(0, -6);
      try {
        const state = this.readSessionFile(id);
        if (sessionTitleWorkPending(this.titleStateFromHeader(state.header))) pending.push(id);
      } catch { /* Deleted/unreadable unrelated sessions do not block recovery. */ }
      if (pending.length >= limit) break;
    }
    return pending;
  }

  async renameSession(sessionId: string, title: string): Promise<boolean> {
    return this.withSessionLock(sessionId, () => {
      if (!existsSync(this.sessionFile(sessionId))) return false;
      const state = this.readSessionFile(sessionId);
      state.header.titleState = manualSessionTitleState(this.titleStateFromHeader(state.header), title);
      state.header.title = title;
      this.writeSessionFileAtomic(sessionId, state.header, state.messages);
      return true;
    });
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    return this.withSessionLock(sessionId, () => {
      const file = this.sessionFile(sessionId);
      if (!existsSync(file)) return false;
      unlinkSync(file);
      return true;
    });
  }

  async prune(keepSessions: number): Promise<number> {
    const sessions = await this.listSessions();
    if (sessions.length <= keepSessions) return 0;
    const toRemove = sessions.slice(keepSessions);
    let removed = 0;
    for (const s of toRemove) {
      try {
        if (await this.deleteSession(s.id)) removed++;
      } catch { /* file already removed */ }
    }
    return removed;
  }

  async close(): Promise<void> {
    // No resources to release for file-based store
  }

  private sessionFile(sessionId: string): string {
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(sessionId)) {
      throw new ClientToolSettlementError("invalid_client_tool_settlement", "Invalid sessionId");
    }
    return join(this.sessionsDir, `${sessionId}.jsonl`);
  }

  private settlements(header: any): StoredClientToolSettlement[] {
    const value = header.clientToolSettlements;
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some(receipt => !receipt || typeof receipt !== "object"
      || receipt.sessionId !== header.id || typeof receipt.fingerprint !== "string"
      || typeof receipt.idempotencyKey !== "string")) {
      throw new ClientToolSettlementError("client_tool_settlement_corrupt", "Settlement receipt is invalid");
    }
    return value;
  }

  private projectMessages(state: { header: any; messages: Message[] }): Message[] {
    return projectClientToolSettlements(state.messages, this.settlements(state.header));
  }

  private readSettlementSession(sessionId: string): { header: any; messages: Message[] } {
    if (!existsSync(this.sessionFile(sessionId))) throw new ClientToolSettlementError("session_not_found", "Session not found");
    try { return this.readSessionFile(sessionId); }
    catch { throw new ClientToolSettlementError("client_tool_settlement_corrupt", "Session history is unreadable"); }
  }

  private existingClientToolResolution(
    state: { header: any; messages: Message[] }, input: ClientToolResolutionInput,
  ): ClientToolResolution | undefined {
    this.projectMessages(state);
    const settled = this.settlements(state.header).filter(receipt => receipt.toolCallId === input.toolCallId);
    const accepted = Object.values(state.header.continuations ?? {}).filter((receipt: any) => receipt.toolCallId === input.toolCallId) as any[];
    if (settled.length > 1 || accepted.length > 1 || (settled.length && accepted.length)) {
      throw new ClientToolSettlementError("client_tool_settlement_corrupt", "Client tool has conflicting receipts");
    }
    const common = { sessionId: input.sessionId, toolCallId: input.toolCallId, sessionVersion: Number(state.header.version ?? 0) };
    if (settled[0]) return { ...common, status: "settled", continuationAccepted: false,
      receipt: publicClientToolSettlementReceipt(settled[0]) };
    if (accepted[0]) {
      const stored = accepted[0];
      if (typeof stored.runId !== "string" || !stored.runId.trim() || !Number.isSafeInteger(stored.sessionVersion)
        || stored.sessionVersion < 0 || (stored.acceptedAt !== undefined
          && (typeof stored.acceptedAt !== "string" || !Number.isFinite(Date.parse(stored.acceptedAt))))) {
        throw new ClientToolSettlementError("client_tool_settlement_corrupt", "Accepted continuation receipt is invalid");
      }
      const receipt: ClientToolContinuationReceipt = { sessionId: input.sessionId, toolCallId: input.toolCallId,
        runId: stored.runId, sessionVersion: stored.sessionVersion,
        ...(stored.acceptedAt ? { acceptedAt: stored.acceptedAt } : {}) };
      return { ...common, status: "continuation", continuationAccepted: true, receipt };
    }
    return undefined;
  }

  private protectSettledMessage(state: { header: any; messages: Message[] }, original: Message, patched: Message): Message {
    const receipts = this.settlements(state.header);
    const acceptedIds = new Set(Object.values(state.header.continuations ?? {})
      .map((receipt: any) => receipt.toolCallId as string));
    if (!receipts.length && !acceptedIds.size) return patched;
    const canonical = this.projectMessages(state).find(message => message.id === original.id)!;
    if (receipts.some(receipt => receipt.resultMessageId === original.id)) {
      if (JSON.stringify(patched) !== JSON.stringify(original)) {
        throw new ClientToolSettlementError("client_tool_settlement_conflict", "Settlement result is immutable");
      }
      return original;
    }
    const protectedIds = new Set(receipts.filter(receipt => receipt.sourceAssistantMessageId === original.id).map(receipt => receipt.toolCallId));
    const acceptedCalls = new Map((original.toolCalls ?? []).filter(call => acceptedIds.has(call.id))
      .map(call => [call.id, call] as const));
    if (!protectedIds.size && !acceptedCalls.size) return patched;
    // The authoritative source declaration cannot be removed/reordered by a stale finalizer.
    // Keep accepted calls raw internally: their frozen catalog is needed for a
    // replay, while canonical history projects the existing tool result.
    const toolCalls = (canonical.toolCalls ?? []).map(call => protectedIds.has(call.id)
      ? call : (acceptedCalls.get(call.id) ?? patched.toolCalls?.find(candidate => candidate.id === call.id) ?? call));
    for (const call of patched.toolCalls ?? []) if (!toolCalls.some(existing => existing.id === call.id)) toolCalls.push(call);
    return { ...patched, toolCalls };
  }

  private readSessionFile(sessionId: string): { header: any; messages: Message[] } {
    const lines = readFileSync(this.sessionFile(sessionId), "utf-8").split("\n").filter(Boolean);
    if (lines.length === 0) throw new Error("Session file is empty");
    const header = JSON.parse(lines[0]);
    if (!header._session) throw new Error("Session header is invalid");
    return {
      header,
      messages: lines.slice(1).map((line) => JSON.parse(line) as Message),
    };
  }

  private writeSessionFileAtomic(sessionId: string, header: any, messages: Message[], preserveActivity = false): void {
    if (!preserveActivity) header.updatedAt = new Date().toISOString();
    const file = this.sessionFile(sessionId);
    const temporary = `${file}.${process.pid}.${nanoid(6)}.tmp`;
    const content = [header, ...messages].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    writeFileSync(temporary, content, "utf-8");
    renameSync(temporary, file);
  }

  private continuationTurnId(
    messages: readonly Message[],
    toolCallId: string,
  ): string | undefined {
    return [...messages].reverse().find((message) =>
      message.role === "assistant"
      && message.turnId
      && message.toolCalls?.some((call) => call.id === toolCallId)
    )?.turnId;
  }

  private canonicalOutbox(header: any): Record<string, any> {
    const value = header.canonicalTurnOutbox;
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  private findCanonicalTurn(
    turnId: string,
  ): { sessionId: string; entry: any } | undefined {
    if (!existsSync(this.sessionsDir)) return undefined;
    for (const file of readdirSync(this.sessionsDir).filter((value) => value.endsWith(".jsonl"))) {
      const sessionId = file.slice(0, -".jsonl".length);
      try {
        const entry = this.canonicalOutbox(this.readSessionFile(sessionId).header)[turnId];
        if (entry) return { sessionId, entry };
      } catch {
        // Ignore unrelated unreadable legacy sessions.
      }
    }
    return undefined;
  }

  private async updateCanonicalTurnOutbox(
    turnId: string,
    update: (entry: any) => boolean,
  ): Promise<boolean> {
    const located = this.findCanonicalTurn(turnId);
    if (!located) return false;
    return this.withSessionLock(located.sessionId, () => {
      const state = this.readSessionFile(located.sessionId);
      const outbox = this.canonicalOutbox(state.header);
      const entry = outbox[turnId];
      if (!entry || !update(entry)) return false;
      state.header.canonicalTurnOutbox = { ...outbox, [turnId]: entry };
      this.writeSessionFileAtomic(located.sessionId, state.header, state.messages);
      return true;
    });
  }

  private async withSessionLock<T>(sessionId: string, operation: () => T): Promise<T> {
    const key = this.sessionFile(sessionId);
    const previous = FileSessionStore.sessionLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    FileSessionStore.sessionLocks.set(key, current);
    await previous;
    try {
      return withProjectFileTransaction(this.polpoDir, () => operation());
    } finally {
      release();
      if (FileSessionStore.sessionLocks.get(key) === current) {
        FileSessionStore.sessionLocks.delete(key);
      }
    }
  }
}
