import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { streamSSE } from "hono/streaming";
import { nanoid } from "nanoid";
import {
  MAX_RUN_EVENT_PAGE_SIZE,
  RunDeliveryValidationError,
  RunEventCursorAheadError,
  RunEventCursorExpiredError,
  parseRunEventCursor,
  type AppendRunStreamEvent,
  type RunCancellationStore,
  type RunEventStore,
  type RunExecutionLeaseStore,
  type RunStreamEvent,
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
  onInterruptedError?: (error: unknown, runId: string) => void;
  /**
   * Resolve an authoritative host terminal after the recovery lease is held.
   * Returning null/undefined retains the default interrupted failure.
   */
  resolveTerminalEvent?: (
    runId: string,
  ) => Promise<AppendRunStreamEvent | null | undefined>;
  /** Retryable host projection. Must be idempotent and guard against stale state. */
  onTerminal?: (runId: string, event: RunStreamEvent) => Promise<void>;
  onTerminalError?: (error: unknown, runId: string) => void;
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
          onInterruptedError: resolved.onInterruptedError,
          resolveTerminalEvent: resolved.resolveTerminalEvent,
          onTerminal: resolved.onTerminal,
          onTerminalError: resolved.onTerminalError,
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
  onInterruptedError?: (error: unknown, runId: string) => void;
  resolveTerminalEvent?: (
    runId: string,
  ) => Promise<AppendRunStreamEvent | null | undefined>;
  /** Runs for both existing and newly persisted terminal events; may be retried. */
  onTerminal?: (runId: string, event: RunStreamEvent) => Promise<void>;
  onTerminalError?: (error: unknown, runId: string) => void;
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
  const history = await inspectRunLifecycle(options.eventStore, options.runId);
  if (history.terminal) {
    await reconcileInterruptedHostProjection(options, history.terminal);
    return "terminal";
  }
  if (!history.started) {
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

  let recoveryLease = {
    owner: "run-delivery-reconciler",
    token: options.createToken?.() ?? nanoid(24),
    expiresAt: new Date(now.getTime() + 10_000).toISOString(),
  };
  if (!await options.leaseStore.claim(options.runId, recoveryLease)) {
    return "contended";
  }

  try {
    const claimedHistory = await inspectRunLifecycle(options.eventStore, options.runId);
    if (claimedHistory.terminal) {
      await reconcileInterruptedHostProjection(options, claimedHistory.terminal);
      return "terminal";
    }
    const resolvedTerminal = await options.resolveTerminalEvent?.(options.runId);
    if (resolvedTerminal && !isTerminalRunEventInput(resolvedTerminal)) {
      throw new RunDeliveryValidationError(
        "Run delivery terminal resolver must return run.completed, run.failed, or run.cancelled",
      );
    }
    // Host resolution may perform I/O. Renew with a fresh clock immediately
    // before append so a replacement owner can fence a delayed resolver.
    const appendTime = options.now?.() ?? new Date();
    if (!(appendTime instanceof Date) || !Number.isFinite(appendTime.getTime())) {
      throw new RunDeliveryValidationError("Run delivery clock returned an invalid date");
    }
    const renewedLease = {
      ...recoveryLease,
      expiresAt: new Date(appendTime.getTime() + 10_000).toISOString(),
    };
    if (!await options.leaseStore.renew(options.runId, renewedLease)) {
      return "contended";
    }
    recoveryLease = renewedLease;
    const journal = new RunEventJournal(options.eventStore, options.notifier);
    const terminalInput = resolvedTerminal ?? interruptedTerminalEvent();
    const terminal = await journal.append(options.runId, terminalInput);
    await options.cancellationStore.clear(options.runId).catch(() => false);
    await reconcileInterruptedHostProjection(options, terminal);
    return resolvedTerminal ? "terminal" : "interrupted";
  } finally {
    await options.leaseStore.release(options.runId, recoveryLease).catch(() => false);
  }
}

function interruptedTerminalEvent(): AppendRunStreamEvent {
  return {
    id: "run.failed:execution-interrupted",
    type: "run.failed",
    data: {
      code: "run_execution_interrupted",
      message: "Run execution was interrupted before completion",
      retryable: true,
    },
  };
}

function isTerminalRunEventInput(input: AppendRunStreamEvent): boolean {
  return input.type === "run.completed"
    || input.type === "run.failed"
    || input.type === "run.cancelled";
}

async function reconcileInterruptedHostProjection(
  options: ReconcileInterruptedRunOptions,
  terminal: RunStreamEvent,
): Promise<void> {
  if (
    terminal?.type === "run.failed"
    && terminal.data.code === "run_execution_interrupted"
  ) {
    await notifyInterruptedHost(options);
  }
  if (terminal) {
    try {
      await options.onTerminal?.(options.runId, terminal);
    } catch (error) {
      try {
        options.onTerminalError?.(error, options.runId);
      } catch {
        // A failed projection remains retryable even if its logger also fails.
      }
    }
  }
}

async function notifyInterruptedHost(
  options: ReconcileInterruptedRunOptions,
): Promise<void> {
  try {
    await options.onInterrupted?.(options.runId);
  } catch (error) {
    try {
      options.onInterruptedError?.(error, options.runId);
    } catch {
      // Host observability must not make the durable terminal event unreadable.
    }
  }
}

async function hasTerminalRunEvent(eventStore: RunEventStore, runId: string): Promise<boolean> {
  return (await inspectRunLifecycle(eventStore, runId)).terminal !== undefined;
}

async function inspectRunLifecycle(
  eventStore: RunEventStore,
  runId: string,
): Promise<{ started: boolean; terminal?: RunStreamEvent }> {
  const bounds = await eventStore.bounds(runId);
  if (bounds && parseRunEventCursor(bounds.firstCursor) !== 1) {
    throw new RunEventCursorExpiredError(
      "Run lifecycle history is incomplete; reconciliation cannot continue safely",
    );
  }
  let cursor: string | undefined;
  let started = false;
  let executionObserved = false;
  while (true) {
    const page = await eventStore.listAfter(runId, cursor, MAX_RUN_EVENT_PAGE_SIZE);
    for (const event of page.events) {
      if (event.type === "run.started") started = true;
      else if (event.type !== "run.accepted") executionObserved = true;
      if (isTerminalRunStreamEvent(event)) return { started, terminal: event };
    }
    if (!page.hasMore) {
      if (started || executionObserved) return { started: true };
      return { started: false };
    }
    if (page.nextCursor === cursor) {
      throw new RunDeliveryValidationError("Run event store did not advance its cursor");
    }
    cursor = page.nextCursor;
  }
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
