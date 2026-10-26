import { manualSessionTitleState, sessionTitleSnapshot } from "@polpo-ai/core/session-titles";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import type { RunRecord } from "@polpo-ai/core/run-store";
import {
  ClientToolSettlementError,
  MAX_CLIENT_TOOL_SETTLEMENT_CONTENT_BYTES,
  MAX_CLIENT_TOOL_SETTLEMENT_REASON_BYTES,
  MAX_CLIENT_TOOL_SETTLEMENT_RESULT_BYTES,
  type ClientToolResolution,
  type SettleClientToolInput,
} from "@polpo-ai/core/session-client-tool-settlement";
import type {
  ChatRouteDeps,
  ClientToolContinuationRunStatus,
} from "../deps.js";

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
const CLIENT_TOOL_SETTLEMENT_REQUEST_METADATA_BYTES = 16 * 1024;

type SessionHistoryReadPolicy = NonNullable<ChatRouteDeps["sessionHistoryReadPolicy"]>;

const clientToolParamsSchema = z.object({
  id: z.string().min(1).max(256),
  toolCallId: z.string().min(1).max(256),
});

const clientToolIdentitySchema = z.object({
  agent: z.string().min(1).max(1024).optional(),
  user: z.string().min(1).max(1024).optional(),
}).strict();

const clientToolSettlementBodySchema = z.discriminatedUnion("outcome", [
  clientToolIdentitySchema.extend({
    expectedSessionVersion: z.number().int().nonnegative(),
    outcome: z.literal("success"),
    result: z.string(),
  }).strict(),
  clientToolIdentitySchema.extend({
    expectedSessionVersion: z.number().int().nonnegative(),
    outcome: z.literal("failed"),
    result: z.string().optional(),
    reason: z.string().optional(),
  }).strict(),
  clientToolIdentitySchema.extend({
    expectedSessionVersion: z.number().int().nonnegative(),
    outcome: z.literal("cancelled"),
    result: z.string().optional(),
    reason: z.string().optional(),
  }).strict(),
]);

const clientToolErrorSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
  code: z.string(),
  data: z.any().optional(),
});

const clientToolSettlementReceiptSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  toolCallId: z.string(),
  sourceAssistantMessageId: z.string(),
  resultMessageId: z.string(),
  outcome: z.enum(["success", "failed", "cancelled"]),
  sessionVersion: z.number().int().nonnegative(),
  settledAt: z.string(),
});

const clientToolContinuationReceiptSchema = z.object({
  sessionId: z.string(),
  toolCallId: z.string(),
  runId: z.string(),
  sessionVersion: z.number().int().nonnegative(),
  acceptedAt: z.string().optional(),
});

const clientToolResolutionSchema = z.discriminatedUnion("status", [
  z.object({
    sessionId: z.string(),
    toolCallId: z.string(),
    sessionVersion: z.number().int().nonnegative(),
    status: z.literal("pending"),
    continuationAccepted: z.literal(false),
  }),
  z.object({
    sessionId: z.string(),
    toolCallId: z.string(),
    sessionVersion: z.number().int().nonnegative(),
    status: z.literal("settled"),
    continuationAccepted: z.literal(false),
    receipt: clientToolSettlementReceiptSchema,
  }),
  z.object({
    sessionId: z.string(),
    toolCallId: z.string(),
    sessionVersion: z.number().int().nonnegative(),
    status: z.literal("continuation"),
    continuationAccepted: z.literal(true),
    receipt: clientToolContinuationReceiptSchema,
    runStatus: z.enum(["accepted", "running", "completed", "failed", "cancelled", "unknown"]),
  }),
]);

const settledClientToolSchema = z.object({
  status: z.enum(["settled", "replay"]),
  receipt: clientToolSettlementReceiptSchema,
});

