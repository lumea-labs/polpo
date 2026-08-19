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
): CompletionSseWriter {
  const journal = new RunEventJournal(scope.eventStore, scope.notifier);
  let writeChain: Promise<unknown> = Promise.resolve();
  return {
    write: async () => undefined,
    writeSSE: (message) => {
      writeChain = writeChain.then(() => journal.append(runId, {
        type: message.data === "[DONE]" ? "response.done" : "response.chunk",
        data: {
          data: message.data,
          ...(message.event === undefined ? {} : { event: message.event }),
          ...(message.id === undefined ? {} : { id: message.id }),
        },
      }));
      return writeChain;
    },
  };
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
      await options.producer({
        signal,
        writer: createDurableCompletionWriter(options.runId, options.scope),
      });
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
