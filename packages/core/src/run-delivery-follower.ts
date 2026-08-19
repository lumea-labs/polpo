import {
  DEFAULT_RUN_EVENT_PAGE_SIZE,
  MAX_RUN_EVENT_PAGE_SIZE,
  RunDeliveryValidationError,
  RunEventCursorAheadError,
  RunEventCursorExpiredError,
  formatRunEventCursor,
  parseRunEventCursor,
  validateRunDeliveryRunId,
  type AppendRunStreamEvent,
  type RunEventStore,
  type RunStreamEvent,
} from "./run-delivery.js";

export interface RunEventNotifier {
  publish(runId: string, cursor: string): Promise<void> | void;
  subscribe(
    runId: string,
    wake: () => void,
  ): Promise<() => Promise<void> | void> | (() => Promise<void> | void);
}

/** Low-latency process-local notifier. The event store remains authoritative. */
export class InMemoryRunEventNotifier implements RunEventNotifier {
  private readonly listeners = new Map<string, Set<() => void>>();

  publish(runId: string, _cursor: string): void {
    validateRunDeliveryRunId(runId);
    for (const listener of this.listeners.get(runId) ?? []) listener();
  }

  subscribe(runId: string, wake: () => void): () => void {
    validateRunDeliveryRunId(runId);
    if (typeof wake !== "function") {
      throw new RunDeliveryValidationError("Run event wake subscriber must be a function");
    }
    const listeners = this.listeners.get(runId) ?? new Set<() => void>();
    listeners.add(wake);
    this.listeners.set(runId, listeners);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      listeners.delete(wake);
      if (listeners.size === 0) this.listeners.delete(runId);
    };
  }

  listenerCount(runId: string): number {
    return this.listeners.get(runId)?.size ?? 0;
  }
}

/** Appends first, then emits a best-effort wake hint. */
export class RunEventJournal {
  constructor(
    readonly store: RunEventStore,
    readonly notifier?: RunEventNotifier,
  ) {}

  async append(runId: string, input: AppendRunStreamEvent): Promise<RunStreamEvent> {
    const event = await this.store.append(runId, input);
    try {
      await this.notifier?.publish(runId, formatRunEventCursor(event.sequence));
    } catch {
      // Notification loss is safe: followers poll the authoritative store.
    }
    return event;
  }

  async appendMany(
    runId: string,
    inputs: readonly AppendRunStreamEvent[],
  ): Promise<RunStreamEvent[]> {
    if (inputs.length === 0) return [];
    const events = this.store.appendMany
      ? await this.store.appendMany(runId, inputs)
      : await appendInOrder(this.store, runId, inputs);
    const last = events.at(-1);
    if (last) {
      try {
        await this.notifier?.publish(runId, formatRunEventCursor(last.sequence));
      } catch {
        // Notification loss is safe: followers poll the authoritative store.
      }
    }
    return events;
  }
}

async function appendInOrder(
  store: RunEventStore,
  runId: string,
  inputs: readonly AppendRunStreamEvent[],
): Promise<RunStreamEvent[]> {
  const events: RunStreamEvent[] = [];
  for (const input of inputs) events.push(await store.append(runId, input));
  return events;
}

const TERMINAL_RUN_EVENT_TYPES = new Set<RunStreamEvent["type"]>([
  "run.completed",
  "run.failed",
  "run.cancelled",
]);

export function isTerminalRunStreamEvent(event: RunStreamEvent): boolean {
  return TERMINAL_RUN_EVENT_TYPES.has(event.type);
}

export interface FollowRunEventsOptions {
  runId: string;
  store: RunEventStore;
  notifier?: RunEventNotifier;
  cursor?: string;
  pageSize?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  isTerminal?: (event: RunStreamEvent) => boolean;
}

export type RunEventCursorAvailability = "available" | "terminal";

