import {
  MAX_RUN_EVENT_BYTES,
  type AppendRunStreamEvent,
  type RunCancellationStore,
  type RunEventStore,
  type RunExecutionLeaseStore,
} from "@polpo-ai/core/run-delivery";
import {
  RunEventJournal,
  followRunEvents,
  type RunEventNotifier,
} from "@polpo-ai/core/run-delivery-follower";
import {
  executeOwnedRun,
  type OwnedRunExecutionResult,
} from "@polpo-ai/core/run-delivery-owner";
import type { CompletionSseWriter } from "./chat-handler.js";

const DURABLE_WRITE_BATCH_SIZE = 128;
const DURABLE_WRITE_BATCH_BYTES = MAX_RUN_EVENT_BYTES - 16 * 1024;
const DURABLE_WRITE_FLUSH_MS = 25;
const DURABLE_FRAME_FRAGMENT_CHARS = 32_000;
const DURABLE_FRAME_FRAGMENT_THRESHOLD_BYTES = MAX_RUN_EVENT_BYTES - 2_048;

export interface CompletionRunDeliveryScope {
  eventStore: RunEventStore;
  leaseStore: RunExecutionLeaseStore;
  cancellationStore: RunCancellationStore;
  notifier?: RunEventNotifier;
  owner: string;
  /** Unique execution-attempt token. Hosts must not reuse it for concurrent dispatches. */
  token: string;
}

export interface DurableCompletionProducerContext {
  signal: AbortSignal;
  writer: CompletionSseWriter;
}

export function createDurableCompletionWriter(
  runId: string,
  scope: CompletionRunDeliveryScope,
): CompletionSseWriter & { flush(): Promise<void> } {
  const journal = new RunEventJournal(scope.eventStore, scope.notifier);
  const pending: Array<{
    type: "response.chunk" | "response.done";
    data: Record<string, string>;
  }> = [];
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let drainPromise: Promise<void> | undefined;
  let drainError: unknown;
  let frameSequence = 0;

  const takeBatch = (): typeof pending => {
    const batch: typeof pending = [];
    let encodedBytes = 0;
    while (pending.length > 0 && batch.length < DURABLE_WRITE_BATCH_SIZE) {
      const next = pending[0]!;
      const nextBytes = encodedEventBytes(next);
      if (batch.length > 0 && encodedBytes + nextBytes > DURABLE_WRITE_BATCH_BYTES) break;
      batch.push(pending.shift()!);
      encodedBytes += nextBytes;
    }
    return batch;
  };

  const drain = (): Promise<void> => {
    if (drainError) return Promise.reject(drainError);
    if (drainPromise) return drainPromise;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = undefined;
    drainPromise = (async () => {
      while (pending.length > 0) {
        const batch = takeBatch();
        await journal.appendMany(runId, batch);
      }
    })().catch((error) => {
      drainError = error;
      throw error;
    }).finally(() => {
      drainPromise = undefined;
      // A write can arrive after the drain observes an empty queue but before
      // its promise settles. Make sure that tail is not left until finalization.
      if (pending.length > 0 && !drainError) scheduleDrain();
    });
    return drainPromise;
  };

  const scheduleDrain = () => {
    if (flushTimer || drainPromise || drainError) return;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void drain().catch(() => undefined);
    }, DURABLE_WRITE_FLUSH_MS);
  };

  const writer: CompletionSseWriter & { flush(): Promise<void> } = {
    write: async () => undefined,
    writeSSE: (message) => {
      if (drainError) return Promise.reject(drainError);
      const event = {
        type: message.data === "[DONE]" ? "response.done" : "response.chunk",
        data: {
          data: message.data,
          ...(message.event === undefined ? {} : { event: message.event }),
          ...(message.id === undefined ? {} : { id: message.id }),
        },
      } as const;
      pending.push(...splitDurableResponseEvent(
        event,
        `${runId}:frame:${++frameSequence}`,
      ));
      if (
        message.data === "[DONE]"
        || pending.length >= DURABLE_WRITE_BATCH_SIZE
      ) {
        return drain();
      }
      scheduleDrain();
      return Promise.resolve();
    },
    async flush() {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = undefined;
      while (pending.length > 0 || drainPromise) await drain();
      if (drainError) throw drainError;
    },
  };
  return writer;
}

function encodedEventBytes(event: AppendRunStreamEvent): number {
  return new TextEncoder().encode(JSON.stringify(event)).byteLength;
}

function splitDurableResponseEvent(
  event: {
    type: "response.chunk" | "response.done";
    data: Record<string, string>;
  },
  fragmentId: string,
): Array<typeof event> {
  if (
    event.type === "response.done"
    || encodedEventBytes(event) <= DURABLE_FRAME_FRAGMENT_THRESHOLD_BYTES
  ) {
    return [event];
  }
  const data = event.data.data ?? "";
  const parts: string[] = [];
  for (let offset = 0; offset < data.length; offset += DURABLE_FRAME_FRAGMENT_CHARS) {
    parts.push(data.slice(offset, offset + DURABLE_FRAME_FRAGMENT_CHARS));
  }
  return parts.map((part, index) => ({
    type: "response.chunk",
    data: {
      ...event.data,
      data: part,
      fragmentId,
      fragmentIndex: String(index),
      fragmentCount: String(parts.length),
    },
  }));
}

