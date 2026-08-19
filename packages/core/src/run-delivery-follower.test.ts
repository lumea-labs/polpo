import { describe, expect, it, vi } from "vitest";
import {
  InMemoryRunEventStore,
  RunEventCursorAheadError,
  RunEventCursorExpiredError,
} from "./run-delivery.js";
import {
  InMemoryRunEventNotifier,
  RunEventJournal,
  followRunEvents,
} from "./run-delivery-follower.js";

describe("RunEventJournal", () => {
  it("publishes only after an event is durably appended", async () => {
    const store = new InMemoryRunEventStore();
    const notifier = new InMemoryRunEventNotifier();
    const publish = vi.spyOn(notifier, "publish");
    const journal = new RunEventJournal(store, notifier);

    const event = await journal.append("run-a", { type: "run.started", data: {} });

    expect(publish).toHaveBeenCalledWith("run-a", "1");
    expect((await store.listAfter("run-a")).events).toEqual([event]);
  });

  it("does not publish when persistence fails", async () => {
    const notifier = new InMemoryRunEventNotifier();
    const publish = vi.spyOn(notifier, "publish");
    const journal = new RunEventJournal({
      append: vi.fn().mockRejectedValue(new Error("storage down")),
      listAfter: vi.fn(),
      bounds: vi.fn(),
    }, notifier);

    await expect(journal.append("run-a", { type: "run.started", data: {} }))
      .rejects.toThrow("storage down");
    expect(publish).not.toHaveBeenCalled();
  });

  it("publishes one wake hint for an ordered durable batch", async () => {
    const store = new InMemoryRunEventStore();
    const notifier = new InMemoryRunEventNotifier();
    const publish = vi.spyOn(notifier, "publish");
    const journal = new RunEventJournal(store, notifier);

    const events = await journal.appendMany("run-a", [
      { type: "response.chunk", data: { data: "one" } },
      { type: "response.chunk", data: { data: "two" } },
    ]);

    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith("run-a", "2");
  });

  it("falls back to ordered single appends for third-party stores", async () => {
    const base = new InMemoryRunEventStore();
    const append = vi.fn(base.append.bind(base));
    const journal = new RunEventJournal({
      append,
      listAfter: base.listAfter.bind(base),
      bounds: base.bounds.bind(base),
    });

    const events = await journal.appendMany("run-a", [
      { type: "response.chunk", data: { data: "one" } },
      { type: "response.done", data: { data: "[DONE]" } },
    ]);

    expect(append).toHaveBeenCalledTimes(2);
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
  });
});

