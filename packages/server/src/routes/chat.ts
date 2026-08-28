import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { RunRecord } from "@polpo-ai/core/run-store";
import type { ChatRouteDeps } from "../deps.js";

const TRANSIENT_SESSION_READ_CODES = new Set([
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);
const DEFAULT_SESSION_READ_HEDGE_AFTER_MS = 750;
const DEFAULT_SESSION_READ_RESPONSE_TIMEOUT_MS = 5_000;

type SessionHistoryReadPolicy = NonNullable<ChatRouteDeps["sessionHistoryReadPolicy"]>;

class SessionHistoryReadTimeoutError extends Error {
  readonly code = "SESSION_READ_DEADLINE_EXCEEDED";

  constructor(readonly elapsedMs: number) {
    super(`Session history read exceeded its ${elapsedMs}ms response deadline`);
    this.name = "TimeoutError";
  }
}

function positiveDuration(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : fallback;
}

function normalizedSessionHistoryReadPolicy(policy?: SessionHistoryReadPolicy) {
  return {
    hedgeAfterMs: positiveDuration(policy?.hedgeAfterMs, DEFAULT_SESSION_READ_HEDGE_AFTER_MS),
    responseTimeoutMs: positiveDuration(
      policy?.responseTimeoutMs,
      DEFAULT_SESSION_READ_RESPONSE_TIMEOUT_MS,
    ),
  };
}

function isTransientSessionReadError(error: unknown): boolean {
  const active = new Set<object>();
  const results = new Map<object, boolean>();
  const visit = (value: unknown): boolean => {
    if (!value || (typeof value !== "object" && typeof value !== "function")) {
      return false;
    }
    const objectValue = value as object;
    const previous = results.get(objectValue);
    if (previous !== undefined) return previous;
    if (active.has(objectValue)) return false;
    active.add(objectValue);
    const candidate = value as {
      cause?: unknown;
      code?: unknown;
      errors?: unknown;
      message?: unknown;
      name?: unknown;
      sourceError?: unknown;
    };
    const directMatch = candidate.name === "TimeoutError"
      || candidate.name === "AbortError"
      || (typeof candidate.code === "string" && TRANSIENT_SESSION_READ_CODES.has(candidate.code))
      || (
      typeof candidate.message === "string"
      && /(?:aborted due to timeout|request exceeded its \d+ms deadline)/i.test(candidate.message)
      );
    const result = directMatch
      || visit(candidate.cause)
      || visit(candidate.sourceError)
      || (
        Array.isArray(candidate.errors)
        && candidate.errors.length > 0
        && candidate.errors.every(visit)
      );
    active.delete(objectValue);
    results.set(objectValue, result);
    return result;
  };
  return visit(error);
}

function hedgedSessionRead<T>(operation: () => Promise<T>, hedgeAfterMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let attemptsStarted = 0;
    let settled = false;
    const failures: unknown[] = [];
    let hedgeTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (hedgeTimer) clearTimeout(hedgeTimer);
      callback();
    };

    const startAttempt = () => {
      if (settled || attemptsStarted >= 2) return;
      attemptsStarted += 1;
      let attempt: Promise<T>;
      try {
        attempt = operation();
      } catch (error) {
        attempt = Promise.reject(error);
      }
      attempt.then(
        (value) => finish(() => resolve(value)),
        (error) => {
          if (settled) return;
          if (!isTransientSessionReadError(error)) {
            finish(() => reject(error));
            return;
          }
          failures.push(error);
          if (attemptsStarted === 1) {
            startAttempt();
            return;
          }
          if (failures.length === attemptsStarted) {
            finish(() => reject(new AggregateError(
              failures,
              "Session history read failed after two transient attempts",
            )));
          }
        },
      );
    };

    startAttempt();
    if (!settled && attemptsStarted < 2) {
      hedgeTimer = setTimeout(startAttempt, hedgeAfterMs);
    }
  });
}

