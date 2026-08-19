import type {
  RunCancellationStore,
  RunEventStore,
  RunExecutionLeaseStore,
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
const DURABLE_WRITE_FLUSH_MS = 25;

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

  const drain = (): Promise<void> => {
    if (drainError) return Promise.reject(drainError);
    if (drainPromise) return drainPromise;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = undefined;
    drainPromise = (async () => {
      while (pending.length > 0) {
        const batch = pending.splice(0, DURABLE_WRITE_BATCH_SIZE);
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
      pending.push({
        type: message.data === "[DONE]" ? "response.done" : "response.chunk",
        data: {
          data: message.data,
          ...(message.event === undefined ? {} : { event: message.event }),
          ...(message.id === undefined ? {} : { id: message.id }),
        },
      });
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
