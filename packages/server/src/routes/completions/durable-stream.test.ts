import { describe, expect, it } from "vitest";
import {
  InMemoryRunCancellationStore,
  InMemoryRunEventStore,
  InMemoryRunExecutionLeaseStore,
} from "@polpo-ai/core/run-delivery";
import { InMemoryRunEventNotifier } from "@polpo-ai/core/run-delivery-follower";
import {
  createDurableCompletionWriter,
  startDurableCompletion,
  streamDurableCompletionFrames,
  type CompletionRunDeliveryScope,
} from "./durable-stream.js";

function scope(): CompletionRunDeliveryScope {
  return {
    eventStore: new InMemoryRunEventStore(),
    leaseStore: new InMemoryRunExecutionLeaseStore(),
    cancellationStore: new InMemoryRunCancellationStore(),
    notifier: new InMemoryRunEventNotifier(),
    owner: "worker-a",
    token: "token-a",
  };
}

describe("durable completion stream", () => {
  it("persists OpenAI frames and replays them without lifecycle internals", async () => {
    const delivery = scope();
    const execution = startDurableCompletion({
      runId: "run-a",
      scope: delivery,
      producer: async ({ writer }) => {
        await writer.writeSSE({ data: '{"choices":[{"delta":{"content":"hello"}}]}' });
        await writer.writeSSE({ data: "[DONE]" });
      },
    });
    const frames: string[] = [];
    await streamDurableCompletionFrames({
      runId: "run-a",
      scope: delivery,
      write: async (frame) => { frames.push(frame.data); },
    });

    await expect(execution).resolves.toEqual({ status: "completed" });
    expect(frames).toEqual([
      '{"choices":[{"delta":{"content":"hello"}}]}',
      "[DONE]",
    ]);
    expect((await delivery.eventStore.listAfter("run-a")).events.map((event) => event.type)).toEqual([
      "run.started",
      "response.chunk",
      "response.done",
      "run.completed",
    ]);
  });

  it("subscriber disconnect aborts only the follower while the producer completes", async () => {
    const delivery = scope();
    let releaseProducer!: () => void;
    const producerGate = new Promise<void>((resolve) => { releaseProducer = resolve; });
    let producerSignal: AbortSignal | undefined;
    const execution = startDurableCompletion({
      runId: "run-a",
      scope: delivery,
      producer: async ({ writer, signal }) => {
        producerSignal = signal;
        await writer.writeSSE({ data: '{"chunk":1}' });
        await producerGate;
        await writer.writeSSE({ data: "[DONE]" });
      },
    });
    const follower = new AbortController();
    const frames: string[] = [];
    const streaming = streamDurableCompletionFrames({
      runId: "run-a",
      scope: delivery,
      signal: follower.signal,
      write: async (frame) => {
        frames.push(frame.data);
        follower.abort();
      },
    });

    await streaming;
    expect(producerSignal?.aborted).toBe(false);
    releaseProducer();
    await expect(execution).resolves.toEqual({ status: "completed" });
    expect(producerSignal?.aborted).toBe(false);
    expect(frames).toEqual(['{"chunk":1}']);
  });

  it("serializes concurrent writer calls in invocation order", async () => {
    const delivery = scope();
    const writer = createDurableCompletionWriter("run-a", delivery);
    await Promise.all([
      writer.writeSSE({ data: "one" }),
      writer.writeSSE({ data: "two" }),
      writer.writeSSE({ data: "[DONE]" }),
    ]);
    const events = (await delivery.eventStore.listAfter("run-a")).events;
    expect(events.map((event) => event.data.data)).toEqual(["one", "two", "[DONE]"]);
  });

  it("projects unexpected producer failures to the initial subscriber", async () => {
    const delivery = scope();
    const execution = startDurableCompletion({
      runId: "run-a",
      scope: delivery,
      producer: async () => { throw new Error("provider unavailable"); },
    });
    const frames: Array<{ data: string; event?: string }> = [];

    await streamDurableCompletionFrames({
      runId: "run-a",
      scope: delivery,
      write: async (frame) => {
        frames.push({
          data: frame.data,
          ...(frame.event === undefined ? {} : { event: frame.event }),
        });
      },
    });

    await expect(execution).resolves.toEqual({
      status: "failed",
      error: "provider unavailable",
    });
    expect(frames).toEqual([{
      event: "error",
      data: JSON.stringify({
        error: {
          message: "provider unavailable",
          type: "model_error",
          code: "model_request_failed",
        },
      }),
    }]);
  });

  it("emits a terminal frame when a producer completes without writing DONE", async () => {
    const delivery = scope();
    const execution = startDurableCompletion({
      runId: "run-a",
      scope: delivery,
      producer: async ({ writer }) => {
        await writer.writeSSE({ data: '{"choices":[]}' });
      },
    });
    const frames: string[] = [];

    await streamDurableCompletionFrames({
      runId: "run-a",
      scope: delivery,
      write: async (frame) => { frames.push(frame.data); },
    });

    await expect(execution).resolves.toEqual({ status: "completed" });
    expect(frames).toEqual(['{"choices":[]}', "[DONE]"]);
  });
});
