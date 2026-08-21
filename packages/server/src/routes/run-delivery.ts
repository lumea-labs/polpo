import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { streamSSE } from "hono/streaming";
import { nanoid } from "nanoid";
import {
  RunDeliveryValidationError,
  RunEventCursorAheadError,
  RunEventCursorExpiredError,
  parseRunEventCursor,
  type RunCancellationStore,
  type RunEventStore,
  type RunExecutionLeaseStore,
} from "@polpo-ai/core/run-delivery";
import {
  RunEventJournal,
  followRunEvents,
  inspectRunEventCursor,
  isTerminalRunStreamEvent,
  type RunEventNotifier,
} from "@polpo-ai/core/run-delivery-follower";

export interface ResolvedRunDelivery {
  eventStore: RunEventStore;
  leaseStore?: RunExecutionLeaseStore;
  cancellationStore: RunCancellationStore;
  notifier?: RunEventNotifier;
  onInterrupted?: (runId: string) => Promise<void>;
}

export interface RunDeliveryRouteDeps {
  /** Host-authorized resolver. Return null for missing or inaccessible runs. */
  resolveRunDelivery?: (runId: string) => Promise<ResolvedRunDelivery | null>;
  now?: () => Date;
}

const paramsSchema = z.object({ runId: z.string().min(1).max(200) });
const errorSchema = z.object({ ok: z.literal(false), error: z.string(), code: z.string() });

const eventsRoute = createRoute({
  method: "get",
  path: "/{runId}/events",
  tags: ["Runs"],
  summary: "Resume a durable run event stream",
  request: {
    params: paramsSchema,
    query: z.object({
      cursor: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: { "text/event-stream": { schema: z.string() } },
      description: "Versioned run events, replayed after the supplied cursor and followed live",
    },
    400: { content: { "application/json": { schema: errorSchema } }, description: "Invalid or conflicting cursor" },
    410: { content: { "application/json": { schema: errorSchema } }, description: "Cursor history expired" },
    404: { content: { "application/json": { schema: errorSchema } }, description: "Run not found" },
    501: { content: { "application/json": { schema: errorSchema } }, description: "Durable run delivery unavailable" },
  },
});

const cancelBodySchema = z.object({
  reason: z.string().trim().min(1).max(500).optional(),
}).strict();

const cancelRoute = createRoute({
  method: "post",
  path: "/{runId}/cancel",
  tags: ["Runs"],
  summary: "Cancel a durable run",
  request: {
    params: paramsSchema,
    body: { content: { "application/json": { schema: cancelBodySchema } } },
  },
  responses: {
    202: {
      content: {
        "application/json": {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({ runId: z.string(), accepted: z.boolean() }),
          }),
        },
      },
      description: "Cancellation accepted or already pending",
    },
    404: { content: { "application/json": { schema: errorSchema } }, description: "Run not found" },
    501: { content: { "application/json": { schema: errorSchema } }, description: "Durable run delivery unavailable" },
  },
});

export function runDeliveryRoutes(
  getDeps: () => RunDeliveryRouteDeps,
  apiKeys?: string[],
): OpenAPIHono {
  const app = new OpenAPIHono();

  if (apiKeys && apiKeys.length > 0) {
    app.use("*", async (c, next) => {
      const auth = c.req.header("Authorization");
      const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
      if (!token || !apiKeys.includes(token)) {
        return c.json({
          ok: false,
          error: "Invalid API key",
          code: "invalid_api_key",
        }, 401);
      }
      await next();
    });
  }

  app.openapi(eventsRoute, async (c: any) => {
    const deps = getDeps();
    if (!deps.resolveRunDelivery) return unavailable(c);
    const runId = c.req.valid("param").runId as string;
    const resolved = await deps.resolveRunDelivery(runId);
    if (!resolved) return notFound(c);
    const reconcile = () => resolved.leaseStore
      ? reconcileInterruptedRun({
          runId,
          eventStore: resolved.eventStore,
          leaseStore: resolved.leaseStore,
          cancellationStore: resolved.cancellationStore,
          notifier: resolved.notifier,
          onInterrupted: resolved.onInterrupted,
          now: deps.now,
        })
      : Promise.resolve<InterruptedRunReconciliationResult>("unsupported");
    await reconcile();
    const queryCursor = c.req.valid("query").cursor as string | undefined;
    const headerCursor = c.req.header("Last-Event-ID") as string | undefined;
    if (queryCursor !== undefined && headerCursor !== undefined && queryCursor !== headerCursor) {
      return c.json({
        ok: false,
        error: "cursor and Last-Event-ID must match when both are supplied",
        code: "RUN_CURSOR_CONFLICT",
      }, 400);
    }
    const cursor = queryCursor ?? headerCursor;
    c.header("Cache-Control", "no-cache, no-transform");
    c.header("X-Accel-Buffering", "no");
    try {
      parseRunEventCursor(cursor);
      const availability = await inspectRunEventCursor(resolved.eventStore, runId, cursor);
      if (availability === "terminal") c.header("x-polpo-run-terminal", "true");
    } catch (error) {
      if (error instanceof RunEventCursorExpiredError) {
        return c.json({
          ok: false,
          error: error.message,
          code: "RUN_CURSOR_EXPIRED",
        }, 410);
      }
      if (error instanceof RunEventCursorAheadError) {
        return c.json({
          ok: false,
          error: error.message,
          code: "RUN_CURSOR_AHEAD",
        }, 400);
      }
      if (error instanceof RunDeliveryValidationError) {
        return c.json({
          ok: false,
          error: error.message,
          code: "INVALID_RUN_CURSOR",
        }, 400);
      }
      throw error;
    }

    return streamSSE(c, async (stream) => {
      const followerController = new AbortController();
      stream.onAbort(() => followerController.abort());
      const heartbeat = setInterval(() => {
        if (followerController.signal.aborted) return;
        stream.write(": ping\n\n").catch(() => followerController.abort());
      }, 20_000);
      try {
        for await (const event of followRunEvents({
          runId,
          store: resolved.eventStore,
          notifier: resolved.notifier,
          cursor,
          signal: followerController.signal,
          onIdle: async () => { await reconcile(); },
        })) {
          await stream.writeSSE({
            id: String(event.sequence),
            event: "run.event",
            data: JSON.stringify(event),
          });
        }
      } finally {
        clearInterval(heartbeat);
      }
    });
  });

  app.openapi(cancelRoute, async (c: any) => {
    const deps = getDeps();
    if (!deps.resolveRunDelivery) return unavailable(c);
    const runId = c.req.valid("param").runId as string;
    const resolved = await deps.resolveRunDelivery(runId);
    if (!resolved) return notFound(c);
    const body = c.req.valid("json") as { reason?: string };
    if (await hasTerminalRunEvent(resolved.eventStore, runId)) {
      await resolved.cancellationStore.clear(runId);
      return c.json({ ok: true, data: { runId, accepted: false } }, 202);
    }
    const existing = await resolved.cancellationStore.get(runId);
    const now = deps.now?.() ?? new Date();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new RunDeliveryValidationError("Run delivery clock returned an invalid date");
    }
    await resolved.cancellationStore.request(runId, {
      requestedAt: now.toISOString(),
      ...(body.reason ? { reason: body.reason } : {}),
    });
    if (await hasTerminalRunEvent(resolved.eventStore, runId)) {
      await resolved.cancellationStore.clear(runId);
      return c.json({ ok: true, data: { runId, accepted: false } }, 202);
    }
    return c.json({ ok: true, data: { runId, accepted: existing === null } }, 202);
  });

  return app;
}

