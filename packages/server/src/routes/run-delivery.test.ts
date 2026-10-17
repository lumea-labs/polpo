import { describe, expect, it, vi } from "vitest";
import {
  InMemoryRunCancellationStore,
  InMemoryRunEventStore,
  InMemoryRunExecutionLeaseStore,
  RunEventCursorExpiredError,
} from "@polpo-ai/core/run-delivery";
import {
  InMemoryRunEventNotifier,
  RunEventJournal,
} from "@polpo-ai/core/run-delivery-follower";
import {
  reconcileInterruptedRun,
  runDeliveryRoutes,
} from "./run-delivery.js";

function cancelRequest(runId: string, body: unknown = {}) {
  return new Request(`http://localhost/${runId}/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("runDeliveryRoutes", () => {
  for (const type of ["run.failed", "run.cancelled", "run.completed"] as const) {
    it(`retries the host projection for generic ${type} without rewriting durable history`, async () => {
      const runId = `generic-${type}`;
      const eventStore = new InMemoryRunEventStore();
      const leaseStore = new InMemoryRunExecutionLeaseStore();
      const cancellationStore = new InMemoryRunCancellationStore();
      await eventStore.append(runId, { type: "run.started", data: {} });
      const terminal = await eventStore.append(runId, { type, data: { message: "Failed query: UPDATE tool_execution_receipts" } });
      const onTerminal = vi.fn().mockRejectedValueOnce(new Error("projection unavailable")).mockResolvedValue(undefined);
      const onTerminalError = vi.fn(() => { throw new Error("logger unavailable"); });
      const onInterrupted = vi.fn();
      const options = { runId, eventStore, leaseStore, cancellationStore, onTerminal, onTerminalError, onInterrupted };
      await expect(reconcileInterruptedRun(options)).resolves.toBe("terminal");
      await expect(reconcileInterruptedRun(options)).resolves.toBe("terminal");
      expect(onTerminal).toHaveBeenCalledTimes(2);
      expect(onTerminal).toHaveBeenLastCalledWith(runId, terminal);
      expect(onTerminalError).toHaveBeenCalledOnce();
      expect(onInterrupted).not.toHaveBeenCalled();
      expect((await eventStore.listAfter(runId)).events).toHaveLength(2);
    });
  }

  it("projects newly interrupted failures through both compatible host callbacks", async () => {
    const eventStore = new InMemoryRunEventStore();
    await eventStore.append("new-orphan", { type: "run.started", data: {} });
    const onInterrupted = vi.fn().mockRejectedValue(new Error("legacy callback unavailable"));
    const onTerminal = vi.fn();
    await expect(reconcileInterruptedRun({
      runId: "new-orphan", eventStore, leaseStore: new InMemoryRunExecutionLeaseStore(),
      cancellationStore: new InMemoryRunCancellationStore(), onInterrupted, onTerminal,
    })).resolves.toBe("interrupted");
    expect(onInterrupted).toHaveBeenCalledOnce();
    expect(onTerminal).toHaveBeenCalledWith("new-orphan", expect.objectContaining({ type: "run.failed", data: expect.objectContaining({ code: "run_execution_interrupted" }) }));
  });

  it("requires the configured bearer API key", async () => {
    const app = runDeliveryRoutes(() => ({ resolveRunDelivery: async () => null }), ["secret"]);
    const denied = await app.request("/run-a/events");
    expect(denied.status).toBe(401);

    const allowed = await app.request("/run-a/events", {
      headers: { Authorization: "Bearer secret" },
    });
    expect(allowed.status).toBe(404);
  });

  it("returns 501 when the host has no durable run resolver", async () => {
    const response = await runDeliveryRoutes(() => ({})).request(
      "http://localhost/run-a/events",
    );
    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({ code: "RUN_DELIVERY_UNAVAILABLE" });
  });

  it("returns 404 without leaking an inaccessible run", async () => {
    const app = runDeliveryRoutes(() => ({ resolveRunDelivery: async () => null }));
    const events = await app.request("http://localhost/private/events");
    const cancel = await app.request(cancelRequest("private"));
    expect(events.status).toBe(404);
    expect(cancel.status).toBe(404);
  });

  it("replays canonical events after a query cursor and ends at terminal", async () => {
    const eventStore = new InMemoryRunEventStore();
    const cancellationStore = new InMemoryRunCancellationStore();
    const notifier = new InMemoryRunEventNotifier();
    const journal = new RunEventJournal(eventStore, notifier);
    await journal.append("run-a", { type: "run.started", data: {} });
    await journal.append("run-a", {
      type: "output.text.delta",
      data: { text: "hello" },
    });
    await journal.append("run-a", { type: "run.completed", data: {} });
    const app = runDeliveryRoutes(() => ({
      resolveRunDelivery: async (runId) => runId === "run-a"
        ? { eventStore, cancellationStore, notifier }
        : null,
    }));

    const response = await app.request("http://localhost/run-a/events?cursor=1");
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(body).not.toContain('"sequence":1');
    expect(body).toContain('"sequence":2');
    expect(body).toContain('"sequence":3');
    expect(body).toContain("id: 2");
    expect(body).toContain("id: 3");
  });

  it("accepts Last-Event-ID and rejects a conflicting query cursor", async () => {
    const eventStore = new InMemoryRunEventStore();
    const cancellationStore = new InMemoryRunCancellationStore();
    await eventStore.append("run-a", { type: "run.completed", data: {} });
    const app = runDeliveryRoutes(() => ({
      resolveRunDelivery: async () => ({ eventStore, cancellationStore }),
    }));

    const resumed = await app.request(new Request("http://localhost/run-a/events", {
      headers: { "last-event-id": "0" },
    }));
    expect(resumed.status).toBe(200);
    expect(await resumed.text()).toContain('"sequence":1');

    const conflict = await app.request(new Request("http://localhost/run-a/events?cursor=1", {
      headers: { "last-event-id": "2" },
    }));
    expect(conflict.status).toBe(400);
    expect(await conflict.json()).toMatchObject({ code: "RUN_CURSOR_CONFLICT" });
  });

  it("closes an already-acknowledged terminal stream and rejects ahead cursors", async () => {
    const eventStore = new InMemoryRunEventStore();
    const cancellationStore = new InMemoryRunCancellationStore();
    await eventStore.append("run-a", { type: "run.completed", data: {} });
    const app = runDeliveryRoutes(() => ({
      resolveRunDelivery: async () => ({ eventStore, cancellationStore }),
    }));

    const terminal = await app.request("http://localhost/run-a/events?cursor=1");
    expect(terminal.status).toBe(200);
    expect(terminal.headers.get("x-polpo-run-terminal")).toBe("true");
    expect(await terminal.text()).toBe("");

    const ahead = await app.request("http://localhost/run-a/events?cursor=2");
    expect(ahead.status).toBe(400);
    expect(await ahead.json()).toMatchObject({ code: "RUN_CURSOR_AHEAD" });
  });

  it("persists explicit cancellation idempotently", async () => {
    const eventStore = new InMemoryRunEventStore();
    const cancellationStore = new InMemoryRunCancellationStore();
    const app = runDeliveryRoutes(() => ({
      resolveRunDelivery: async () => ({ eventStore, cancellationStore }),
    }));

    const first = await app.request(cancelRequest("run-a", { reason: "user_request" }));
    const duplicate = await app.request(cancelRequest("run-a", { reason: "duplicate" }));
    expect(first.status).toBe(202);
    expect(duplicate.status).toBe(202);
    const persisted = await cancellationStore.get("run-a");
    expect(persisted?.reason).toBe("user_request");
    expect(await first.json()).toMatchObject({ ok: true, data: { runId: "run-a", accepted: true } });
    expect(await duplicate.json()).toMatchObject({ ok: true, data: { runId: "run-a", accepted: false } });
  });

  it("does not persist cancellation for an already terminal run", async () => {
    const eventStore = new InMemoryRunEventStore();
    const cancellationStore = new InMemoryRunCancellationStore();
    await eventStore.append("run-a", { type: "run.completed", data: {} });
    const app = runDeliveryRoutes(() => ({
      resolveRunDelivery: async () => ({ eventStore, cancellationStore }),
    }));

    const response = await app.request(cancelRequest("run-a", { reason: "too late" }));

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      ok: true,
      data: { runId: "run-a", accepted: false },
    });
    expect(await cancellationStore.get("run-a")).toBeNull();
  });

  it("terminalizes an ownerless started run as retryable exactly once", async () => {
    let now = new Date("2026-08-21T00:00:00.000Z");
    const eventStore = new InMemoryRunEventStore({ now: () => now });
    const leaseStore = new InMemoryRunExecutionLeaseStore({ now: () => now });
    const cancellationStore = new InMemoryRunCancellationStore();
    const notifier = new InMemoryRunEventNotifier();
    const journal = new RunEventJournal(eventStore, notifier);
    await leaseStore.claim("run-orphan", {
      owner: "worker-old",
      token: "attempt-old",
      expiresAt: "2026-08-21T00:00:30.000Z",
    });
    await journal.append("run-orphan", { type: "run.started", data: {} });
    now = new Date("2026-08-21T00:00:31.000Z");

    const first = await reconcileInterruptedRun({
      runId: "run-orphan",
      eventStore,
      leaseStore,
      cancellationStore,
      notifier,
      now: () => now,
      createToken: () => "recovery-a",
    });
    const duplicate = await reconcileInterruptedRun({
      runId: "run-orphan",
      eventStore,
      leaseStore,
      cancellationStore,
      notifier,
      now: () => now,
      createToken: () => "recovery-b",
    });

    expect(first).toBe("interrupted");
    expect(duplicate).toBe("terminal");
    const events = (await eventStore.listAfter("run-orphan")).events;
    expect(events.map((event) => event.type)).toEqual(["run.started", "run.failed"]);
    expect(events[1]?.data).toEqual({
      code: "run_execution_interrupted",
      message: "Run execution was interrupted before completion",
      retryable: true,
    });
    expect(await leaseStore.get("run-orphan")).toBeNull();
  });

  it("does not rewrite legacy history when an earlier terminal event has late events after it", async () => {
    const eventStore = new InMemoryRunEventStore();
    const leaseStore = new InMemoryRunExecutionLeaseStore();
    const cancellationStore = new InMemoryRunCancellationStore();
    await eventStore.append("run-polluted", { type: "run.started", data: {} });
    const terminal = await eventStore.append("run-polluted", {
      type: "run.completed",
      data: {},
    });
    await eventStore.append("run-polluted", {
      type: "output.text.delta",
      data: { text: "legacy late write" },
    });
    const original = (await eventStore.listAfter("run-polluted")).events;
    const onTerminal = vi.fn();

    await expect(reconcileInterruptedRun({
      runId: "run-polluted",
      eventStore,
      leaseStore,
      cancellationStore,
      onTerminal,
    })).resolves.toBe("terminal");

    expect(onTerminal).toHaveBeenCalledWith("run-polluted", terminal);
    expect((await eventStore.listAfter("run-polluted")).events).toEqual(original);
    expect(await leaseStore.get("run-polluted")).toBeNull();
  });

  it("serializes concurrent orphan reconcilers without duplicate terminal events", async () => {
    let now = new Date("2026-08-21T00:00:00.000Z");
    const eventStore = new InMemoryRunEventStore({ now: () => now });
    const leaseStore = new InMemoryRunExecutionLeaseStore({ now: () => now });
    const cancellationStore = new InMemoryRunCancellationStore();
    await leaseStore.claim("run-race", {
      owner: "worker-old",
      token: "attempt-old",
      expiresAt: "2026-08-21T00:00:01.000Z",
    });
    await eventStore.append("run-race", { type: "run.started", data: {} });
    now = new Date("2026-08-21T00:00:02.000Z");

    const results = await Promise.all([
      reconcileInterruptedRun({
        runId: "run-race",
        eventStore,
        leaseStore,
        cancellationStore,
        now: () => now,
        createToken: () => "recovery-a",
      }),
      reconcileInterruptedRun({
        runId: "run-race",
        eventStore,
        leaseStore,
        cancellationStore,
        now: () => now,
        createToken: () => "recovery-b",
      }),
    ]);

    expect(results).toContain("interrupted");
    expect((await eventStore.listAfter("run-race")).events.filter(
      (event) => event.type === "run.failed",
    )).toHaveLength(1);
  });

  it("does not terminalize a run while its owner lease is live", async () => {
    const now = new Date("2026-08-21T00:00:00.000Z");
    const eventStore = new InMemoryRunEventStore({ now: () => now });
    const leaseStore = new InMemoryRunExecutionLeaseStore({ now: () => now });
    await leaseStore.claim("run-live", {
      owner: "worker-live",
      token: "attempt-live",
      expiresAt: "2026-08-21T00:00:30.000Z",
    });
    await eventStore.append("run-live", { type: "run.started", data: {} });

    await expect(reconcileInterruptedRun({
      runId: "run-live",
      eventStore,
      leaseStore,
      cancellationStore: new InMemoryRunCancellationStore(),
      now: () => now,
      createToken: () => "must-not-claim",
    })).resolves.toBe("active");
    expect((await eventStore.listAfter("run-live")).events).toHaveLength(1);
  });

  it("does not terminalize event history that never reached run.started", async () => {
    const eventStore = new InMemoryRunEventStore();
    await eventStore.append("run-accepted", { type: "run.accepted", data: {} });

    await expect(reconcileInterruptedRun({
      runId: "run-accepted",
      eventStore,
      leaseStore: new InMemoryRunExecutionLeaseStore(),
      cancellationStore: new InMemoryRunCancellationStore(),
      createToken: () => "must-not-claim",
    })).resolves.toBe("not-started");
  });

  it("does not reconcile or append when only a retained lifecycle suffix remains", async () => {
    const retained = new InMemoryRunEventStore();
    await retained.append("run-retained-suffix", {
      type: "run.accepted",
      data: {},
    });
    const eventStore = {
      append: retained.append.bind(retained),
      appendMany: retained.appendMany.bind(retained),
      listAfter: retained.listAfter.bind(retained),
      bounds: async () => ({ firstCursor: "5", lastCursor: "5", count: 1 }),
    };
    const leaseStore = new InMemoryRunExecutionLeaseStore();

    await expect(reconcileInterruptedRun({
      runId: "run-retained-suffix",
      eventStore,
      leaseStore,
      cancellationStore: new InMemoryRunCancellationStore(),
    })).rejects.toBeInstanceOf(RunEventCursorExpiredError);

    expect((await retained.listAfter("run-retained-suffix")).events).toHaveLength(1);
    expect(await leaseStore.get("run-retained-suffix")).toBeNull();
  });

  it("runs host reconciliation after persisting the interrupted terminal event", async () => {
    let now = new Date("2026-08-21T00:00:00.000Z");
    const eventStore = new InMemoryRunEventStore({ now: () => now });
    const leaseStore = new InMemoryRunExecutionLeaseStore({ now: () => now });
    const cancellationStore = new InMemoryRunCancellationStore();
    await leaseStore.claim("run-host", {
      owner: "worker-old",
      token: "attempt-old",
      expiresAt: "2026-08-21T00:00:01.000Z",
    });
    await eventStore.append("run-host", { type: "run.started", data: {} });
    now = new Date("2026-08-21T00:00:02.000Z");
    const onInterrupted = vi.fn(async () => {
      const last = (await eventStore.listAfter("run-host")).events.at(-1);
      expect(last?.type).toBe("run.failed");
    });

    await reconcileInterruptedRun({
      runId: "run-host",
      eventStore,
      leaseStore,
      cancellationStore,
      now: () => now,
      createToken: () => "recovery",
      onInterrupted,
    });

    expect(onInterrupted).toHaveBeenCalledOnce();
  });

  it("retries host reconciliation from the durable terminal event without duplicating it", async () => {
    let now = new Date("2026-08-21T00:00:00.000Z");
    const eventStore = new InMemoryRunEventStore({ now: () => now });
    const leaseStore = new InMemoryRunExecutionLeaseStore({ now: () => now });
    await leaseStore.claim("run-host-failure", {
      owner: "worker-old",
      token: "attempt-old",
      expiresAt: "2026-08-21T00:00:01.000Z",
    });
    await eventStore.append("run-host-failure", { type: "run.started", data: {} });
    now = new Date("2026-08-21T00:00:02.000Z");

    const onInterrupted = vi.fn()
      .mockRejectedValueOnce(new Error("host store unavailable"))
      .mockResolvedValueOnce(undefined);
    const onInterruptedError = vi.fn();

    await expect(reconcileInterruptedRun({
      runId: "run-host-failure",
      eventStore,
      leaseStore,
      cancellationStore: new InMemoryRunCancellationStore(),
      now: () => now,
      createToken: () => "recovery",
      onInterrupted,
      onInterruptedError,
    })).resolves.toBe("interrupted");

    await expect(reconcileInterruptedRun({
      runId: "run-host-failure",
      eventStore,
      leaseStore,
      cancellationStore: new InMemoryRunCancellationStore(),
      now: () => now,
      createToken: () => "recovery-retry",
      onInterrupted,
      onInterruptedError,
    })).resolves.toBe("terminal");

    expect(onInterrupted).toHaveBeenCalledTimes(2);
    expect(onInterruptedError).toHaveBeenCalledOnce();
    expect(onInterruptedError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "host store unavailable" }),
      "run-host-failure",
    );
    expect((await eventStore.listAfter("run-host-failure")).events.map((event) => event.type))
      .toEqual(["run.started", "run.failed"]);
  });
});