const clientToolSettlementBodyLimit: MiddlewareHandler = async (c, next) => {
  const maxSize = MAX_CLIENT_TOOL_SETTLEMENT_CONTENT_BYTES
    + CLIENT_TOOL_SETTLEMENT_REQUEST_METADATA_BYTES;
  const body = c.req.raw.body;
  if (!body) return next();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxSize) {
        await reader.cancel("Client-tool settlement request is too large");
        return c.json({
          ok: false,
          error: "Client-tool settlement request is too large",
          code: "invalid_client_tool_settlement",
        }, 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const buffered = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    buffered.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const headers = new Headers(c.req.raw.headers);
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  c.req.raw = new Request(c.req.raw, {
    body: buffered,
    headers,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  return next();
};

const getClientToolResolutionRoute = createRoute({
  method: "get",
  path: "/sessions/{id}/tool-calls/{toolCallId}",
  tags: ["Chat Sessions"],
  summary: "Inspect a client-side tool call resolution",
  description: "Reads whether a frozen client-side tool call is still pending, was settled without execution, or already accepted a continuation. This endpoint never invokes a model, handler, tool, or Loop.",
  request: {
    params: clientToolParamsSchema,
    query: clientToolIdentitySchema,
  },
  responses: {
    200: { content: { "application/json": { schema: z.object({ ok: z.literal(true), data: clientToolResolutionSchema }) } }, description: "Current durable resolution" },
    400: { content: { "application/json": { schema: clientToolErrorSchema } }, description: "Invalid request" },
    401: { content: { "application/json": { schema: clientToolErrorSchema } }, description: "Invalid API key" },
    403: { content: { "application/json": { schema: clientToolErrorSchema } }, description: "Session identity or scope mismatch" },
    404: { content: { "application/json": { schema: clientToolErrorSchema } }, description: "Session or client tool call not found" },
    409: { content: { "application/json": { schema: clientToolErrorSchema } }, description: "Stored client tool state is ambiguous or corrupt" },
    501: { content: { "application/json": { schema: clientToolErrorSchema } }, description: "The Session store does not support client-tool resolution" },
  },
});

const settleClientToolRoute = createRoute({
  method: "put",
  path: "/sessions/{id}/tool-calls/{toolCallId}/settlement",
  middleware: clientToolSettlementBodyLimit,
  tags: ["Chat Sessions"],
  summary: "Settle a client-side tool call without continuing the agent",
  description: "Atomically closes a never-accepted client-side tool call. It writes canonical history but never invokes a model, handler, tool, or Loop. Exact idempotent replays return the original receipt.",
  request: {
    params: clientToolParamsSchema,
    headers: z.object({
      "idempotency-key": z.string().trim().min(1).max(256),
    }),
    body: { content: { "application/json": { schema: clientToolSettlementBodySchema } } },
  },
  responses: {
    200: { content: { "application/json": { schema: z.object({ ok: z.literal(true), data: settledClientToolSchema }) } }, description: "Settlement receipt or exact replay" },
    400: { content: { "application/json": { schema: clientToolErrorSchema } }, description: "Invalid request or result exceeds the UTF-8 byte limit" },
    401: { content: { "application/json": { schema: clientToolErrorSchema } }, description: "Invalid API key" },
    403: { content: { "application/json": { schema: clientToolErrorSchema } }, description: "Write denied, or session identity/scope mismatch" },
    404: { content: { "application/json": { schema: clientToolErrorSchema } }, description: "Session or client tool call not found" },
    409: { content: { "application/json": { schema: clientToolErrorSchema } }, description: "Continuation already accepted, stale version, or conflicting replay" },
    413: { content: { "application/json": { schema: clientToolErrorSchema } }, description: "Settlement request body exceeds the bounded envelope" },
    501: { content: { "application/json": { schema: clientToolErrorSchema } }, description: "Settlement is disabled or unsupported by the Session store" },
  },
});

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

const getSessionMetadataRoute = createRoute({
  ...getSessionMessagesRoute,
  path: "/sessions/{id}",
  summary: "Get session metadata without loading messages",
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
      content: { "application/json": { schema: z.object({ title: z.string().min(1), expectedTitleRevision: z.number().int().nonnegative().optional() }) } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "Session renamed",
    },
    409: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string(), titleRevision: z.number().optional() }) } },
      description: "Title revision conflict",
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

function clientToolSettlementHttpStatus(
  code: ClientToolSettlementError["code"],
): 400 | 403 | 404 | 409 | 501 {
  switch (code) {
    case "invalid_client_tool_settlement":
      return 400;
    case "client_tool_settlement_scope_mismatch":
      return 403;
    case "session_not_found":
    case "client_tool_call_not_found":
      return 404;
    case "client_tool_settlement_unavailable":
      return 501;
    default:
      return 409;
  }
}

function publicClientToolSettlementError(
  c: any,
  error: ClientToolSettlementError,
  identity?: { agent?: string; user?: string },
) {
  const status = clientToolSettlementHttpStatus(error.code);
  if (error.code === "continuation_already_accepted" && error.continuation) {
    const { sessionId, toolCallId, sessionVersion } = error.continuation;
    const params = new URLSearchParams();
    if (identity?.agent !== undefined) params.set("agent", identity.agent);
    if (identity?.user !== undefined) params.set("user", identity.user);
    const query = params.size > 0 ? `?${params.toString()}` : "";
    // Relative to `.../{toolCallId}/settlement`, so explicit environment
    // prefixes survive hosts that internally rewrite the request path.
    c.header("Location", `../${encodeURIComponent(toolCallId)}${query}`);
    return c.json({
      ok: false,
      error: error.message,
      code: error.code,
      data: {
        sessionId,
        toolCallId,
        sessionVersion,
        status: "continuation",
        continuationAccepted: true,
        receipt: error.continuation,
        runStatus: "unknown",
      },
    }, status);
  }
  return c.json({ ok: false, error: error.message, code: error.code }, status);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

async function enrichClientToolResolution(
  resolution: ClientToolResolution,
  deps: ChatRouteDeps,
  requestContext: unknown,
): Promise<ClientToolResolution & { runStatus?: ClientToolContinuationRunStatus }> {
  if (resolution.status !== "continuation") return resolution;
  let runStatus: ClientToolContinuationRunStatus = "unknown";
  try {
    if (deps.resolveClientToolContinuationRunStatus) {
      runStatus = await deps.resolveClientToolContinuationRunStatus({
        sessionId: resolution.sessionId,
        toolCallId: resolution.toolCallId,
        runId: resolution.receipt.runId,
        requestContext,
      }) ?? "unknown";
    } else if (deps.runStore) {
      const run = await deps.runStore.getRun(resolution.receipt.runId);
      if (run) {
        runStatus = run.status === "killed" ? "cancelled" : run.status;
      }
    }
  } catch {
    // The accepted continuation receipt is authoritative. Observability is
    // intentionally fail-open and must never rewrite it as pending.
    runStatus = "unknown";
  }
  return { ...resolution, runStatus };
}

/**
 * Public Session client-tool resolution routes. Kept separate from the
 * control-plane chat routes so hosts can mount only this surface at /v1/chat
 * with its own API-key boundary.
 */
export function clientToolResolutionRoutes(
  getDeps: () => ChatRouteDeps,
  apiKeys?: string[],
): OpenAPIHono {
  const app = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (result.success) return;
      return c.json({
        ok: false as const,
        error: "Invalid client-tool settlement request",
        code: "invalid_client_tool_settlement" as const,
      }, 400);
    },
  });

  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });

  if (apiKeys && apiKeys.length > 0) {
    app.use("*", async (c, next) => {
      const authorization = c.req.header("authorization");
      const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
      const key = bearer || c.req.header("x-api-key")?.trim();
      if (!key || !apiKeys.includes(key)) {
        return c.json({
          ok: false,
          error: "Invalid API key",
          code: "invalid_api_key",
        }, 401);
      }
      await next();
    });
  }

  app.openapi(getClientToolResolutionRoute, async (c: any) => {
    const deps = getDeps();
    if (!deps.sessionStore?.getClientToolResolution) {
      return c.json({
        ok: false,
        error: "Client-tool resolution is not supported by this Session store",
        code: "client_tool_settlement_unavailable",
      }, 501);
    }
    const { id: sessionId, toolCallId } = c.req.valid("param");
    const { agent, user } = c.req.valid("query");
    try {
      const scope = await deps.resolveClientToolResolutionScope?.(c);
      const resolution = await deps.sessionStore.getClientToolResolution({
        sessionId,
        toolCallId,
        agent,
        user,
        ...(scope ? { scope } : {}),
      });
      return c.json({
        ok: true,
        data: await enrichClientToolResolution(resolution, deps, c),
      }, 200);
    } catch (error) {
      if (error instanceof ClientToolSettlementError) {
        return publicClientToolSettlementError(c, error);
      }
      throw error;
    }
  });

  app.openapi(settleClientToolRoute, async (c: any) => {
    const deps = getDeps();
    if (!deps.sessionStore?.settleClientTool || !deps.authorizeClientToolSettlement) {
      return c.json({
        ok: false,
        error: "Client-tool settlement is not enabled by this host",
        code: "client_tool_settlement_unavailable",
      }, 501);
    }
    const { id: sessionId, toolCallId } = c.req.valid("param");
    const body = c.req.valid("json");
    const idempotencyKey = c.req.header("idempotency-key")?.trim();
    if (!idempotencyKey) {
      return c.json({
        ok: false,
        error: "Idempotency-Key is required",
        code: "invalid_client_tool_settlement",
      }, 400);
    }
    if (body.result !== undefined && utf8Bytes(body.result) > MAX_CLIENT_TOOL_SETTLEMENT_RESULT_BYTES) {
      return c.json({
        ok: false,
        error: `result exceeds ${MAX_CLIENT_TOOL_SETTLEMENT_RESULT_BYTES} UTF-8 bytes`,
        code: "invalid_client_tool_settlement",
      }, 400);
    }
    if (body.reason !== undefined && utf8Bytes(body.reason) > MAX_CLIENT_TOOL_SETTLEMENT_REASON_BYTES) {
      return c.json({
        ok: false,
        error: `reason exceeds ${MAX_CLIENT_TOOL_SETTLEMENT_REASON_BYTES} UTF-8 bytes`,
        code: "invalid_client_tool_settlement",
      }, 400);
    }
    const authorized = await deps.authorizeClientToolSettlement({
      sessionId,
      toolCallId,
      agent: body.agent,
      user: body.user,
      requestContext: c,
    });
    if (!authorized) {
      return c.json({
        ok: false,
        error: "Client-tool settlement is not authorized",
        code: "client_tool_settlement_scope_mismatch",
      }, 403);
    }
    try {
      const scope = await deps.resolveClientToolResolutionScope?.(c);
      const common = {
        sessionId,
        toolCallId,
        agent: body.agent,
        user: body.user,
        ...(scope ? { scope } : {}),
        expectedSessionVersion: body.expectedSessionVersion,
        idempotencyKey,
      };
      const input: SettleClientToolInput = body.outcome === "success"
        ? { ...common, outcome: "success", result: body.result }
        : {
            ...common,
            outcome: body.outcome,
            ...(body.result !== undefined ? { result: body.result } : {}),
            ...(body.reason !== undefined ? { reason: body.reason } : {}),
          };
      const result = await deps.sessionStore.settleClientTool(input);
      return c.json({ ok: true, data: result }, 200);
    } catch (error) {
      if (error instanceof ClientToolSettlementError) {
        return publicClientToolSettlementError(c, error, {
          agent: body.agent,
          user: body.user,
        });
      }
      throw error;
    }
  });

  return app;
}

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

  app.openapi(getSessionMetadataRoute, async (c) => {
    const { sessionStore } = getDeps();
    if (!sessionStore) return c.json({ ok: false, error: "Session store not available", code: "NOT_AVAILABLE" }, 503);
    const session = await sessionStore.getSession(c.req.valid("param").id);
    if (!session) return c.json({ ok: false, error: "Session not found", code: "NOT_FOUND" }, 404);
    return c.json({ ok: true, data: session }, 200);
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
    const { title, expectedTitleRevision } = c.req.valid("json");
    if (sessionStore.getSessionTitleState && sessionStore.compareAndSetSessionTitleState) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const current = await sessionStore.getSessionTitleState(id);
        if (!current) return c.json({ ok: false, error: "Session not found", code: "NOT_FOUND" }, 404);
        if (expectedTitleRevision !== undefined && current.snapshot.titleRevision !== expectedTitleRevision) {
          return c.json({ ok: false, error: "Session title revision changed", code: "SESSION_TITLE_REVISION_CONFLICT", titleRevision: current.snapshot.titleRevision }, 409);
        }
        const next = manualSessionTitleState(current, title);
        if (!await sessionStore.compareAndSetSessionTitleState(id, current, next)) continue;
        const session = sessionTitleSnapshot(next);
        try { getDeps().emit?.("session:updated", { session }); } catch { /* Durable notification remains pending. */ }
        return c.json({ ok: true, data: { renamed: true, session } }, 200);
      }
      return c.json({ ok: false, error: "Session title changed repeatedly", code: "SESSION_TITLE_REVISION_CONFLICT" }, 409);
    }
    if (expectedTitleRevision !== undefined) return c.json({ ok: false, error: "Session store does not support title revisions", code: "NOT_AVAILABLE" }, 503);
    const renamed = await sessionStore.renameSession(id, title);
    if (!renamed) return c.json({ ok: false, error: "Session not found", code: "NOT_FOUND" }, 404);
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
        const safeToolCalls = msg.toolCalls.map((toolCall) => {
          if (!toolCall || typeof toolCall !== "object" || Array.isArray(toolCall)) return toolCall;
          const {
            continuationClientTools: _continuationClientTools,
            settlementOutcome: _settlementOutcome,
            ...safe
          } = toolCall as Record<string, unknown>;
          return safe;
        });
        await sessionStore.updateMessage(sessionId, added.id, msg.content, safeToolCalls as any);
      }
      imported++;
    }

    return c.json({ ok: true, data: { sessionId, imported } }, 201);
  });

  return app;
}
