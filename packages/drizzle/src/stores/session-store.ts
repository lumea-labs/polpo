import { admittedSessionTitleState, initialSessionTitleState, manualSessionTitleState, sessionTitleSnapshot, sessionTitleWorkPending, sessionTitleInput, type SessionTitleState, type SessionTitleAdmission } from "@polpo-ai/core/session-titles";
import { eq, desc, asc, count as drizzleCount, isNull, and, sql } from "drizzle-orm";
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
import {
  normalizeCanonicalTurnCommitted,
  type CanonicalTurnCommitted,
} from "@polpo-ai/core/canonical-turn";
import {
  projectResolvedClientToolCalls,
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
import type { ChatSuggestion } from "@polpo-ai/core/chat-interactions";
import { type Dialect, deserializeJson, extractAffectedRows } from "../utils.js";

type AnyTable = any;

export type DrizzleTransactionProvider = <T>(
  execute: (transaction: any) => Promise<T>,
) => Promise<T>;

export class DrizzleSessionStore implements SessionStore {
  constructor(
    private db: any,
    private sessions: AnyTable,
    private messages: AnyTable,
    private continuations: AnyTable,
    private dialect: Dialect,
    private transactionProvider?: DrizzleTransactionProvider,
    private canonicalTurnOutbox?: AnyTable,
    private clientToolSettlements?: AnyTable,
  ) {}

  /** Serialize content for DB TEXT column: arrays → JSON string, plain strings → as-is. */
  private serializeContent(content: string | SessionContentPart[]): string {
    return Array.isArray(content) ? JSON.stringify(content) : content;
  }

  /** Deserialize content from DB TEXT column: try JSON parse → array, fallback to plain string. */
  private deserializeContent(raw: string): string | SessionContentPart[] {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as SessionContentPart[];
    } catch { /* plain string — not JSON */ }
    return raw;
  }

  /** Parse the metadata column. Postgres returns JSONB as object; SQLite stores
   *  it as a JSON string we have to deserialize. Both null/undefined → undefined. */
  private parseMetadata(raw: unknown): Record<string, string> | undefined {
    if (raw == null) return undefined;
    if (typeof raw === "object") return raw as Record<string, string>;
    if (typeof raw === "string") {
      try { return JSON.parse(raw) as Record<string, string>; } catch { return undefined; }
    }
    return undefined;
  }

  /** Inverse of parseMetadata — Postgres takes the object, SQLite takes a string. */
  private serializeMetadata(metadata: Record<string, string> | undefined): unknown {
    if (!metadata) return null;
    return this.dialect === "pg" ? metadata : JSON.stringify(metadata);
  }

  private rowToSession(row: any, messageCount: number): Session {
    const metadata = this.parseMetadata(row.metadata);
    return {
      ...sessionTitleSnapshot(this.titleStateFromRow(row)),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      messageCount,
      version: Number(row.version ?? 0),
      ...(row.agent ? { agent: row.agent } : {}),
      ...(row.user ? { user: row.user } : {}),
      ...(metadata ? { metadata } : {}),
      ...(row.scopeKey
        ? {
            scope: {
              key: row.scopeKey,
              ...(row.scopeVersion ? { version: row.scopeVersion } : {}),
            },
          }
        : {}),
    };
  }

  private rowToMessage(row: any): Message {
    return {
      id: row.id,
      role: row.role as MessageRole,
      content: this.deserializeContent(row.content),
      ts: row.ts,
      toolCalls: deserializeJson<ToolCallInfo[] | undefined>(row.toolCalls, undefined, this.dialect),
      suggestions: deserializeJson<ChatSuggestion[] | undefined>(row.suggestions, undefined, this.dialect),
      ...(row.toolCallId ? { toolCallId: row.toolCallId } : {}),
      ...(row.reasoning ? { reasoning: row.reasoning } : {}),
      ...(row.reasoningTruncated ? { reasoningTruncated: true } : {}),
      ...(row.turnId ? { turnId: row.turnId } : {}),
    };
  }

  private rowToStoredClientToolSettlement(row: any): StoredClientToolSettlement {
    if (
      !row
      || !["success", "failed", "cancelled"].includes(row.outcome)
      || !Number.isSafeInteger(Number(row.sessionVersion))
    ) {
      throw new ClientToolSettlementError(
        "client_tool_settlement_corrupt",
        "Stored client-tool settlement is corrupt",
      );
    }
    return {
      id: row.id,
      sessionId: row.sessionId,
      idempotencyKey: row.idempotencyKey,
      fingerprint: row.fingerprint,
      toolCallId: row.toolCallId,
      sourceAssistantMessageId: row.sourceAssistantMessageId,
      resultMessageId: row.resultMessageId,
      outcome: row.outcome,
      sessionVersion: Number(row.sessionVersion),
      settledAt: row.settledAt,
    };
  }

  private rowToClientToolContinuation(row: any): ClientToolContinuationReceipt {
    return {
      sessionId: row.sessionId,
      toolCallId: row.toolCallId,
      runId: row.runId,
      sessionVersion: Number(row.sessionVersion),
      ...(row.createdAt ? { acceptedAt: row.createdAt } : {}),
    };
  }

  private requireClientToolSettlements(): AnyTable {
    if (!this.clientToolSettlements) {
      throw new ClientToolSettlementError(
        "client_tool_settlement_unavailable",
        "Client-tool settlement persistence is not configured",
      );
    }
    return this.clientToolSettlements;
  }

  private projectSessionMessages(
    messages: readonly Message[],
    receipts: readonly StoredClientToolSettlement[],
  ): Message[] {
    return projectClientToolSettlements(messages, receipts);
  }

  private materializeSettledToolCall(
    call: ToolCallInfo,
    outcome: StoredClientToolSettlement["outcome"],
    content: string,
  ): ToolCallInfo {
    const { continuationClientTools: _continuationClientTools, ...terminal } = call;
    return {
      ...terminal,
      state: outcome === "success" ? "completed" : "error",
      result: content,
      settlementOutcome: outcome,
    };
  }

  private clientToolResolutionFromRows(
    input: ClientToolResolutionInput,
    sessionRow: any,
    messageRows: readonly any[],
    receiptRows: readonly any[],
    continuationRows: readonly any[],
  ): ClientToolResolution {
    const session = this.rowToSession(sessionRow, 0);
    assertClientToolSettlementScope(session, input);
    const receipts = receiptRows.map((row) => this.rowToStoredClientToolSettlement(row));
    const canonical = this.projectSessionMessages(
      messageRows.map((row) => this.rowToMessage(row)),
      receipts,
    );
    const matchingReceipts = receipts.filter((receipt) => receipt.toolCallId === input.toolCallId);
    const matchingContinuations = continuationRows.filter(
      (continuation) => continuation.toolCallId === input.toolCallId,
    );
    if (matchingReceipts.length > 1 || matchingContinuations.length > 1) {
      throw new ClientToolSettlementError(
        "client_tool_settlement_corrupt",
        "Client tool call has ambiguous terminal state",
      );
    }
    if (matchingReceipts[0] && matchingContinuations[0]) {
      throw new ClientToolSettlementError(
        "client_tool_settlement_corrupt",
        "Client tool call has both a settlement and an accepted continuation",
      );
    }
    const sessionVersion = Number(sessionRow.version ?? 0);
    if (matchingReceipts[0]) {
      return {
        status: "settled",
        continuationAccepted: false,
        sessionId: input.sessionId,
        toolCallId: input.toolCallId,
        sessionVersion,
        receipt: publicClientToolSettlementReceipt(matchingReceipts[0]),
      };
    }
    if (matchingContinuations[0]) {
      return {
        status: "continuation",
        continuationAccepted: true,
        sessionId: input.sessionId,
        toolCallId: input.toolCallId,
        sessionVersion,
        receipt: this.rowToClientToolContinuation(matchingContinuations[0]),
      };
    }
    resolveClientToolSettlementTarget(canonical, input.toolCallId);
    return {
      status: "pending",
      continuationAccepted: false,
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      sessionVersion,
    };
  }

  private validateSettlementHistory(
    messageRows: readonly any[],
    receiptRows: readonly any[],
  ): void {
    this.projectSessionMessages(
      messageRows.map((row) => this.rowToMessage(row)),
      receiptRows.map((row) => this.rowToStoredClientToolSettlement(row)),
    );
  }

  async create(arg1?: string | SessionCreateOptions, arg2?: string): Promise<string> {
    const opts = normalizeSessionCreateArgs(arg1, arg2);
    const id = nanoid(10);
    const now = new Date().toISOString();
    await this.db.insert(this.sessions).values({
      id,
      title: opts.title ?? null,
      titleState: JSON.stringify(initialSessionTitleState(id, opts.title, opts.titleSource ?? "manual", now)),
      titleWorkPending: false,
      agent: opts.agent ?? null,
      user: opts.user ?? null,
      metadata: this.serializeMetadata(opts.metadata),
      version: 0,
      scopeKey: opts.scope?.key ?? null,
      scopeVersion: opts.scope?.version ?? null,
      createdAt: now,
      updatedAt: now,
    });
    return id;
  }

  async addMessage(
    sessionId: string,
    role: MessageRole,
    content: string | SessionContentPart[],
    options?: SessionMessageOptions,
  ): Promise<Message> {
    const id = nanoid();
    const ts = new Date().toISOString();
    const serialized = this.serializeContent(content);
    const values = {
      id,
      sessionId,
      role,
      content: serialized,
      ts,
      toolCalls: null,
      suggestions: null,
      toolCallId: options?.toolCallId ?? null,
      reasoning: null,
      reasoningTruncated: false,
      turnId: options?.turnId ?? null,

    };
    if (role === "user" && options?.sessionTitle) {
      await this.insertTitleUserMessage(values, content, options.sessionTitle);
    } else {
    await this.db.insert(this.messages).values(values);
    await this.db.update(this.sessions)
      .set({ updatedAt: ts, version: sql`${this.sessions.version} + 1` })
      .where(eq(this.sessions.id, sessionId));

    }
    return {
      id,
      role,
      content,
      ts,
      ...(options?.toolCallId ? { toolCallId: options.toolCallId } : {}),
      ...(options?.turnId ? { turnId: options.turnId } : {}),
    };
  }

  async commitCanonicalTurn(
    input: CommitCanonicalTurnInput,
  ): Promise<CommitCanonicalTurnResult> {
    if (!this.canonicalTurnOutbox) {
      throw new Error("Canonical turn persistence is not configured");
    }
    const turn = normalizeCanonicalTurnCommitted(input.turn);
    if (turn.assistantMessage?.id !== input.assistant.messageId) {
      throw new Error("Canonical turn assistant identity does not match persistence input");
    }
    const serializedEvent = JSON.stringify(turn);
    const serializedContent = this.serializeContent(input.assistant.content);
    const serializedSuggestions = input.assistant.suggestions?.length
      ? JSON.stringify(input.assistant.suggestions)
      : null;

    if (this.dialect === "sqlite") {
      if (typeof this.db.transaction !== "function") {
        throw new Error("Canonical turn persistence requires transactional database support");
      }
      return this.db.transaction((db: any) => {
        const session = db.select().from(this.sessions)
          .where(eq(this.sessions.id, turn.sessionId))
          .limit(1)
          .all()[0];
        if (!session) throw new Error("Canonical turn session not found");
        const existing = db.select().from(this.canonicalTurnOutbox)
          .where(eq(this.canonicalTurnOutbox.turnId, turn.turnId))
          .limit(1)
          .all()[0];
        if (existing) {
          this.assertSameCanonicalTurn(existing.event, serializedEvent);
          return { turn, created: false };
        }
        this.assertCanonicalTurnMessagesSync(db, turn);
        let protectedToolCalls = input.assistant.toolCalls
          ? [...input.assistant.toolCalls]
          : undefined;
        if (this.clientToolSettlements) {
          const messageRows = db.select().from(this.messages)
            .where(eq(this.messages.sessionId, turn.sessionId))
            .orderBy(asc(this.messages.ts))
            .all();
          const receiptRows = db.select().from(this.clientToolSettlements)
            .where(eq(this.clientToolSettlements.sessionId, turn.sessionId))
            .all();
          const continuationRows = db.select().from(this.continuations)
            .where(eq(this.continuations.sessionId, turn.sessionId))
            .all();
          protectedToolCalls = this.protectTerminalSourceToolCalls(
            messageRows.map((row: any) => this.rowToMessage(row)),
            receiptRows.map((row: any) => this.rowToStoredClientToolSettlement(row)),
            continuationRows,
            input.assistant.messageId,
            protectedToolCalls,
          );
        }
        const updated = db.update(this.messages).set({
          content: serializedContent,
          toolCalls: protectedToolCalls?.length ? JSON.stringify(protectedToolCalls) : null,
          suggestions: serializedSuggestions,
          reasoning: input.assistant.reasoning?.text ?? null,
          reasoningTruncated: input.assistant.reasoning?.truncated ?? false,
        }).where(and(
          eq(this.messages.id, input.assistant.messageId),
          eq(this.messages.sessionId, turn.sessionId),
          eq(this.messages.turnId, turn.turnId),
        )).run();
        if (extractAffectedRows(updated) !== 1) {
          throw new Error("Canonical assistant message changed before commit");
        }
        db.insert(this.canonicalTurnOutbox).values({
          turnId: turn.turnId,
          sessionId: turn.sessionId,
          event: serializedEvent,
          status: "pending",
          attempts: 0,
          createdAt: turn.occurredAt,
          updatedAt: turn.occurredAt,
        }).run();
        db.update(this.sessions).set({ updatedAt: turn.occurredAt })
          .where(eq(this.sessions.id, turn.sessionId)).run();
        return { turn, created: true };
      });
    }

    const execute = async (db: any): Promise<CommitCanonicalTurnResult> => {
      let sessionQuery = db.select().from(this.sessions)
        .where(eq(this.sessions.id, turn.sessionId))
        .limit(1);
      if (typeof sessionQuery.for === "function") sessionQuery = sessionQuery.for("update");
      const sessionRows: any[] = await sessionQuery;
      if (!sessionRows[0]) throw new Error("Canonical turn session not found");
      const existingRows = await db.select().from(this.canonicalTurnOutbox)
        .where(eq(this.canonicalTurnOutbox.turnId, turn.turnId))
        .limit(1);
      if (existingRows[0]) {
        this.assertSameCanonicalTurn(existingRows[0].event, serializedEvent);
        return { turn, created: false };
      }
      await this.assertCanonicalTurnMessages(db, turn);
      let protectedToolCalls = input.assistant.toolCalls
        ? [...input.assistant.toolCalls]
        : undefined;
      if (this.clientToolSettlements) {
        const messageRows: any[] = await db.select().from(this.messages)
          .where(eq(this.messages.sessionId, turn.sessionId))
          .orderBy(asc(this.messages.ts));
        const receiptRows: any[] = await db.select().from(this.clientToolSettlements)
          .where(eq(this.clientToolSettlements.sessionId, turn.sessionId));
        const continuationRows: any[] = await db.select().from(this.continuations)
          .where(eq(this.continuations.sessionId, turn.sessionId));
        protectedToolCalls = this.protectTerminalSourceToolCalls(
          messageRows.map((row) => this.rowToMessage(row)),
          receiptRows.map((row) => this.rowToStoredClientToolSettlement(row)),
          continuationRows,
          input.assistant.messageId,
          protectedToolCalls,
        );
      }
      const updated = await db.update(this.messages).set({
        content: serializedContent,
        toolCalls: protectedToolCalls?.length ? JSON.stringify(protectedToolCalls) : null,
        suggestions: serializedSuggestions,
        reasoning: input.assistant.reasoning?.text ?? null,
        reasoningTruncated: input.assistant.reasoning?.truncated ?? false,
      }).where(and(
        eq(this.messages.id, input.assistant.messageId),
        eq(this.messages.sessionId, turn.sessionId),
        eq(this.messages.turnId, turn.turnId),
      ));
      if (extractAffectedRows(updated) !== 1) {
        throw new Error("Canonical assistant message changed before commit");
      }
      await db.insert(this.canonicalTurnOutbox).values({
        turnId: turn.turnId,
        sessionId: turn.sessionId,
        event: turn,
        status: "pending",
        attempts: 0,
        createdAt: turn.occurredAt,
        updatedAt: turn.occurredAt,
      });
      await db.update(this.sessions).set({ updatedAt: turn.occurredAt })
        .where(eq(this.sessions.id, turn.sessionId));
      return { turn, created: true };
    };

    if (this.transactionProvider) return this.transactionProvider(execute);
    if (typeof this.db.transaction !== "function") {
      throw new Error("Canonical turn persistence requires transactional database support");
    }
    return this.db.transaction(execute);
  }

  async getCanonicalTurn(turnId: string): Promise<CanonicalTurnCommitted | undefined> {
    if (!this.canonicalTurnOutbox) return undefined;
    const rows = await this.db.select().from(this.canonicalTurnOutbox)
      .where(eq(this.canonicalTurnOutbox.turnId, turnId))
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;
    const value = typeof row.event === "string" ? JSON.parse(row.event) : row.event;
    return normalizeCanonicalTurnCommitted(value);
  }

  async listPendingCanonicalTurns(
    limit = 100,
  ): Promise<readonly CanonicalTurnOutboxEntry[]> {
    if (!this.canonicalTurnOutbox) return [];
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new TypeError("Canonical turn outbox limit must be between 1 and 1000");
    }
    const rows = await this.db.select().from(this.canonicalTurnOutbox)
      .where(eq(this.canonicalTurnOutbox.status, "pending"))
      .orderBy(asc(this.canonicalTurnOutbox.createdAt))
      .limit(limit);
    return rows.map((row: any) => Object.freeze({
      turn: normalizeCanonicalTurnCommitted(
        typeof row.event === "string" ? JSON.parse(row.event) : row.event,
      ),
      status: "pending" as const,
      attempts: Number(row.attempts ?? 0),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  async markCanonicalTurnDispatched(turnId: string): Promise<boolean> {
    if (!this.canonicalTurnOutbox) return false;
    const now = new Date().toISOString();
    const result = await this.db.update(this.canonicalTurnOutbox).set({
      status: "dispatched",
      updatedAt: now,
    }).where(and(
      eq(this.canonicalTurnOutbox.turnId, turnId),
      eq(this.canonicalTurnOutbox.status, "pending"),
    ));
    return extractAffectedRows(result) === 1;
  }

  async recordCanonicalTurnDispatchFailure(turnId: string): Promise<boolean> {
    if (!this.canonicalTurnOutbox) return false;
    const now = new Date().toISOString();
    const result = await this.db.update(this.canonicalTurnOutbox).set({
      attempts: sql`${this.canonicalTurnOutbox.attempts} + 1`,
      updatedAt: now,
    }).where(and(
      eq(this.canonicalTurnOutbox.turnId, turnId),
      eq(this.canonicalTurnOutbox.status, "pending"),
    ));
    return extractAffectedRows(result) === 1;
  }

  private assertCanonicalTurnMessagesSync(db: any, turn: CanonicalTurnCommitted): void {
    const user = db.select().from(this.messages).where(and(
      eq(this.messages.id, turn.userMessage.id),
      eq(this.messages.sessionId, turn.sessionId),
    )).limit(1).all()[0];
    const assistant = db.select().from(this.messages).where(and(
      eq(this.messages.id, turn.assistantMessage!.id),
      eq(this.messages.sessionId, turn.sessionId),
    )).limit(1).all()[0];
    this.assertCanonicalMessageRows(user, assistant, turn);
  }

  private async assertCanonicalTurnMessages(
    db: any,
    turn: CanonicalTurnCommitted,
  ): Promise<void> {
    const userRows = await db.select().from(this.messages).where(and(
      eq(this.messages.id, turn.userMessage.id),
      eq(this.messages.sessionId, turn.sessionId),
    )).limit(1);
    const assistantRows = await db.select().from(this.messages).where(and(
      eq(this.messages.id, turn.assistantMessage!.id),
      eq(this.messages.sessionId, turn.sessionId),
    )).limit(1);
    this.assertCanonicalMessageRows(userRows[0], assistantRows[0], turn);
  }

  private assertCanonicalMessageRows(
    user: any,
    assistant: any,
    turn: CanonicalTurnCommitted,
  ): void {
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
  }

  private assertSameCanonicalTurn(existing: unknown, expected: string): void {
    const value = typeof existing === "string" ? existing : JSON.stringify(existing);
    if (value !== expected) {
      throw new Error("Canonical turn id was already committed with different metadata");
    }
  }

  private protectTerminalSourceToolCalls(
    messages: readonly Message[],
    receipts: readonly StoredClientToolSettlement[],
    continuationRows: readonly any[],
    messageId: string,
    incoming: readonly ToolCallInfo[] | undefined,
  ): ToolCallInfo[] | undefined {
    if (receipts.some((receipt) => receipt.resultMessageId === messageId)) {
      throw new ClientToolSettlementError(
        "client_tool_settlement_conflict",
        "Settlement result messages are immutable",
      );
    }
    const sourceReceipts = receipts.filter(
      (receipt) => receipt.sourceAssistantMessageId === messageId,
    );
    const acceptedToolCallIds = new Set(
      continuationRows.map((continuation) => continuation.toolCallId),
    );
    const rawSource = messages.find((message) => message.id === messageId);
    const acceptedSourceIds = new Set(
      rawSource?.role === "assistant"
        ? (rawSource.toolCalls ?? [])
          .filter((call) => acceptedToolCallIds.has(call.id))
          .map((call) => call.id)
        : [],
    );
    if (sourceReceipts.length === 0 && acceptedSourceIds.size === 0) {
      return incoming ? [...incoming] : undefined;
    }
    const canonical = this.projectSessionMessages(messages, receipts);
    const canonicalSource = canonical.find((message) => message.id === messageId);
    if (
      !rawSource
      || rawSource.role !== "assistant"
      || !rawSource.toolCalls?.length
      || !canonicalSource
      || canonicalSource.role !== "assistant"
      || !canonicalSource.toolCalls?.length
    ) {
      throw new ClientToolSettlementError(
        "client_tool_settlement_corrupt",
        "Terminal client tool source message is missing",
      );
    }
    const settledIds = new Set(sourceReceipts.map((receipt) => receipt.toolCallId));
    const settledCalls = new Map(
      canonicalSource.toolCalls
        .filter((call) => settledIds.has(call.id))
        .map((call) => [call.id, call] as const),
    );
    if (settledCalls.size !== settledIds.size) {
      throw new ClientToolSettlementError(
        "client_tool_settlement_corrupt",
        "Settled client tool call is missing from its source message",
      );
    }
    // Preserve the authoritative declaration order and every existing sibling.
    // Receipt-backed calls use their canonical terminal projection. Accepted
    // continuations retain the raw interrupted call because its hidden tool
    // catalog is required to reproduce an idempotent continuation replay.
    const next = rawSource.toolCalls.map((call) => {
      const settled = settledCalls.get(call.id);
      if (settled) return settled;
      if (acceptedSourceIds.has(call.id)) return call;
      return incoming?.find((candidate) => candidate.id === call.id) ?? call;
    });
    for (const call of incoming ?? []) {
      if (!next.some((candidate) => candidate.id === call.id)) next.push(call);
    }
    return next.length > 0 ? next : undefined;
  }

  async updateMessage(
    sessionId: string,
    messageId: string,
    content: string | SessionContentPart[],
    toolCalls?: ToolCallInfo[],
    suggestions?: ChatSuggestion[],
    reasoning?: PersistedReasoning,
  ): Promise<boolean> {
    const now = new Date().toISOString();
    const serialized = this.serializeContent(content);

    // Legacy constructors without settlement persistence keep the historical
    // direct-update behavior. Once the settlement capability is enabled, a
    // Session lock is mandatory to serialize late writers with settlement and
    // continuation acceptance.
    if (!this.clientToolSettlements) {
      const result = await this.db.update(this.messages).set({
        content: serialized,
        toolCalls: toolCalls ? JSON.stringify(toolCalls) : null,
        suggestions: suggestions?.length ? JSON.stringify(suggestions) : null,
        reasoning: reasoning?.text ?? null,
        reasoningTruncated: reasoning?.truncated ?? false,
      }).where(and(
        eq(this.messages.id, messageId),
        eq(this.messages.sessionId, sessionId),
      ));
      const changed = extractAffectedRows(result) > 0;
      if (changed) {
        await this.db.update(this.sessions).set({ updatedAt: now })
          .where(eq(this.sessions.id, sessionId));
      }
      return changed;
    }

    if (this.dialect === "sqlite") {
      if (typeof this.db.transaction !== "function") {
        throw new Error("Session message updates require transactional database support");
      }
      return this.db.transaction((db: any) => {
        const session = db.select().from(this.sessions)
          .where(eq(this.sessions.id, sessionId))
          .limit(1)
          .all()[0];
        if (!session) return false;
        let protectedToolCalls = toolCalls;
        if (this.clientToolSettlements) {
          const messageRows = db.select().from(this.messages)
            .where(eq(this.messages.sessionId, sessionId))
            .orderBy(asc(this.messages.ts))
            .all();
          const receiptRows = db.select().from(this.clientToolSettlements)
            .where(eq(this.clientToolSettlements.sessionId, sessionId))
            .all();
          const continuationRows = db.select().from(this.continuations)
            .where(eq(this.continuations.sessionId, sessionId))
            .all();
          protectedToolCalls = this.protectTerminalSourceToolCalls(
            messageRows.map((row: any) => this.rowToMessage(row)),
            receiptRows.map((row: any) => this.rowToStoredClientToolSettlement(row)),
            continuationRows,
            messageId,
            toolCalls,
          );
        }
        const result = db.update(this.messages).set({
          content: serialized,
          toolCalls: protectedToolCalls ? JSON.stringify(protectedToolCalls) : null,
          suggestions: suggestions?.length ? JSON.stringify(suggestions) : null,
          reasoning: reasoning?.text ?? null,
          reasoningTruncated: reasoning?.truncated ?? false,
        }).where(and(
          eq(this.messages.id, messageId),
          eq(this.messages.sessionId, sessionId),
        )).run();
        const changed = extractAffectedRows(result) > 0;
        if (changed) {
          db.update(this.sessions).set({ updatedAt: now })
            .where(eq(this.sessions.id, sessionId)).run();
        }
        return changed;
      });
    }

    const execute = async (db: any): Promise<boolean> => {
      let sessionQuery = db.select().from(this.sessions)
        .where(eq(this.sessions.id, sessionId))
        .limit(1);
      if (typeof sessionQuery.for === "function") sessionQuery = sessionQuery.for("update");
      const sessionRows: any[] = await sessionQuery;
      if (!sessionRows[0]) return false;
      let protectedToolCalls = toolCalls;
      if (this.clientToolSettlements) {
        const messageRows: any[] = await db.select().from(this.messages)
          .where(eq(this.messages.sessionId, sessionId))
          .orderBy(asc(this.messages.ts));
        const receiptRows: any[] = await db.select().from(this.clientToolSettlements)
          .where(eq(this.clientToolSettlements.sessionId, sessionId));
        const continuationRows: any[] = await db.select().from(this.continuations)
          .where(eq(this.continuations.sessionId, sessionId));
        protectedToolCalls = this.protectTerminalSourceToolCalls(
          messageRows.map((row) => this.rowToMessage(row)),
          receiptRows.map((row) => this.rowToStoredClientToolSettlement(row)),
          continuationRows,
          messageId,
          toolCalls,
        );
      }
      const result = await db.update(this.messages).set({
        content: serialized,
        toolCalls: protectedToolCalls ? JSON.stringify(protectedToolCalls) : null,
        suggestions: suggestions?.length ? JSON.stringify(suggestions) : null,
        reasoning: reasoning?.text ?? null,
        reasoningTruncated: reasoning?.truncated ?? false,
      }).where(and(
        eq(this.messages.id, messageId),
        eq(this.messages.sessionId, sessionId),
      ));
      const changed = extractAffectedRows(result) > 0;
      if (changed) {
        await db.update(this.sessions).set({ updatedAt: now })
          .where(eq(this.sessions.id, sessionId));
      }
      return changed;
    };
    if (this.transactionProvider) return this.transactionProvider(execute);
    if (typeof this.db.transaction !== "function") {
      throw new Error("Session message updates require transactional database support");
    }
    return this.db.transaction(execute);
  }

  async getMessages(sessionId: string): Promise<Message[]> {
    if (!this.clientToolSettlements) {
      const rows: any[] = await this.db.select().from(this.messages)
        .where(eq(this.messages.sessionId, sessionId))
        .orderBy(asc(this.messages.ts));
      return projectResolvedClientToolCalls(rows.map((r) => this.rowToMessage(r)));
    }
    // Some supported drivers (notably neon-http) cannot open an interactive
    // transaction on the primary handle. Fence the two reads with the Session
    // version instead: every settlement commits its receipt/result and version
    // atomically, so an unchanged version proves a coherent snapshot. This
    // avoids both a global transaction requirement and a messages×receipts join.
    for (let attempt = 0; attempt < 4; attempt++) {
      const beforeRows: any[] = await this.db.select({ version: this.sessions.version })
        .from(this.sessions)
        .where(eq(this.sessions.id, sessionId))
        .limit(1);
      const rows: any[] = await this.db.select().from(this.messages)
        .where(eq(this.messages.sessionId, sessionId))
        .orderBy(asc(this.messages.ts));
      const receiptRows: any[] = await this.db.select().from(this.clientToolSettlements)
        .where(eq(this.clientToolSettlements.sessionId, sessionId));
      const afterRows: any[] = await this.db.select({ version: this.sessions.version })
        .from(this.sessions)
        .where(eq(this.sessions.id, sessionId))
        .limit(1);
      const before = beforeRows[0]?.version;
      const after = afterRows[0]?.version;
      if (before === undefined || after === undefined) {
        if (before === undefined && after === undefined && rows.length === 0 && receiptRows.length === 0) {
          return [];
        }
        continue;
      }
      if (Number(before) === Number(after)) {
        return this.projectSessionMessages(
          rows.map((row) => this.rowToMessage(row)),
          receiptRows.map((row) => this.rowToStoredClientToolSettlement(row)),
        );
      }
    }
    throw new ClientToolSettlementError(
      "client_tool_settlement_unavailable",
      "Session changed repeatedly while reading settlement history",
    );
  }

  async getRecentMessages(sessionId: string, limit: number): Promise<Message[]> {
    if (limit <= 0) return [];
    return (await this.getMessages(sessionId)).slice(-limit);
  }

  async listSessions(filter?: SessionListFilter): Promise<Session[]> {
    let query = this.db
      .select({
        id: this.sessions.id,
        title: this.sessions.title,
        titleState: this.sessions.titleState,
        agent: this.sessions.agent,
        user: this.sessions.user,
        metadata: this.sessions.metadata,
        version: this.sessions.version,
        scopeKey: this.sessions.scopeKey,
        scopeVersion: this.sessions.scopeVersion,
        createdAt: this.sessions.createdAt,
        updatedAt: this.sessions.updatedAt,
        messageCount: drizzleCount(this.messages.id),
      })
      .from(this.sessions)
      .leftJoin(this.messages, eq(this.sessions.id, this.messages.sessionId));

    // Apply equality-only filters. Metadata key/value pairs ANDed together;
    // dialect split is necessary because SQLite stores metadata as a JSON
    // string (substring search) while Postgres uses native JSONB containment.
    const conditions: any[] = [];
    if (filter?.user) conditions.push(eq(this.sessions.user, filter.user));
    if (filter?.metadata) {
      for (const [k, v] of Object.entries(filter.metadata)) {
        if (this.dialect === "pg") {
          conditions.push(sql`${this.sessions.metadata} @> ${JSON.stringify({ [k]: v })}::jsonb`);
        } else {
          // SQLite fallback — substring match on the JSON-stringified column.
          // Good enough for low-cardinality tagging; not a hot path.
          conditions.push(sql`${this.sessions.metadata} LIKE ${"%" + JSON.stringify({ [k]: v }).slice(1, -1) + "%"}`);
        }
      }
    }
    if (conditions.length > 0) query = query.where(and(...conditions));

    const rows: any[] = await query
      .groupBy(this.sessions.id)
      .orderBy(desc(this.sessions.updatedAt));

    return rows.map((r) => this.rowToSession(r, Number(r.messageCount)));
  }

  async getSession(sessionId: string): Promise<Session | undefined> {
    const rows: any[] = await this.db
      .select({
        id: this.sessions.id,
        title: this.sessions.title,
        titleState: this.sessions.titleState,
        agent: this.sessions.agent,
        user: this.sessions.user,
        metadata: this.sessions.metadata,
        version: this.sessions.version,
        scopeKey: this.sessions.scopeKey,
        scopeVersion: this.sessions.scopeVersion,
        createdAt: this.sessions.createdAt,
        updatedAt: this.sessions.updatedAt,
        messageCount: drizzleCount(this.messages.id),
      })
      .from(this.sessions)
      .leftJoin(this.messages, eq(this.sessions.id, this.messages.sessionId))
      .where(eq(this.sessions.id, sessionId))
      .groupBy(this.sessions.id);

    return rows.length > 0 ? this.rowToSession(rows[0], Number(rows[0].messageCount)) : undefined;
  }

  async getLatestSession(agent?: string | null): Promise<Session | undefined> {
    let query = this.db
      .select({
        id: this.sessions.id,
        title: this.sessions.title,
        titleState: this.sessions.titleState,
        agent: this.sessions.agent,
        user: this.sessions.user,
        metadata: this.sessions.metadata,
        version: this.sessions.version,
        scopeKey: this.sessions.scopeKey,
        scopeVersion: this.sessions.scopeVersion,
        createdAt: this.sessions.createdAt,
        updatedAt: this.sessions.updatedAt,
        messageCount: drizzleCount(this.messages.id),
      })
      .from(this.sessions)
      .leftJoin(this.messages, eq(this.sessions.id, this.messages.sessionId));

    // Filter by agent scope
    if (agent === null) {
      // Orchestrator sessions only (no agent)
      query = query.where(isNull(this.sessions.agent));
    } else if (agent !== undefined) {
      // Agent-specific sessions
      query = query.where(eq(this.sessions.agent, agent));
    }
    // agent === undefined → no filter, return most recent regardless

    const rows: any[] = await query
      .groupBy(this.sessions.id)
      .orderBy(desc(this.sessions.updatedAt))
      .limit(1);

    return rows.length > 0 ? this.rowToSession(rows[0], Number(rows[0].messageCount)) : undefined;
  }

  private titleStateFromRow(row: any): SessionTitleState {
    return row.titleState ? JSON.parse(row.titleState) : initialSessionTitleState(row.id, row.title ?? undefined, "legacy", row.createdAt);
  }

  async getSessionTitleState(sessionId: string): Promise<SessionTitleState | undefined> {
    const [row] = await this.db.select().from(this.sessions).where(eq(this.sessions.id, sessionId)).limit(1);
    return row ? this.titleStateFromRow(row) : undefined;
  }

  async compareAndSetSessionTitleState(sessionId: string, expected: SessionTitleState, next: SessionTitleState): Promise<boolean> {
    const expectedState = expected.snapshot.titleSource === "legacy"
      ? and(isNull(this.sessions.titleState), expected.snapshot.title === undefined ? isNull(this.sessions.title) : eq(this.sessions.title, expected.snapshot.title))
      : eq(this.sessions.titleState, JSON.stringify(expected));
    const rows = await this.db.update(this.sessions).set({
      title: next.snapshot.title ?? null, titleState: JSON.stringify(next), titleWorkPending: sessionTitleWorkPending(next),
      ...(next.snapshot.titleSource === "manual" && next.snapshot.titleRevision > expected.snapshot.titleRevision ? { updatedAt: next.snapshot.titleUpdatedAt } : {}),
    }).where(and(eq(this.sessions.id, sessionId), expectedState)).returning({ id: this.sessions.id });
    return rows.length === 1;
  }

  private async insertTitleUserMessage(values: any, content: string | SessionContentPart[], request: NonNullable<SessionMessageOptions["sessionTitle"]>): Promise<void> {
    const nextState = (row: any, hasUser: boolean): SessionTitleState | undefined => {
      if (!row || hasUser) return undefined;
      const before = this.titleStateFromRow(row);
      const after = admittedSessionTitleState(before, { ...request, sessionId: values.sessionId, messageId: values.id, text: sessionTitleInput(content), createdAt: values.ts });
      return after === before ? undefined : after;
    };
    const updates = (state?: SessionTitleState) => ({ updatedAt: values.ts, version: sql`${this.sessions.version} + 1`,
      ...(state ? { titleState: JSON.stringify(state), titleWorkPending: sessionTitleWorkPending(state) } : {}) });
    if (this.dialect === "sqlite") {
      this.db.transaction((db: any) => {
        const row = db.select().from(this.sessions).where(eq(this.sessions.id, values.sessionId)).get();
        const user = db.select({ id: this.messages.id }).from(this.messages).where(and(eq(this.messages.sessionId, values.sessionId), eq(this.messages.role, "user"))).limit(1).get();
        db.insert(this.messages).values(values).run();
        db.update(this.sessions).set(updates(nextState(row, !!user))).where(eq(this.sessions.id, values.sessionId)).run();
      });
      return;
    }
    const execute = async (db: any) => {
      const [row] = await db.select().from(this.sessions).where(eq(this.sessions.id, values.sessionId)).for("update");
      const [user] = await db.select({ id: this.messages.id }).from(this.messages).where(and(eq(this.messages.sessionId, values.sessionId), eq(this.messages.role, "user"))).limit(1);
      await db.insert(this.messages).values(values);
      await db.update(this.sessions).set(updates(nextState(row, !!user))).where(eq(this.sessions.id, values.sessionId));
    };
    if (this.transactionProvider) await this.transactionProvider(execute);
    else await this.db.transaction(execute);
  }

  async listPendingSessionTitles(limit = 32): Promise<string[]> {
    const rows = await this.db.select({ id: this.sessions.id }).from(this.sessions)
      .where(eq(this.sessions.titleWorkPending, true))
      .orderBy(asc(this.sessions.createdAt)).limit(limit);
    return rows.map((row: { id: string }) => row.id);
  }

  async renameSession(sessionId: string, title: string): Promise<boolean> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const state = await this.getSessionTitleState(sessionId);
      if (!state) return false;
      if (await this.compareAndSetSessionTitleState(sessionId, state, manualSessionTitleState(state, title))) return true;
    }
    throw new Error("Session title changed repeatedly while renaming");
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    // Messages are cascade-deleted via FK
    const result = await this.db.delete(this.sessions)
      .where(eq(this.sessions.id, sessionId));
    return extractAffectedRows(result) > 0;
  }

  async prune(keepSessions: number): Promise<number> {
    const all: any[] = await this.db.select({ id: this.sessions.id })
      .from(this.sessions)
      .orderBy(desc(this.sessions.updatedAt));

    if (all.length <= keepSessions) return 0;

    const toDelete = all.slice(keepSessions).map((r) => r.id);
    let deleted = 0;
    for (const id of toDelete) {
      await this.db.delete(this.sessions).where(eq(this.sessions.id, id));
      deleted++;
    }
    return deleted;
  }

  async getClientToolResolution(
    input: ClientToolResolutionInput,
  ): Promise<ClientToolResolution> {
    const settlements = this.requireClientToolSettlements();
    if (this.dialect === "sqlite") {
      if (typeof this.db.transaction !== "function") {
        throw new ClientToolSettlementError(
          "client_tool_settlement_unavailable",
          "Client-tool resolution requires transactional database support",
        );
      }
      return this.db.transaction((db: any) => {
        const sessionRow = db.select().from(this.sessions)
          .where(eq(this.sessions.id, input.sessionId))
          .limit(1)
          .all()[0];
        if (!sessionRow) {
          throw new ClientToolSettlementError("session_not_found", "Session not found");
        }
        const messageRows = db.select().from(this.messages)
          .where(eq(this.messages.sessionId, input.sessionId))
          .orderBy(asc(this.messages.ts))
          .all();
        const receiptRows = db.select().from(settlements)
          .where(eq(settlements.sessionId, input.sessionId))
          .all();
        const continuationRows = db.select().from(this.continuations)
          .where(and(
            eq(this.continuations.sessionId, input.sessionId),
            eq(this.continuations.toolCallId, input.toolCallId),
          ))
          .limit(2)
          .all();
        return this.clientToolResolutionFromRows(
          input,
          sessionRow,
          messageRows,
          receiptRows,
          continuationRows,
        );
      });
    }

    const execute = async (db: any): Promise<ClientToolResolution> => {
      let sessionQuery = db.select().from(this.sessions)
        .where(eq(this.sessions.id, input.sessionId))
        .limit(1);
      if (typeof sessionQuery.for === "function") sessionQuery = sessionQuery.for("update");
      const sessionRows: any[] = await sessionQuery;
      const sessionRow = sessionRows[0];
      if (!sessionRow) {
        throw new ClientToolSettlementError("session_not_found", "Session not found");
      }
      const messageRows: any[] = await db.select().from(this.messages)
        .where(eq(this.messages.sessionId, input.sessionId))
        .orderBy(asc(this.messages.ts));
      const receiptRows: any[] = await db.select().from(settlements)
        .where(eq(settlements.sessionId, input.sessionId));
      const continuationRows: any[] = await db.select().from(this.continuations)
        .where(and(
          eq(this.continuations.sessionId, input.sessionId),
          eq(this.continuations.toolCallId, input.toolCallId),
        ))
        .limit(2);
      return this.clientToolResolutionFromRows(
        input,
        sessionRow,
        messageRows,
        receiptRows,
        continuationRows,
      );
    };
    if (this.transactionProvider) return this.transactionProvider(execute);
    if (typeof this.db.transaction !== "function") {
      throw new ClientToolSettlementError(
        "client_tool_settlement_unavailable",
        "Client-tool resolution requires transactional database support",
      );
    }
    return this.db.transaction(execute);
  }

  async settleClientTool(input: SettleClientToolInput): Promise<SettledClientTool> {
    const settlements = this.requireClientToolSettlements();
    const normalized = await normalizeClientToolSettlement(input);

    if (this.dialect === "sqlite") {
      if (typeof this.db.transaction !== "function") {
        throw new ClientToolSettlementError(
          "client_tool_settlement_unavailable",
          "Client-tool settlement requires transactional database support",
        );
      }
      return this.db.transaction((db: any) => {
        const sessionRow = db.select().from(this.sessions)
          .where(eq(this.sessions.id, input.sessionId))
          .limit(1)
          .all()[0];
        if (!sessionRow) {
          throw new ClientToolSettlementError("session_not_found", "Session not found");
        }
        assertClientToolSettlementScope(this.rowToSession(sessionRow, 0), input);

        const existingByKey = db.select().from(settlements).where(and(
          eq(settlements.sessionId, input.sessionId),
          eq(settlements.idempotencyKey, input.idempotencyKey),
        )).limit(1).all()[0];
        const continuationByKey = db.select().from(this.continuations).where(and(
          eq(this.continuations.sessionId, input.sessionId),
          eq(this.continuations.idempotencyKey, input.idempotencyKey),
        )).limit(1).all()[0];
        const existingByCall = db.select().from(settlements).where(and(
          eq(settlements.sessionId, input.sessionId),
          eq(settlements.toolCallId, input.toolCallId),
        )).limit(1).all()[0];
        const continuation = db.select().from(this.continuations).where(and(
          eq(this.continuations.sessionId, input.sessionId),
          eq(this.continuations.toolCallId, input.toolCallId),
        )).limit(2).all();
        if (continuation.length > 1) {
          throw new ClientToolSettlementError(
            "client_tool_settlement_corrupt",
            "Client tool call has ambiguous continuation state",
          );
        }
        if (existingByCall && continuation[0]) {
          throw new ClientToolSettlementError(
            "client_tool_settlement_corrupt",
            "Client tool call has both a settlement and an accepted continuation",
          );
        }
        if (continuationByKey) {
          if (continuationByKey.toolCallId === input.toolCallId) {
            throw new ClientToolSettlementError(
              "continuation_already_accepted",
              "A continuation was already accepted for this client tool call",
              this.rowToClientToolContinuation(continuationByKey),
            );
          }
          throw new ClientToolSettlementError(
            "idempotency_conflict",
            "Idempotency key was already used for a client-tool continuation",
          );
        }
        if (existingByKey) {
          const stored = this.rowToStoredClientToolSettlement(existingByKey);
          if (stored.fingerprint !== normalized.fingerprint) {
            throw new ClientToolSettlementError(
              "idempotency_conflict",
              "Idempotency key was already used for a different client-tool settlement",
            );
          }
          const messageRows = db.select().from(this.messages)
            .where(eq(this.messages.sessionId, input.sessionId))
            .orderBy(asc(this.messages.ts))
            .all();
          const receiptRows = db.select().from(settlements)
            .where(eq(settlements.sessionId, input.sessionId))
            .all();
          this.validateSettlementHistory(messageRows, receiptRows);
          return {
            status: "replay" as const,
            receipt: publicClientToolSettlementReceipt(stored),
          };
        }
        if (existingByCall) {
          const stored = this.rowToStoredClientToolSettlement(existingByCall);
          if (stored.fingerprint !== normalized.fingerprint) {
            throw new ClientToolSettlementError(
              "client_tool_settlement_conflict",
              "Client tool call was already settled with a different result",
            );
          }
          const messageRows = db.select().from(this.messages)
            .where(eq(this.messages.sessionId, input.sessionId))
            .orderBy(asc(this.messages.ts))
            .all();
          const receiptRows = db.select().from(settlements)
            .where(eq(settlements.sessionId, input.sessionId))
            .all();
          this.validateSettlementHistory(messageRows, receiptRows);
          return {
            status: "replay" as const,
            receipt: publicClientToolSettlementReceipt(stored),
          };
        }
        if (continuation[0]) {
          throw new ClientToolSettlementError(
            "continuation_already_accepted",
            "A continuation was already accepted for this client tool call",
            this.rowToClientToolContinuation(continuation[0]),
          );
        }

        if (Number(sessionRow.version ?? 0) !== input.expectedSessionVersion) {
          throw new ClientToolSettlementError(
            "session_version_conflict",
            "Session version does not match",
          );
        }

        const messageRows = db.select().from(this.messages)
          .where(eq(this.messages.sessionId, input.sessionId))
          .orderBy(asc(this.messages.ts))
          .all();
        const storedMessages = messageRows.map((row: any) => this.rowToMessage(row));
        const target = resolveClientToolSettlementTarget(storedMessages, input.toolCallId);
        const now = new Date().toISOString();
        const nextVersion = input.expectedSessionVersion + 1;
        const resultMessageId = nanoid();
        const receiptId = nanoid();
        const updatedSession = db.update(this.sessions).set({
          updatedAt: now,
          version: nextVersion,
        }).where(and(
          eq(this.sessions.id, input.sessionId),
          eq(this.sessions.version, input.expectedSessionVersion),
        )).run();
        if (extractAffectedRows(updatedSession) !== 1) {
          throw new ClientToolSettlementError(
            "session_version_conflict",
            "Session version changed while settling the client tool call",
          );
        }

        const terminalCalls = target.message.toolCalls!.map((call) =>
          call.id === input.toolCallId
            ? this.materializeSettledToolCall(call, input.outcome, normalized.content)
            : call
        );
        const updatedSource = db.update(this.messages).set({
          toolCalls: JSON.stringify(terminalCalls),
        }).where(and(
          eq(this.messages.id, target.message.id),
          eq(this.messages.sessionId, input.sessionId),
        )).run();
        if (extractAffectedRows(updatedSource) !== 1) {
          throw new ClientToolSettlementError(
            "client_tool_call_not_pending",
            "Client tool call changed while it was being settled",
          );
        }

        db.insert(this.messages).values({
          id: resultMessageId,
          sessionId: input.sessionId,
          role: "tool",
          content: normalized.content,
          ts: now,
          toolCalls: null,
          suggestions: null,
          toolCallId: input.toolCallId,
          reasoning: null,
          reasoningTruncated: false,
          turnId: target.message.turnId ?? null,
        }).run();
        db.insert(settlements).values({
          id: receiptId,
          sessionId: input.sessionId,
          idempotencyKey: input.idempotencyKey,
          fingerprint: normalized.fingerprint,
          toolCallId: input.toolCallId,
          sourceAssistantMessageId: target.message.id,
          resultMessageId,
          outcome: input.outcome,
          sessionVersion: nextVersion,
          settledAt: now,
        }).run();
        const stored: StoredClientToolSettlement = {
          id: receiptId,
          sessionId: input.sessionId,
          idempotencyKey: input.idempotencyKey,
          fingerprint: normalized.fingerprint,
          toolCallId: input.toolCallId,
          sourceAssistantMessageId: target.message.id,
          resultMessageId,
          outcome: input.outcome,
          sessionVersion: nextVersion,
          settledAt: now,
        };
        return {
          status: "settled" as const,
          receipt: publicClientToolSettlementReceipt(stored),
        };
      });
    }

    const execute = async (db: any): Promise<SettledClientTool> => {
      let sessionQuery = db.select().from(this.sessions)
        .where(eq(this.sessions.id, input.sessionId))
        .limit(1);
      if (typeof sessionQuery.for === "function") sessionQuery = sessionQuery.for("update");
      const sessionRows: any[] = await sessionQuery;
      const sessionRow = sessionRows[0];
      if (!sessionRow) {
        throw new ClientToolSettlementError("session_not_found", "Session not found");
      }
      assertClientToolSettlementScope(this.rowToSession(sessionRow, 0), input);

      const existingKeyRows: any[] = await db.select().from(settlements).where(and(
        eq(settlements.sessionId, input.sessionId),
        eq(settlements.idempotencyKey, input.idempotencyKey),
      )).limit(1);
      const continuationKeyRows: any[] = await db.select().from(this.continuations).where(and(
        eq(this.continuations.sessionId, input.sessionId),
        eq(this.continuations.idempotencyKey, input.idempotencyKey),
      )).limit(1);
      const existingCallRows: any[] = await db.select().from(settlements).where(and(
        eq(settlements.sessionId, input.sessionId),
        eq(settlements.toolCallId, input.toolCallId),
      )).limit(1);
      const continuationRows: any[] = await db.select().from(this.continuations).where(and(
        eq(this.continuations.sessionId, input.sessionId),
        eq(this.continuations.toolCallId, input.toolCallId),
      )).limit(2);
      if (continuationRows.length > 1) {
        throw new ClientToolSettlementError(
          "client_tool_settlement_corrupt",
          "Client tool call has ambiguous continuation state",
        );
      }
      if (existingCallRows[0] && continuationRows[0]) {
        throw new ClientToolSettlementError(
          "client_tool_settlement_corrupt",
          "Client tool call has both a settlement and an accepted continuation",
        );
      }
      if (continuationKeyRows[0]) {
        if (continuationKeyRows[0].toolCallId === input.toolCallId) {
          throw new ClientToolSettlementError(
            "continuation_already_accepted",
            "A continuation was already accepted for this client tool call",
            this.rowToClientToolContinuation(continuationKeyRows[0]),
          );
        }
        throw new ClientToolSettlementError(
          "idempotency_conflict",
          "Idempotency key was already used for a client-tool continuation",
        );
      }
      if (existingKeyRows[0]) {
        const stored = this.rowToStoredClientToolSettlement(existingKeyRows[0]);
        if (stored.fingerprint !== normalized.fingerprint) {
          throw new ClientToolSettlementError(
            "idempotency_conflict",
            "Idempotency key was already used for a different client-tool settlement",
          );
        }
        const messageRows: any[] = await db.select().from(this.messages)
          .where(eq(this.messages.sessionId, input.sessionId))
          .orderBy(asc(this.messages.ts));
        const receiptRows: any[] = await db.select().from(settlements)
          .where(eq(settlements.sessionId, input.sessionId));
        this.validateSettlementHistory(messageRows, receiptRows);
        return { status: "replay", receipt: publicClientToolSettlementReceipt(stored) };
      }
      if (existingCallRows[0]) {
        const stored = this.rowToStoredClientToolSettlement(existingCallRows[0]);
        if (stored.fingerprint !== normalized.fingerprint) {
          throw new ClientToolSettlementError(
            "client_tool_settlement_conflict",
            "Client tool call was already settled with a different result",
          );
        }
        const messageRows: any[] = await db.select().from(this.messages)
          .where(eq(this.messages.sessionId, input.sessionId))
          .orderBy(asc(this.messages.ts));
        const receiptRows: any[] = await db.select().from(settlements)
          .where(eq(settlements.sessionId, input.sessionId));
        this.validateSettlementHistory(messageRows, receiptRows);
        return { status: "replay", receipt: publicClientToolSettlementReceipt(stored) };
      }
      if (continuationRows[0]) {
        throw new ClientToolSettlementError(
          "continuation_already_accepted",
          "A continuation was already accepted for this client tool call",
          this.rowToClientToolContinuation(continuationRows[0]),
        );
      }

      if (Number(sessionRow.version ?? 0) !== input.expectedSessionVersion) {
        throw new ClientToolSettlementError(
          "session_version_conflict",
          "Session version does not match",
        );
      }

      const messageRows: any[] = await db.select().from(this.messages)
        .where(eq(this.messages.sessionId, input.sessionId))
        .orderBy(asc(this.messages.ts));
      const storedMessages = messageRows.map((row) => this.rowToMessage(row));
      const target = resolveClientToolSettlementTarget(storedMessages, input.toolCallId);
      const now = new Date().toISOString();
      const nextVersion = input.expectedSessionVersion + 1;
      const resultMessageId = nanoid();
      const receiptId = nanoid();
      const updatedSession = await db.update(this.sessions).set({
        updatedAt: now,
        version: nextVersion,
      }).where(and(
        eq(this.sessions.id, input.sessionId),
        eq(this.sessions.version, input.expectedSessionVersion),
      ));
      if (extractAffectedRows(updatedSession) !== 1) {
        throw new ClientToolSettlementError(
          "session_version_conflict",
          "Session version changed while settling the client tool call",
        );
      }

      const terminalCalls = target.message.toolCalls!.map((call) =>
        call.id === input.toolCallId
          ? this.materializeSettledToolCall(call, input.outcome, normalized.content)
          : call
      );
      const updatedSource = await db.update(this.messages).set({
        toolCalls: JSON.stringify(terminalCalls),
      }).where(and(
        eq(this.messages.id, target.message.id),
        eq(this.messages.sessionId, input.sessionId),
      ));
      if (extractAffectedRows(updatedSource) !== 1) {
        throw new ClientToolSettlementError(
          "client_tool_call_not_pending",
          "Client tool call changed while it was being settled",
        );
      }

      await db.insert(this.messages).values({
        id: resultMessageId,
        sessionId: input.sessionId,
        role: "tool",
        content: normalized.content,
        ts: now,
        toolCalls: null,
        suggestions: null,
        toolCallId: input.toolCallId,
        reasoning: null,
        reasoningTruncated: false,
        turnId: target.message.turnId ?? null,
      });
      await db.insert(settlements).values({
        id: receiptId,
        sessionId: input.sessionId,
        idempotencyKey: input.idempotencyKey,
        fingerprint: normalized.fingerprint,
        toolCallId: input.toolCallId,
        sourceAssistantMessageId: target.message.id,
        resultMessageId,
        outcome: input.outcome,
        sessionVersion: nextVersion,
        settledAt: now,
      });
      const stored: StoredClientToolSettlement = {
        id: receiptId,
        sessionId: input.sessionId,
        idempotencyKey: input.idempotencyKey,
        fingerprint: normalized.fingerprint,
        toolCallId: input.toolCallId,
        sourceAssistantMessageId: target.message.id,
        resultMessageId,
        outcome: input.outcome,
        sessionVersion: nextVersion,
        settledAt: now,
      };
      return { status: "settled", receipt: publicClientToolSettlementReceipt(stored) };
    };

    if (this.transactionProvider) return this.transactionProvider(execute);
    if (typeof this.db.transaction !== "function") {
      throw new ClientToolSettlementError(
        "client_tool_settlement_unavailable",
        "Client-tool settlement requires transactional database support",
      );
    }
    return this.db.transaction(execute);
  }

  async prepareContinuation(
    input: PrepareSessionContinuationInput,
  ): Promise<PreparedSessionContinuation> {
    if (this.dialect === "sqlite") {
      if (typeof this.db.transaction !== "function") {
        throw new Error("Session continuation requires transactional database support");
      }
      return this.db.transaction((db: any) => {
        const session = db.select().from(this.sessions)
          .where(eq(this.sessions.id, input.sessionId))
          .limit(1)
          .all()[0];
        if (!session) {
          throw new SessionContinuationError("session_not_found", "Session not found");
        }
        this.assertContinuationScope(session, input);

        const existing = db
          .select()
          .from(this.continuations)
          .where(and(
            eq(this.continuations.sessionId, input.sessionId),
            eq(this.continuations.idempotencyKey, input.idempotencyKey),
          ))
          .limit(1)
          .all()[0];
        if (existing) {
          if (existing.fingerprint !== input.fingerprint) {
            throw new SessionContinuationError(
              "idempotency_conflict",
              "Idempotency key was already used with a different continuation",
            );
          }
          const rows: any[] = db.select().from(this.messages)
            .where(eq(this.messages.sessionId, input.sessionId))
            .orderBy(asc(this.messages.ts))
            .all();
          const rawMessages = rows.map((row) => this.rowToMessage(row));
          const receiptRows = this.clientToolSettlements
            ? db.select().from(this.clientToolSettlements)
                .where(eq(this.clientToolSettlements.sessionId, input.sessionId))
                .all()
            : [];
          const messages = this.clientToolSettlements
            ? this.projectSessionMessages(
                rawMessages,
                receiptRows.map((row: any) => this.rowToStoredClientToolSettlement(row)),
              )
            : projectResolvedClientToolCalls(rawMessages);
          const turnId = this.continuationTurnId(messages, input.toolCallId);
          const requestClientTools = requestClientToolsForContinuation(
            rawMessages,
            input.toolCallId,
          );
          return {
            status: "replay" as const,
            sessionVersion: Number(existing.sessionVersion),
            runId: existing.runId,
            ...(turnId ? { turnId } : {}),
            ...(requestClientTools ? { requestClientTools } : {}),
            messages,
          };
        }

        if (this.clientToolSettlements) {
          const settlementByKey = db.select().from(this.clientToolSettlements).where(and(
            eq(this.clientToolSettlements.sessionId, input.sessionId),
            eq(this.clientToolSettlements.idempotencyKey, input.idempotencyKey),
          )).limit(1).all()[0];
          if (settlementByKey) {
            throw new SessionContinuationError(
              "idempotency_conflict",
              "Idempotency key was already used for a client-tool settlement",
            );
          }
          const settlement = db.select().from(this.clientToolSettlements).where(and(
            eq(this.clientToolSettlements.sessionId, input.sessionId),
            eq(this.clientToolSettlements.toolCallId, input.toolCallId),
          )).limit(1).all()[0];
          if (settlement) {
            throw new SessionContinuationError(
              "client_tool_call_not_pending",
              "Client tool call was already settled",
            );
          }
        }

        if (Number(session.version ?? 0) !== input.expectedSessionVersion) {
          throw new SessionContinuationError(
            "session_version_conflict",
            "Session version does not match",
          );
        }

        const rows: any[] = db.select().from(this.messages)
          .where(eq(this.messages.sessionId, input.sessionId))
          .orderBy(asc(this.messages.ts))
          .all();
        const storedMessages = rows.map((row) => this.rowToMessage(row));
        resolvePendingClientToolCall(
          projectResolvedClientToolCalls(storedMessages),
          input.toolCallId,
        );
        const turnId = this.continuationTurnId(storedMessages, input.toolCallId);
        const requestClientTools = requestClientToolsForContinuation(
          storedMessages,
          input.toolCallId,
        );

        const now = new Date().toISOString();
        const nextVersion = input.expectedSessionVersion + 1;
        const updated = db.update(this.sessions)
          .set({ updatedAt: now, version: nextVersion })
          .where(and(
            eq(this.sessions.id, input.sessionId),
            eq(this.sessions.version, input.expectedSessionVersion),
          ))
          .run();
        if (extractAffectedRows(updated) !== 1) {
          throw new SessionContinuationError(
            "session_version_conflict",
            "Session version changed while continuing",
          );
        }

        const message: Message = {
          id: nanoid(),
          role: "tool",
          content: input.result,
          ts: now,
          toolCallId: input.toolCallId,
          ...(turnId ? { turnId } : {}),
        };
        db.insert(this.messages).values({
          id: message.id,
          sessionId: input.sessionId,
          role: message.role,
          content: this.serializeContent(message.content),
          ts: message.ts,
          toolCalls: null,
          suggestions: null,
          toolCallId: message.toolCallId,
          turnId: message.turnId ?? null,
        }).run();
        db.insert(this.continuations).values({
          id: nanoid(),
          sessionId: input.sessionId,
          idempotencyKey: input.idempotencyKey,
          fingerprint: input.fingerprint,
          toolCallId: input.toolCallId,
          runId: input.runId,
          sessionVersion: nextVersion,
          createdAt: now,
        }).run();

        return {
          status: "prepared" as const,
          sessionVersion: nextVersion,
          runId: input.runId,
          ...(turnId ? { turnId } : {}),
          ...(requestClientTools ? { requestClientTools } : {}),
          messages: projectResolvedClientToolCalls([
            ...storedMessages,
            message,
          ]),
        };
      });
    }

    const execute = async (db: any): Promise<PreparedSessionContinuation> => {
      let sessionQuery = db.select().from(this.sessions)
        .where(eq(this.sessions.id, input.sessionId))
        .limit(1);
      if (typeof sessionQuery.for === "function") sessionQuery = sessionQuery.for("update");
      const sessionRows: any[] = await sessionQuery;
      const session = sessionRows[0];
      if (!session) {
        throw new SessionContinuationError("session_not_found", "Session not found");
      }
      this.assertContinuationScope(session, input);

      const existingRows: any[] = await db
        .select()
        .from(this.continuations)
        .where(and(
          eq(this.continuations.sessionId, input.sessionId),
          eq(this.continuations.idempotencyKey, input.idempotencyKey),
        ))
        .limit(1);
      const existing = existingRows[0];
      if (existing) {
        if (existing.fingerprint !== input.fingerprint) {
          throw new SessionContinuationError(
            "idempotency_conflict",
            "Idempotency key was already used with a different continuation",
          );
        }
        const rows: any[] = await db.select().from(this.messages)
          .where(eq(this.messages.sessionId, input.sessionId))
          .orderBy(asc(this.messages.ts));
        const rawMessages = rows.map((row) => this.rowToMessage(row));
        const receiptRows: any[] = this.clientToolSettlements
          ? await db.select().from(this.clientToolSettlements)
              .where(eq(this.clientToolSettlements.sessionId, input.sessionId))
          : [];
        const messages = this.clientToolSettlements
          ? this.projectSessionMessages(
              rawMessages,
              receiptRows.map((row) => this.rowToStoredClientToolSettlement(row)),
            )
          : projectResolvedClientToolCalls(rawMessages);
        const turnId = this.continuationTurnId(messages, input.toolCallId);
        const requestClientTools = requestClientToolsForContinuation(
          rawMessages,
          input.toolCallId,
        );
        return {
          status: "replay",
          sessionVersion: Number(existing.sessionVersion),
          runId: existing.runId,
          ...(turnId ? { turnId } : {}),
          ...(requestClientTools ? { requestClientTools } : {}),
          messages,
        };
      }

      if (this.clientToolSettlements) {
        const settlementKeyRows: any[] = await db.select().from(this.clientToolSettlements)
          .where(and(
            eq(this.clientToolSettlements.sessionId, input.sessionId),
            eq(this.clientToolSettlements.idempotencyKey, input.idempotencyKey),
          ))
          .limit(1);
        if (settlementKeyRows[0]) {
          throw new SessionContinuationError(
            "idempotency_conflict",
            "Idempotency key was already used for a client-tool settlement",
          );
        }
        const settlementRows: any[] = await db.select().from(this.clientToolSettlements)
          .where(and(
            eq(this.clientToolSettlements.sessionId, input.sessionId),
            eq(this.clientToolSettlements.toolCallId, input.toolCallId),
          ))
          .limit(1);
        if (settlementRows[0]) {
          throw new SessionContinuationError(
            "client_tool_call_not_pending",
            "Client tool call was already settled",
          );
        }
      }

      if (Number(session.version ?? 0) !== input.expectedSessionVersion) {
        throw new SessionContinuationError(
          "session_version_conflict",
          "Session version does not match",
        );
      }

      const rows: any[] = await db.select().from(this.messages)
        .where(eq(this.messages.sessionId, input.sessionId))
        .orderBy(asc(this.messages.ts));
      const storedMessages = rows.map((row) => this.rowToMessage(row));
      resolvePendingClientToolCall(
        projectResolvedClientToolCalls(storedMessages),
        input.toolCallId,
      );
      const turnId = this.continuationTurnId(storedMessages, input.toolCallId);
      const requestClientTools = requestClientToolsForContinuation(
        storedMessages,
        input.toolCallId,
      );

      const now = new Date().toISOString();
      const nextVersion = input.expectedSessionVersion + 1;
      const updated = await db.update(this.sessions)
        .set({
          updatedAt: now,
          version: nextVersion,
        })
        .where(and(
          eq(this.sessions.id, input.sessionId),
          eq(this.sessions.version, input.expectedSessionVersion),
        ));
      if (extractAffectedRows(updated) !== 1) {
        throw new SessionContinuationError(
          "session_version_conflict",
          "Session version changed while continuing",
        );
      }

      const message: Message = {
        id: nanoid(),
        role: "tool",
        content: input.result,
        ts: now,
        toolCallId: input.toolCallId,
        ...(turnId ? { turnId } : {}),
      };
      await db.insert(this.messages).values({
        id: message.id,
        sessionId: input.sessionId,
        role: message.role,
        content: this.serializeContent(message.content),
        ts: message.ts,
        toolCalls: null,
        suggestions: null,
        toolCallId: message.toolCallId,
        turnId: message.turnId ?? null,
      });
      await db.insert(this.continuations).values({
        id: nanoid(),
        sessionId: input.sessionId,
        idempotencyKey: input.idempotencyKey,
        fingerprint: input.fingerprint,
        toolCallId: input.toolCallId,
        runId: input.runId,
        sessionVersion: nextVersion,
        createdAt: now,
      });

      return {
        status: "prepared",
        sessionVersion: nextVersion,
        runId: input.runId,
        ...(turnId ? { turnId } : {}),
        ...(requestClientTools ? { requestClientTools } : {}),
        messages: projectResolvedClientToolCalls([
          ...storedMessages,
          message,
        ]),
      };
    };

    if (this.transactionProvider) {
      return this.transactionProvider(execute);
    }
    if (typeof this.db.transaction !== "function") {
      throw new Error("Session continuation requires transactional database support");
    }
    return this.db.transaction(execute);
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

  private assertContinuationScope(
    session: any,
    input: PrepareSessionContinuationInput,
  ): void {
    const storedScope = session.scopeKey
      ? { key: session.scopeKey, ...(session.scopeVersion ? { version: session.scopeVersion } : {}) }
      : undefined;
    if (
      (session.agent ?? undefined) !== input.agent
      || (session.user ?? undefined) !== input.user
      || JSON.stringify(storedScope) !== JSON.stringify(input.scope)
    ) {
      throw new SessionContinuationError(
        "continuation_scope_mismatch",
        "Continuation scope does not match the session",
      );
    }
  }

  async close(): Promise<void> {
    // Connection lifecycle managed externally
  }
}