/** Validate a cursor against retained history before opening a live follower. */
export async function inspectRunEventCursor(
  store: RunEventStore,
  runId: string,
  cursor?: string,
): Promise<RunEventCursorAvailability> {
  const normalizedRunId = validateRunDeliveryRunId(runId);
  const sequence = parseRunEventCursor(cursor);
  const bounds = await store.bounds(normalizedRunId);
  if (!bounds) {
    if (sequence > 0) {
      throw new RunEventCursorAheadError("Run event cursor is ahead of available history");
    }
    return "available";
  }
  const first = parseRunEventCursor(bounds.firstCursor);
  const last = parseRunEventCursor(bounds.lastCursor);
  if (sequence > last) {
    throw new RunEventCursorAheadError("Run event cursor is ahead of available history");
  }
  if (sequence < first - 1) {
    throw new RunEventCursorExpiredError("Run event cursor is no longer retained");
  }
  if (sequence !== last) return "available";
  const page = await store.listAfter(normalizedRunId, formatRunEventCursor(last - 1), 1);
  return page.events[0] && isTerminalRunStreamEvent(page.events[0])
    ? "terminal"
    : "available";
}

/**
 * Replay persisted events and then follow the live tail. Subscribing before the
 * first read closes the read/wait race; polling guarantees progress when a wake
 * notification is delayed or lost.
 */
export async function* followRunEvents(
  options: FollowRunEventsOptions,
): AsyncGenerator<RunStreamEvent, void, void> {
  const runId = validateRunDeliveryRunId(options.runId);
  const pageSize = options.pageSize ?? DEFAULT_RUN_EVENT_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_RUN_EVENT_PAGE_SIZE) {
    throw new RunDeliveryValidationError(
      `Run event page size must be between 1 and ${MAX_RUN_EVENT_PAGE_SIZE}`,
    );
  }
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 60_000) {
    throw new RunDeliveryValidationError(
      "Run event poll interval must be between 1 and 60000 milliseconds",
    );
  }
  if (options.signal?.aborted) return;

  if (await inspectRunEventCursor(options.store, runId, options.cursor) === "terminal") {
    return;
  }

  let wakeVersion = 0;
  let wakeWaiter: (() => void) | undefined;
  const wake = () => {
    wakeVersion += 1;
    wakeWaiter?.();
  };
  const unsubscribe = options.notifier
    ? await options.notifier.subscribe(runId, wake)
    : undefined;
  let cursor = options.cursor;
  const terminal = options.isTerminal ?? isTerminalRunStreamEvent;

  try {
    while (!options.signal?.aborted) {
      const observedWakeVersion = wakeVersion;
      const page = await options.store.listAfter(runId, cursor, pageSize);
      if (options.signal?.aborted) return;
      for (const event of page.events) {
        if (options.signal?.aborted) return;
        cursor = formatRunEventCursor(event.sequence);
        yield event;
        if (terminal(event)) return;
      }
      if (page.hasMore) continue;
      if (wakeVersion !== observedWakeVersion) continue;
      await waitForWakeOrPoll({
        signal: options.signal,
        pollIntervalMs,
        register: (resolve) => { wakeWaiter = resolve; },
        unregister: (resolve) => {
          if (wakeWaiter === resolve) wakeWaiter = undefined;
        },
      });
    }
  } finally {
    wakeWaiter = undefined;
    await unsubscribe?.();
  }
}

interface WaitForWakeOptions {
  signal?: AbortSignal;
  pollIntervalMs: number;
  register: (resolve: () => void) => void;
  unregister: (resolve: () => void) => void;
}

async function waitForWakeOrPoll(options: WaitForWakeOptions): Promise<void> {
  if (options.signal?.aborted) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", finish);
      options.unregister(finish);
      resolve();
    };
    const timeout = setTimeout(finish, options.pollIntervalMs);
    options.register(finish);
    options.signal?.addEventListener("abort", finish, { once: true });
    if (options.signal?.aborted) finish();
  });
}