export type InterruptedRunReconciliationResult =
  | "unsupported"
  | "not-started"
  | "active"
  | "contended"
  | "terminal"
  | "interrupted";

export interface ReconcileInterruptedRunOptions {
  runId: string;
  eventStore: RunEventStore;
  leaseStore: RunExecutionLeaseStore;
  cancellationStore: RunCancellationStore;
  notifier?: RunEventNotifier;
  onInterrupted?: (runId: string) => Promise<void>;
  now?: () => Date;
  createToken?: () => string;
}

/**
 * Converts an ownerless started run into one durable retryable failure. A
 * recovery lease serializes concurrent reconnects and fences the old owner.
 */
export async function reconcileInterruptedRun(
  options: ReconcileInterruptedRunOptions,
): Promise<InterruptedRunReconciliationResult> {
  const terminal = await lastRunEvent(options.eventStore, options.runId);
  if (terminal && isTerminalRunStreamEvent(terminal)) return "terminal";

  const firstPage = await options.eventStore.listAfter(options.runId, undefined, 10);
  if (!firstPage.events.some((event) => event.type === "run.started")) {
    return "not-started";
  }

  const now = options.now?.() ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new RunDeliveryValidationError("Run delivery clock returned an invalid date");
  }
  const currentLease = await options.leaseStore.get(options.runId);
  if (currentLease && Date.parse(currentLease.expiresAt) > now.getTime()) {
    return "active";
  }

  const recoveryLease = {
    owner: "run-delivery-reconciler",
    token: options.createToken?.() ?? nanoid(24),
    expiresAt: new Date(now.getTime() + 10_000).toISOString(),
  };
  if (!await options.leaseStore.claim(options.runId, recoveryLease)) {
    return "contended";
  }

  try {
    const last = await lastRunEvent(options.eventStore, options.runId);
    if (last && isTerminalRunStreamEvent(last)) return "terminal";
    const journal = new RunEventJournal(options.eventStore, options.notifier);
    await journal.append(options.runId, {
      id: "run.failed:execution-interrupted",
      type: "run.failed",
      data: {
        code: "run_execution_interrupted",
        message: "Run execution was interrupted before completion",
        retryable: true,
      },
    });
    await options.cancellationStore.clear(options.runId).catch(() => false);
    await options.onInterrupted?.(options.runId).catch(() => undefined);
    return "interrupted";
  } finally {
    await options.leaseStore.release(options.runId, recoveryLease).catch(() => false);
  }
}

async function hasTerminalRunEvent(eventStore: RunEventStore, runId: string): Promise<boolean> {
  const lastEvent = await lastRunEvent(eventStore, runId);
  return lastEvent ? isTerminalRunStreamEvent(lastEvent) : false;
}

async function lastRunEvent(eventStore: RunEventStore, runId: string) {
  const bounds = await eventStore.bounds(runId);
  if (!bounds) return undefined;
  const lastSequence = Number(bounds.lastCursor);
  if (!Number.isSafeInteger(lastSequence) || lastSequence < 1) return undefined;
  const page = await eventStore.listAfter(runId, String(lastSequence - 1), 1);
  return page.events[0];
}

function unavailable(c: any) {
  return c.json({
    ok: false,
    error: "Durable run delivery is not configured",
    code: "RUN_DELIVERY_UNAVAILABLE",
  }, 501);
}

function notFound(c: any) {
  return c.json({ ok: false, error: "Run not found", code: "RUN_NOT_FOUND" }, 404);
}