describe("followRunEvents", () => {
  it("replays stored events and follows new events in order until terminal", async () => {
    const store = new InMemoryRunEventStore();
    const notifier = new InMemoryRunEventNotifier();
    const journal = new RunEventJournal(store, notifier);
    await journal.append("run-a", { type: "run.started", data: {} });
    const received: string[] = [];

    const follower = (async () => {
      for await (const event of followRunEvents({
        runId: "run-a",
        store,
        notifier,
        pollIntervalMs: 5,
      })) {
        received.push(event.type);
      }
    })();

    await journal.append("run-a", {
      type: "output.text.delta",
      data: { text: "hello" },
    });
    await journal.append("run-a", { type: "run.completed", data: {} });
    await follower;

    expect(received).toEqual(["run.started", "output.text.delta", "run.completed"]);
  });

  it("does not miss an event published while the first page is being read", async () => {
    const base = new InMemoryRunEventStore();
    const notifier = new InMemoryRunEventNotifier();
    const journal = new RunEventJournal(base, notifier);
    let firstRead = true;
    const store = {
      append: base.append.bind(base),
      bounds: base.bounds.bind(base),
      listAfter: async (...args: Parameters<typeof base.listAfter>) => {
        const page = await base.listAfter(...args);
        if (firstRead) {
          firstRead = false;
          await journal.append("run-a", { type: "run.completed", data: {} });
        }
        return page;
      },
    };

    const received: string[] = [];
    for await (const event of followRunEvents({
      runId: "run-a",
      store,
      notifier,
      pollIntervalMs: 10_000,
    })) {
      received.push(event.type);
    }

    expect(received).toEqual(["run.completed"]);
  });

  it("recovers from a dropped notification by polling the authoritative store", async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryRunEventStore();
      const received: string[] = [];
      const follower = (async () => {
        for await (const event of followRunEvents({
          runId: "run-a",
          store,
          pollIntervalMs: 100,
        })) {
          received.push(event.type);
        }
      })();

      await vi.advanceTimersByTimeAsync(1);
      await store.append("run-a", { type: "run.completed", data: {} });
      await vi.advanceTimersByTimeAsync(100);
      await follower;
      expect(received).toEqual(["run.completed"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops promptly when the subscriber aborts without cancelling the producer", async () => {
    const store = new InMemoryRunEventStore();
    const notifier = new InMemoryRunEventNotifier();
    const controller = new AbortController();
    const received: string[] = [];
    const follower = (async () => {
      for await (const event of followRunEvents({
        runId: "run-a",
        store,
        notifier,
        signal: controller.signal,
        pollIntervalMs: 10_000,
      })) {
        received.push(event.type);
      }
    })();

    controller.abort();
    await follower;
    expect(received).toEqual([]);
    expect(notifier.listenerCount("run-a")).toBe(0);
  });

  it("continues across bounded pages without waiting for notifications", async () => {
    const store = new InMemoryRunEventStore();
    for (let index = 0; index < 7; index += 1) {
      await store.append("run-a", {
        type: "output.text.delta",
        data: { text: String(index) },
      });
    }
    await store.append("run-a", { type: "run.completed", data: {} });

    const sequences: number[] = [];
    for await (const event of followRunEvents({
      runId: "run-a",
      store,
      pageSize: 3,
      pollIntervalMs: 10_000,
    })) {
      sequences.push(event.sequence);
    }
    expect(sequences).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("keeps canonical followers open through response completion until run terminal state", async () => {
    const store = new InMemoryRunEventStore();
    const notifier = new InMemoryRunEventNotifier();
    const journal = new RunEventJournal(store, notifier);
    await journal.append("run-a", { type: "response.done", data: { data: "[DONE]" } });
    const received: string[] = [];
    const follower = (async () => {
      for await (const event of followRunEvents({ runId: "run-a", store, notifier })) {
        received.push(event.type);
      }
    })();

    await journal.append("run-a", { type: "run.completed", data: {} });
    await follower;

    expect(received).toEqual(["response.done", "run.completed"]);
  });

  it("closes immediately when the cursor already acknowledges the terminal event", async () => {
    const store = new InMemoryRunEventStore();
    await store.append("run-a", { type: "run.completed", data: {} });
    const received = [];

    for await (const event of followRunEvents({ runId: "run-a", store, cursor: "1" })) {
      received.push(event);
    }

    expect(received).toEqual([]);
  });

  it("rejects cursors ahead of available history", async () => {
    const store = new InMemoryRunEventStore();
    await store.append("run-a", { type: "run.started", data: {} });

    await expect(async () => {
      for await (const _event of followRunEvents({ runId: "run-a", store, cursor: "2" })) {
        // consume
      }
    }).rejects.toBeInstanceOf(RunEventCursorAheadError);
  });

  it("rejects cursors older than retained history", async () => {
    const retained = new InMemoryRunEventStore();
    for (let index = 0; index < 5; index += 1) {
      await retained.append("run-a", { type: "output.text.delta", data: { text: String(index) } });
    }
    const store = {
      append: retained.append.bind(retained),
      bounds: async () => ({ firstCursor: "5", lastCursor: "5", count: 1 }),
      listAfter: retained.listAfter.bind(retained),
    };

    await expect(async () => {
      for await (const _event of followRunEvents({ runId: "run-a", store, cursor: "3" })) {
        // consume
      }
    }).rejects.toBeInstanceOf(RunEventCursorExpiredError);
  });
});
