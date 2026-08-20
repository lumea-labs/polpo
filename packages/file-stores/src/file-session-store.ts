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
import { join } from "node:path";
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
import type { ChatSuggestion } from "@polpo-ai/core/chat-interactions";
import {
  projectResolvedClientToolCalls,
  resolvePendingClientToolCall,
  SessionContinuationError,
  type PreparedSessionContinuation,
  type PrepareSessionContinuationInput,
} from "@polpo-ai/core/session-continuation";

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

  constructor(polpoDir: string) {
    this.sessionsDir = join(polpoDir, "sessions");
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
    };
    await this.withSessionLock(sessionId, () => {
      try {
        const state = this.readSessionFile(sessionId);
        state.header.version = Number(state.header.version ?? 0) + 1;
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
  ): Promise<boolean> {
    const file = this.sessionFile(sessionId);
    if (!existsSync(file)) return false;
    try {
      const raw = readFileSync(file, "utf-8");
      const lines = raw.split("\n").filter(Boolean);
      let found = false;
      const updated = lines.map((line) => {
        const obj = JSON.parse(line);
        if (!obj._session && obj.id === messageId) {
          found = true;
          const patched: Record<string, unknown> = { ...obj, content };
          if (toolCalls && toolCalls.length > 0) {
            patched.toolCalls = toolCalls;
          }
          if (suggestions && suggestions.length > 0) {
            patched.suggestions = suggestions;
          }
          return JSON.stringify(patched);
        }
        return line;
      });
      if (!found) return false;
      writeFileSync(file, updated.join("\n") + "\n", "utf-8");
      return true;
    } catch {
      return false;
    }
  }

  async getMessages(sessionId: string): Promise<Message[]> {
    const file = this.sessionFile(sessionId);
    if (!existsSync(file)) return [];
    try {
      const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
      const messages: Message[] = [];
      for (const line of lines) {
        const obj = JSON.parse(line);
        // Skip session header
        if (obj._session) continue;
        messages.push(obj as Message);
      }
      return projectResolvedClientToolCalls(messages);
    } catch { /* unreadable session file */
      return [];
    }
  }

  async getRecentMessages(sessionId: string, limit: number): Promise<Message[]> {
    const messages = await this.getMessages(sessionId);
    return messages.slice(-limit);
  }

  /** Build a Session out of a session file's first line + mtime. */
  private headerToSession(header: any, filePath: string, fallbackId: string): Session {
    const updatedAt = new Date(statSync(filePath).mtimeMs).toISOString();
    return {
      id: header.id ?? fallbackId,
      title: header.title,
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
      const existing = continuations[input.idempotencyKey];
      if (existing) {
        if (existing.fingerprint !== input.fingerprint) {
          throw new SessionContinuationError(
            "idempotency_conflict",
            "Idempotency key was already used with a different continuation",
          );
        }
        return {
          status: "replay",
          sessionVersion: existing.sessionVersion,
          runId: existing.runId,
          messages: projectResolvedClientToolCalls(state.messages),
        };
      }

      if (Number(state.header.version ?? 0) !== input.expectedSessionVersion) {
        throw new SessionContinuationError(
          "session_version_conflict",
          "Session version does not match",
        );
      }
      resolvePendingClientToolCall(
        projectResolvedClientToolCalls(state.messages),
        input.toolCallId,
      );

      const nextVersion = input.expectedSessionVersion + 1;
      const message: Message = {
        id: nanoid(10),
        role: "tool",
        content: input.result,
        ts: new Date().toISOString(),
        toolCallId: input.toolCallId,
      };
      state.header.version = nextVersion;
      state.header.continuations = {
        ...continuations,
        [input.idempotencyKey]: {
          fingerprint: input.fingerprint,
          toolCallId: input.toolCallId,
          runId: input.runId,
          sessionVersion: nextVersion,
        },
      };
      state.messages.push(message);
      this.writeSessionFileAtomic(input.sessionId, state.header, state.messages);

      return {
        status: "prepared",
        sessionVersion: nextVersion,
        runId: input.runId,
        messages: projectResolvedClientToolCalls(state.messages),
      };
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
    return sessions;
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

  async renameSession(sessionId: string, title: string): Promise<boolean> {
    const file = this.sessionFile(sessionId);
    if (!existsSync(file)) return false;
    try {
      const raw = readFileSync(file, "utf-8");
      const lines = raw.split("\n").filter(Boolean);
      if (lines.length === 0) return false;
      const header = JSON.parse(lines[0]);
      if (!header._session) return false;
      header.title = title;
      lines[0] = JSON.stringify(header);
      writeFileSync(file, lines.join("\n") + "\n", "utf-8");
      return true;
    } catch {
      return false;
    }
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const file = this.sessionFile(sessionId);
    if (!existsSync(file)) return false;
    try {
      unlinkSync(file);
      return true;
    } catch { /* file already removed */
      return false;
    }
  }

  async prune(keepSessions: number): Promise<number> {
    const sessions = await this.listSessions();
    if (sessions.length <= keepSessions) return 0;
    const toRemove = sessions.slice(keepSessions);
    let removed = 0;
    for (const s of toRemove) {
      try {
        unlinkSync(this.sessionFile(s.id));
        removed++;
      } catch { /* file already removed */ }
    }
    return removed;
  }

  async close(): Promise<void> {
    // No resources to release for file-based store
  }

  private sessionFile(sessionId: string): string {
    return join(this.sessionsDir, `${sessionId}.jsonl`);
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

  private writeSessionFileAtomic(sessionId: string, header: any, messages: Message[]): void {
    const file = this.sessionFile(sessionId);
    const temporary = `${file}.${process.pid}.${nanoid(6)}.tmp`;
    const content = [header, ...messages].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    writeFileSync(temporary, content, "utf-8");
    renameSync(temporary, file);
  }

  private async withSessionLock<T>(sessionId: string, operation: () => T | Promise<T>): Promise<T> {
    const key = this.sessionFile(sessionId);
    const previous = FileSessionStore.sessionLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    FileSessionStore.sessionLocks.set(key, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (FileSessionStore.sessionLocks.get(key) === current) {
        FileSessionStore.sessionLocks.delete(key);
      }
    }
  }
}
