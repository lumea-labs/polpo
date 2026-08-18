import { describe, expect, it } from "vitest";
import {
  InMemoryRunCancellationStore,
  InMemoryRunEventStore,
} from "@polpo-ai/core/run-delivery";
import {
  InMemoryRunEventNotifier,
  RunEventJournal,
} from "@polpo-ai/core/run-delivery-follower";
import { runDeliveryRoutes } from "./run-delivery.js";

function cancelRequest(runId: string, body: unknown = {}) {
  return new Request(`http://localhost/${runId}/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("runDeliveryRoutes", () => {
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
});
