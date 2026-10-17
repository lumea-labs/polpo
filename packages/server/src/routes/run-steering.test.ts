import { describe, expect, it } from "vitest";
import {
  InMemorySteeringController,
  InMemorySteeringRunRegistry,
} from "@polpo-ai/core/steering";
import { runSteeringRoutes } from "./run-steering.js";

function request(path: string, body?: unknown, method = "POST") {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("runSteeringRoutes", () => {
  it("returns 501 when the host does not provide a steering registry", async () => {
    const response = await runSteeringRoutes(() => ({})).request(
      request("/run-1/steering", {
        id: "message-1",
        mode: "steer",
        content: { text: "change direction" },
      }),
    );

    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({ code: "STEERING_UNAVAILABLE" });
  });

  it("accepts and deduplicates steering messages for an active run", async () => {
    const registry = new InMemorySteeringRunRegistry();
    const controller = new InMemorySteeringController();
    registry.register("run-1", controller);
    const app = runSteeringRoutes(() => ({ steeringRegistry: registry }));
    const body = {
      id: "message-1",
      mode: "steer",
      content: { text: "change direction" },
      metadata: { channel: "telegram" },
    };

    const accepted = await app.request(request("/run-1/steering", body));
    const duplicate = await app.request(request("/run-1/steering", body));

    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({
      ok: true,
      data: {
        runId: "run-1",
        id: "message-1",
        accepted: true,
        duplicate: false,
        receipt: { admission: "accepted", delivery: "pending", policySource: "platform" },
      },
    });
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({
      data: { accepted: false, duplicate: true },
    });
    expect(controller.snapshot().pending).toHaveLength(1);
  });

  it("returns localized rejection and archived delivery receipts", async () => {
    const registry = new InMemorySteeringRunRegistry();
    const rejected = new InMemorySteeringController({
      policy: {
        acceptance: "reject",
        source: "agent",
        outcomes: {
          rejected: { action: "reply", messages: { en: "Cannot accept this now", it: "Non posso accettarlo ora" } },
        },
      },
    });
    const unregister = registry.register("run-1", rejected);
    const app = runSteeringRoutes(() => ({ steeringRegistry: registry }));

    const response = await app.request(request("/run-1/steering", {
      id: "message-1",
      mode: "steer",
      locale: "it-IT",
      content: { text: "change" },
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { receipt: {
        admission: "rejected",
        delivery: "cancelled",
        selectedLocale: "it",
        response: { action: "reply", text: "Non posso accettarlo ora" },
      } },
    });

    await unregister();
    const receipt = await app.request(request("/run-1/steering/message-1", undefined, "GET"));
    expect(receipt.status).toBe(200);
    expect(await receipt.json()).toMatchObject({ data: { receipt: { admission: "rejected" } } });
  });

  it("returns 404 for an unknown receipt", async () => {
    const app = runSteeringRoutes(() => ({ steeringRegistry: new InMemorySteeringRunRegistry() }));
    const response = await app.request(request("/run-1/steering/missing", undefined, "GET"));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "STEERING_RECEIPT_NOT_FOUND" });
  });

  it("maps validation, missing-run, closed-run, and queue pressure errors", async () => {
    const registry = new InMemorySteeringRunRegistry();
    const full = new InMemorySteeringController({ maxPending: 1 });
    full.enqueue({ id: "first", mode: "steer", content: { text: "first" } });
    registry.register("full", full);
    const closed = new InMemorySteeringController();
    closed.close();
    registry.register("closed", closed);
    const app = runSteeringRoutes(() => ({ steeringRegistry: registry }));

    const malformed = await app.request(request("/full/steering", {
      id: "bad",
      mode: "steer",
      content: {},
    }));
    const missing = await app.request(request("/missing/steering", {
      id: "new",
      mode: "steer",
      content: { text: "hello" },
    }));
    const noCapacity = await app.request(request("/full/steering", {
      id: "second",
      mode: "steer",
      content: { text: "second" },
    }));
    const inactive = await app.request(request("/closed/steering", {
      id: "late",
      mode: "steer",
      content: { text: "late" },
    }));

    expect(malformed.status).toBe(400);
    expect(missing.status).toBe(404);
    expect(noCapacity.status).toBe(429);
    expect(inactive.status).toBe(409);
  });

  it("aborts an active run and rejects later messages", async () => {
    const registry = new InMemorySteeringRunRegistry();
    const controller = new InMemorySteeringController();
    registry.register("run-1", controller);
    const app = runSteeringRoutes(() => ({ steeringRegistry: registry }));

    const aborted = await app.request(request("/run-1/abort", { reason: "user cancelled" }));
    const late = await app.request(request("/run-1/steering", {
      id: "late",
      mode: "steer",
      content: { text: "late" },
    }));

    expect(aborted.status).toBe(202);
    expect(controller.signal).toMatchObject({ aborted: true, reason: "user cancelled" });
    expect(late.status).toBe(409);
  });
});