export interface StartDurableCompletionOptions {
  runId: string;
  scope: CompletionRunDeliveryScope;
  producer: (context: DurableCompletionProducerContext) => Promise<void>;
}

export function startDurableCompletion(
  options: StartDurableCompletionOptions,
): Promise<OwnedRunExecutionResult> {
  const journal = new RunEventJournal(options.scope.eventStore, options.scope.notifier);
  return executeOwnedRun({
    runId: options.runId,
    owner: options.scope.owner,
    token: options.scope.token,
    journal,
    leaseStore: options.scope.leaseStore,
    cancellationStore: options.scope.cancellationStore,
    producer: async ({ signal }) => {
      const writer = createDurableCompletionWriter(options.runId, options.scope);
      try {
        await options.producer({ signal, writer });
      } finally {
        await writer.flush();
      }
    },
  });
}

export interface DurableCompletionFrame {
  data: string;
  event?: string;
  id?: string;
  cursor: string;
}

export interface StreamDurableCompletionFramesOptions {
  runId: string;
  scope: Pick<CompletionRunDeliveryScope, "eventStore" | "notifier">;
  cursor?: string;
  signal?: AbortSignal;
  write: (frame: DurableCompletionFrame) => Promise<void>;
}

export async function streamDurableCompletionFrames(
  options: StreamDurableCompletionFramesOptions,
): Promise<void> {
  let responseDone = false;
  let fragmentedFrame: {
    id: string;
    count: number;
    nextIndex: number;
    parts: string[];
    event?: string;
    messageId?: string;
  } | undefined;
  for await (const event of followRunEvents({
    runId: options.runId,
    store: options.scope.eventStore,
    notifier: options.scope.notifier,
    cursor: options.cursor,
    signal: options.signal,
  })) {
    if (event.type === "response.chunk" || event.type === "response.done") {
      const data = typeof event.data.data === "string" ? event.data.data : undefined;
      if (data === undefined) continue;
      const fragmentId = typeof event.data.fragmentId === "string"
        ? event.data.fragmentId
        : undefined;
      if (fragmentId) {
        const index = Number(event.data.fragmentIndex);
        const count = Number(event.data.fragmentCount);
        if (
          !Number.isSafeInteger(index)
          || !Number.isSafeInteger(count)
          || index < 0
          || count < 1
          || index >= count
          || (index === 0 && fragmentedFrame !== undefined)
          || (index > 0 && (
            fragmentedFrame?.id !== fragmentId
            || fragmentedFrame.count !== count
            || fragmentedFrame.nextIndex !== index
          ))
        ) {
          throw new Error("Durable response fragment sequence is invalid");
        }
        if (index === 0) {
          fragmentedFrame = {
            id: fragmentId,
            count,
            nextIndex: 0,
            parts: [],
            ...(typeof event.data.event === "string" ? { event: event.data.event } : {}),
            ...(typeof event.data.id === "string" ? { messageId: event.data.id } : {}),
          };
        }
        fragmentedFrame!.parts.push(data);
        fragmentedFrame!.nextIndex += 1;
        if (fragmentedFrame!.nextIndex === fragmentedFrame!.count) {
          const completed = fragmentedFrame!;
          fragmentedFrame = undefined;
          await options.write({
            data: completed.parts.join(""),
            cursor: String(event.sequence),
            ...(completed.event === undefined ? {} : { event: completed.event }),
            ...(completed.messageId === undefined ? {} : { id: completed.messageId }),
          });
        }
        continue;
      }
      if (fragmentedFrame) {
        throw new Error("Durable response fragment sequence ended prematurely");
      }
      responseDone ||= event.type === "response.done";
      await options.write({
        data,
        cursor: String(event.sequence),
        ...(typeof event.data.event === "string" ? { event: event.data.event } : {}),
        ...(typeof event.data.id === "string" ? { id: event.data.id } : {}),
      });
      continue;
    }
    if (event.type === "run.failed") {
      const message = typeof event.data.message === "string"
        ? event.data.message
        : "Run execution failed";
      await options.write({
        event: "error",
        cursor: String(event.sequence),
        data: JSON.stringify({
          error: {
            message,
            type: "model_error",
            code: "model_request_failed",
          },
        }),
      });
      continue;
    }
    if (!responseDone && (event.type === "run.completed" || event.type === "run.cancelled")) {
      responseDone = true;
      await options.write({ data: "[DONE]", cursor: String(event.sequence) });
    }
  }
}