async function withSessionReadResponseDeadline<T>(
  operation: Promise<T>,
  responseTimeoutMs: number,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new SessionHistoryReadTimeoutError(responseTimeoutMs)),
          responseTimeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/* ── Route definitions ─────────────────────────────────────────────── */

const listSessionsRoute = createRoute({
  method: "get",
  path: "/sessions",
  tags: ["Chat Sessions"],
  summary: "List chat sessions",
  request: {
    query: z.object({
      user: z.string().optional().openapi({
        description:
          "Filter to sessions whose `user` field matches exactly. Equality only.",
      }),
    }).passthrough().openapi({
      description:
        "Optional filters. Use `user=<id>` to scope to one end-user. Metadata filters: pass `metadata.<key>=<value>` (e.g. `metadata.tenant=acme`) — multiple keys ANDed together.",
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "List of sessions",
    },
  },
});

const getSessionMessagesRoute = createRoute({
  method: "get",
  path: "/sessions/{id}/messages",
  tags: ["Chat Sessions"],
  summary: "Get session messages",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "Session messages",
    },
    404: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
      description: "Session not found",
    },
    503: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
      description: "Session store not available",
    },
  },
});

const getSessionActivityRoute = createRoute({
  method: "get",
  path: "/sessions/{id}/activity",
  tags: ["Chat Sessions"],
  summary: "Get session messages and correlated runs",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "Session transcript and technical run traces",
    },
    404: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
      description: "Session not found",
    },
    503: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
      description: "Session store not available",
    },
  },
});

const renameSessionRoute = createRoute({
  method: "patch",
  path: "/sessions/{id}",
  tags: ["Chat Sessions"],
  summary: "Rename session",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: { "application/json": { schema: z.object({ title: z.string().min(1) }) } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "Session renamed",
    },
    404: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
      description: "Session not found",
    },
    503: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
      description: "Session store not available",
    },
  },
});

const deleteSessionRoute = createRoute({
  method: "delete",
  path: "/sessions/{id}",
  tags: ["Chat Sessions"],
  summary: "Delete session",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "Session deleted",
    },
    404: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
      description: "Session not found",
    },
    503: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
      description: "Session store not available",
    },
  },
});

/* ── Handlers ──────────────────────────────────────────────────────── */

/**
 * Chat session management routes.
 * Conversational AI is handled by /v1/chat/completions (see completions.ts).
 */
