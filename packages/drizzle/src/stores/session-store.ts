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
  resolvePendingClientToolCall,
  SessionContinuationError,
  type PreparedSessionContinuation,
  type PrepareSessionContinuationInput,
} from "@polpo-ai/core/session-continuation";
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
      id: row.id,
      title: row.title ?? undefined,
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

  async create(arg1?: string | SessionCreateOptions, arg2?: string): Promise<string> {
    const opts = normalizeSessionCreateArgs(arg1, arg2);
    const id = nanoid(10);
    const now = new Date().toISOString();
    await this.db.insert(this.sessions).values({
      id,
      title: opts.title ?? null,
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
    await this.db.insert(this.messages).values({
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
    });
    await this.db.update(this.sessions)
      .set({ updatedAt: ts, version: sql`${this.sessions.version} + 1` })
      .where(eq(this.sessions.id, sessionId));

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
    const serializedToolCalls = input.assistant.toolCalls?.length
      ? JSON.stringify(input.assistant.toolCalls)
      : null;
    const serializedSuggestions = input.assistant.suggestions?.length
      ? JSON.stringify(input.assistant.suggestions)
      : null;

    if (this.dialect === "sqlite") {
      if (typeof this.db.transaction !== "function") {
        throw new Error("Canonical turn persistence requires transactional database support");
      }
      return this.db.transaction((db: any) => {
        const existing = db.select().from(this.canonicalTurnOutbox)
          .where(eq(this.canonicalTurnOutbox.turnId, turn.turnId))
          .limit(1)
          .all()[0];
        if (existing) {
          this.assertSameCanonicalTurn(existing.event, serializedEvent);
          return { turn, created: false };
        }
        this.assertCanonicalTurnMessagesSync(db, turn);
        const updated = db.update(this.messages).set({
          content: serializedContent,
          toolCalls: serializedToolCalls,
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
      const existingRows = await db.select().from(this.canonicalTurnOutbox)
        .where(eq(this.canonicalTurnOutbox.turnId, turn.turnId))
        .limit(1);
      if (existingRows[0]) {
        this.assertSameCanonicalTurn(existingRows[0].event, serializedEvent);
        return { turn, created: false };
      }
      await this.assertCanonicalTurnMessages(db, turn);
      const updated = await db.update(this.messages).set({
        content: serializedContent,
        toolCalls: serializedToolCalls,
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

  async updateMessage(
    sessionId: string,
    messageId: string,
    content: string | SessionContentPart[],
    toolCalls?: ToolCallInfo[],
    suggestions?: ChatSuggestion[],
    reasoning?: PersistedReasoning,
  ): Promise<boolean> {
    const now = new Date().toISOString();
    const tcValue = toolCalls ? JSON.stringify(toolCalls) : null;
    const serialized = this.serializeContent(content);

    const result = await this.db.update(this.messages)
      .set({
        content: serialized,
        toolCalls: tcValue,
        suggestions: suggestions?.length ? JSON.stringify(suggestions) : null,
        reasoning: reasoning?.text ?? null,
        reasoningTruncated: reasoning?.truncated ?? false,
      })
      .where(eq(this.messages.id, messageId));

    const changed = extractAffectedRows(result) > 0;
    if (changed) {
      await this.db.update(this.sessions)
        .set({ updatedAt: now })
        .where(eq(this.sessions.id, sessionId));
    }
    return changed;
  }

  async getMessages(sessionId: string): Promise<Message[]> {
    const rows: any[] = await this.db.select().from(this.messages)
      .where(eq(this.messages.sessionId, sessionId))
      .orderBy(asc(this.messages.ts));
    return projectResolvedClientToolCalls(rows.map((r) => this.rowToMessage(r)));
  }

  async getRecentMessages(sessionId: string, limit: number): Promise<Message[]> {
    const rows: any[] = await this.db.select().from(this.messages)
      .where(eq(this.messages.sessionId, sessionId))
      .orderBy(desc(this.messages.ts))
      .limit(limit);
    return projectResolvedClientToolCalls(rows.reverse().map((r) => this.rowToMessage(r)));
  }

  async listSessions(filter?: SessionListFilter): Promise<Session[]> {
    let query = this.db
      .select({
        id: this.sessions.id,
        title: this.sessions.title,
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

  async renameSession(sessionId: string, title: string): Promise<boolean> {
    const now = new Date().toISOString();
    const result = await this.db.update(this.sessions)
      .set({ title, updatedAt: now })
      .where(eq(this.sessions.id, sessionId));
    return extractAffectedRows(result) > 0;
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
          const messages = rows.map((row) => this.rowToMessage(row));
          const turnId = this.continuationTurnId(messages, input.toolCallId);
          return {
            status: "replay" as const,
            sessionVersion: Number(existing.sessionVersion),
            runId: existing.runId,
            ...(turnId ? { turnId } : {}),
            messages: projectResolvedClientToolCalls(messages),
          };
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
          messages: projectResolvedClientToolCalls([
            ...storedMessages,
            message,
          ]),
        };
      });
    }

    const execute = async (db: any): Promise<PreparedSessionContinuation> => {
      const sessionRows: any[] = await db.select().from(this.sessions)
        .where(eq(this.sessions.id, input.sessionId))
        .limit(1);
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
        const messages = rows.map((row) => this.rowToMessage(row));
        const turnId = this.continuationTurnId(messages, input.toolCallId);
        return {
          status: "replay",
          sessionVersion: Number(existing.sessionVersion),
          runId: existing.runId,
          ...(turnId ? { turnId } : {}),
          messages: projectResolvedClientToolCalls(messages),
        };
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
