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
} from "@polpo-ai/core/session-store";
import { normalizeSessionCreateArgs } from "@polpo-ai/core/session-store";
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

export class DrizzleSessionStore implements SessionStore {
  constructor(
    private db: any,
    private sessions: AnyTable,
    private messages: AnyTable,
    private continuations: AnyTable,
    private dialect: Dialect,
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
    };
  }

  async updateMessage(
    sessionId: string,
    messageId: string,
    content: string | SessionContentPart[],
    toolCalls?: ToolCallInfo[],
    suggestions?: ChatSuggestion[],
  ): Promise<boolean> {
    const now = new Date().toISOString();
    const tcValue = toolCalls ? JSON.stringify(toolCalls) : null;
    const serialized = this.serializeContent(content);

    const result = await this.db.update(this.messages)
      .set({
        content: serialized,
        toolCalls: tcValue,
        suggestions: suggestions?.length ? JSON.stringify(suggestions) : null,
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
          return {
            status: "replay" as const,
            sessionVersion: Number(existing.sessionVersion),
            runId: existing.runId,
            messages: projectResolvedClientToolCalls(rows.map((row) => this.rowToMessage(row))),
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
        resolvePendingClientToolCall(
          projectResolvedClientToolCalls(rows.map((row) => this.rowToMessage(row))),
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
          messages: projectResolvedClientToolCalls([
            ...rows.map((row) => this.rowToMessage(row)),
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
        return {
          status: "replay",
          sessionVersion: Number(existing.sessionVersion),
          runId: existing.runId,
          messages: projectResolvedClientToolCalls(rows.map((row) => this.rowToMessage(row))),
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
      resolvePendingClientToolCall(
        projectResolvedClientToolCalls(rows.map((row) => this.rowToMessage(row))),
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
        messages: projectResolvedClientToolCalls([
          ...rows.map((row) => this.rowToMessage(row)),
          message,
        ]),
      };
    };

    if (typeof this.db.transaction !== "function") {
      throw new Error("Session continuation requires transactional database support");
    }
    return this.db.transaction(execute);
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