export function chatRoutes(getDeps: () => ChatRouteDeps): OpenAPIHono {
  const app = new OpenAPIHono();
  const inFlightSessionHistory = new WeakMap<object, Map<string, Promise<{
    messages: any[];
    session: any;
  }>>>();

  const readSessionHistory = (
    sessionStore: NonNullable<ChatRouteDeps["sessionStore"]>,
    sessionId: string,
    policy?: SessionHistoryReadPolicy,
  ) => {
    const normalizedPolicy = normalizedSessionHistoryReadPolicy(policy);
    let storeReads = inFlightSessionHistory.get(sessionStore);
    if (!storeReads) {
      storeReads = new Map();
      inFlightSessionHistory.set(sessionStore, storeReads);
    }
    const current = storeReads.get(sessionId);
    if (current) {
      return current;
    }

    const read = withSessionReadResponseDeadline(
      hedgedSessionRead(async () => {
        const [session, messages] = await Promise.all([
          sessionStore.getSession(sessionId),
          sessionStore.getMessages(sessionId),
        ]);
        return { messages, session };
      }, normalizedPolicy.hedgeAfterMs),
      normalizedPolicy.responseTimeoutMs,
    );
    const tracked = read.finally(() => {
      if (storeReads.get(sessionId) === tracked) {
        storeReads.delete(sessionId);
      }
    });
    storeReads.set(sessionId, tracked);
    return tracked;
  };

  const safeSessionMessages = (messages: any[]) => messages.map((m: any) => {
    const toolCalls = Array.isArray(m.toolCalls) ? m.toolCalls : undefined;
    if (!toolCalls || toolCalls.length === 0) return m;
    const hasVault = toolCalls.some((tc: any) => tc.name === "set_vault_entry" || tc.name === "update_vault_credentials");
    if (!hasVault) return m;
    return {
      ...m,
      toolCalls: toolCalls.map((tc: any) => {
        if ((tc.name !== "set_vault_entry" && tc.name !== "update_vault_credentials") || !tc.arguments) return tc;
        const args = { ...tc.arguments };
        if (args.credentials && typeof args.credentials === "object") {
          const redacted: Record<string, string> = {};
          for (const key of Object.keys(args.credentials as Record<string, string>)) {
            redacted[key] = "[REDACTED]";
          }
          args.credentials = redacted;
        }
        return { ...tc, arguments: args };
      }),
    };
  });

  const safeSessionRuns = (runs: RunRecord[]) => runs.map((run) => ({
    id: run.id,
    taskId: run.taskId,
    agentName: run.agentName,
    sessionId: run.sessionId,
    status: run.status,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
    executionMode: run.executionMode,
    engine: run.engine,
    delivery: run.delivery,
    trace: Array.isArray(run.trace) ? run.trace : [],
    ...(run.result
      ? {
          result: {
            exitCode: run.result.exitCode,
            stderr: run.result.stderr,
            duration: run.result.duration,
          },
        }
      : {}),
  }));

  // GET /chat/sessions — list chat sessions, optionally filtered.
  //
  // Query string accepts:
  //   - user=<id>            → equality filter on Session.user
  //   - metadata.<key>=<val> → equality filter on Session.metadata[key]
  //                            multiple metadata.* keys are ANDed together
  app.openapi(listSessionsRoute, async (c) => {
    const { sessionStore } = getDeps();
    if (!sessionStore) {
      return c.json({ ok: true, data: { sessions: [] } });
    }

    // Build filter from query string. Hono's typed query object only knows
    // about declared params (`user`); metadata.* keys come in via raw URL.
    const query = c.req.query();
    const filter: { user?: string; metadata?: Record<string, string> } = {};
    if (query.user) filter.user = query.user;
    for (const [k, v] of Object.entries(query)) {
      if (k.startsWith("metadata.") && v) {
        filter.metadata ??= {};
        filter.metadata[k.slice("metadata.".length)] = v;
      }
    }

    const sessions = await sessionStore.listSessions(
      Object.keys(filter).length > 0 ? filter : undefined,
    );
    return c.json({ ok: true, data: { sessions } });
  });

  // GET /chat/sessions/:id/messages — get messages for a session
  app.openapi(getSessionMessagesRoute, async (c) => {
    const { sessionHistoryReadPolicy, sessionStore } = getDeps();
    if (!sessionStore) {
      return c.json({ ok: false, error: "Session store not available", code: "NOT_AVAILABLE" }, 503);
    }
    const { id } = c.req.valid("param");
    let session: any;
    let messages: any[];
    try {
      ({ messages, session } = await readSessionHistory(
        sessionStore,
        id,
        sessionHistoryReadPolicy,
      ));
    } catch (error) {
      if (!isTransientSessionReadError(error)) throw error;
      console.warn("[chat] session history temporarily unavailable", {
        errorName: error instanceof Error ? error.name : "UnknownError",
        sessionId: id,
      });
      c.header("Retry-After", "1");
      return c.json({
        ok: false,
        error: "Session history is temporarily unavailable",
        code: "SESSION_STORE_TEMPORARILY_UNAVAILABLE",
      }, 503);
    }
    if (!session) {
      return c.json({ ok: false, error: "Session not found", code: "NOT_FOUND" }, 404);
    }
    // SECURITY: Redact vault credentials from persisted tool calls before serving to client
    const safeMessages = safeSessionMessages(messages);
    return c.json({ ok: true, data: { session, messages: safeMessages } }, 200);
  });

  app.openapi(getSessionActivityRoute, async (c) => {
    const { sessionHistoryReadPolicy, sessionStore, runStore } = getDeps();
    if (!sessionStore) {
      return c.json({ ok: false, error: "Session store not available", code: "NOT_AVAILABLE" }, 503);
    }
    const { id } = c.req.valid("param");
    let session: any;
    let messages: any[];
    try {
      ({ messages, session } = await readSessionHistory(
        sessionStore,
        id,
        sessionHistoryReadPolicy,
      ));
    } catch (error) {
      if (!isTransientSessionReadError(error)) throw error;
      console.warn("[chat] session activity temporarily unavailable", {
        errorName: error instanceof Error ? error.name : "UnknownError",
        sessionId: id,
      });
      c.header("Retry-After", "1");
      return c.json({
        ok: false,
        error: "Session activity is temporarily unavailable",
        code: "SESSION_STORE_TEMPORARILY_UNAVAILABLE",
      }, 503);
    }
    if (!session) {
      return c.json({ ok: false, error: "Session not found", code: "NOT_FOUND" }, 404);
    }
    const runs = await (runStore?.getRunsBySessionId?.(id) ?? Promise.resolve([]));
    return c.json({
      ok: true,
      data: { session, messages: safeSessionMessages(messages), runs: safeSessionRuns(runs) },
    }, 200);
  });

  // PATCH /chat/sessions/:id — rename a session
  app.openapi(renameSessionRoute, async (c) => {
    const { sessionStore } = getDeps();
    if (!sessionStore) {
      return c.json({ ok: false, error: "Session store not available", code: "NOT_AVAILABLE" }, 503);
    }
    const { id } = c.req.valid("param");
    const { title } = c.req.valid("json");
    const renamed = await sessionStore.renameSession(id, title);
    if (!renamed) {
      return c.json({ ok: false, error: "Session not found", code: "NOT_FOUND" }, 404);
    }
    return c.json({ ok: true, data: { renamed: true } }, 200);
  });

  // DELETE /chat/sessions/:id — delete a session
  app.openapi(deleteSessionRoute, async (c) => {
    const { sessionStore } = getDeps();
    if (!sessionStore) {
      return c.json({ ok: false, error: "Session store not available", code: "NOT_AVAILABLE" }, 503);
    }
    const { id } = c.req.valid("param");
    const deleted = await sessionStore.deleteSession(id);
    if (!deleted) {
      return c.json({ ok: false, error: "Session not found", code: "NOT_FOUND" }, 404);
    }
    return c.json({ ok: true, data: { deleted: true } }, 200);
  });

  // POST /sessions/import — bulk import a session with messages
  app.post("/sessions/import", async (c) => {
    const { sessionStore } = getDeps();
    if (!sessionStore) {
      return c.json({ ok: false, error: "Sessions not available", code: "NOT_AVAILABLE" }, 501);
    }

    const body = await c.req.json<{
      title?: string;
      agent?: string;
      messages: Array<{
        role: "user" | "assistant";
        content: string;
        toolCalls?: unknown[];
      }>;
    }>();

    if (!body.messages || !Array.isArray(body.messages)) {
      return c.json({ ok: false, error: "messages array required" }, 400);
    }

    const sessionId = await sessionStore.create({
      ...(body.title ? { title: body.title } : {}),
      ...(body.agent ? { agent: body.agent } : {}),
    });
    let imported = 0;

    for (const msg of body.messages) {
      const added = await sessionStore.addMessage(sessionId, msg.role, msg.content);
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        await sessionStore.updateMessage(sessionId, added.id, msg.content, msg.toolCalls as any);
      }
      imported++;
    }

    return c.json({ ok: true, data: { sessionId, imported } }, 201);
  });

  return app;
}
