import { describe, expect, it } from "vitest";
import {
  InMemorySteeringController,
  InMemorySteeringRunRegistry,
  SteeringAbortError,
  SteeringClosedError,
  SteeringQueueFullError,
  SteeringRunConflictError,
  SteeringRunNotFoundError,
  SteeringValidationError,
} from "./steering.js";

describe("InMemorySteeringController", () => {
  it("keeps eligible messages in FIFO order and defers follow-ups", () => {
    const controller = new InMemorySteeringController();

    controller.enqueue({ id: "s1", mode: "steer", content: { text: "change direction" } });
    controller.enqueue({ id: "f1", mode: "follow_up", content: { text: "then summarize" } });
    controller.enqueue({ id: "s2", mode: "steer", content: { text: "use the API" } });

    expect(controller.drain({ includeFollowUps: false }).map((message) => message.id)).toEqual(["s1", "s2"]);
    expect(controller.snapshot().pending.map((message) => message.id)).toEqual(["f1"]);
    expect(controller.drain({ includeFollowUps: true }).map((message) => message.id)).toEqual(["f1"]);
  });

  it("deduplicates message ids across delivery and restore", () => {
    const controller = new InMemorySteeringController();
    const first = controller.enqueue({ id: "same", mode: "steer", content: { text: "first" } });
    const duplicate = controller.enqueue({ id: "same", mode: "steer", content: { text: "second" } });

    expect(first.accepted).toBe(true);
    expect(duplicate).toMatchObject({ accepted: false, duplicate: true });
    controller.drain({ includeFollowUps: false });

    const restored = InMemorySteeringController.fromSnapshot(controller.snapshot());
    expect(restored.enqueue({ id: "same", mode: "steer", content: { text: "third" } })).toMatchObject({
      accepted: false,
      duplicate: true,
    });
  });

  it("supports one-at-a-time delivery without reordering the queue", () => {
    const controller = new InMemorySteeringController({ delivery: "one-at-a-time" });
    controller.enqueue({ id: "s1", mode: "steer", content: { text: "one" } });
    controller.enqueue({ id: "s2", mode: "steer", content: { text: "two" } });

    expect(controller.drain({ includeFollowUps: false }).map((message) => message.id)).toEqual(["s1"]);
    expect(controller.drain({ includeFollowUps: false }).map((message) => message.id)).toEqual(["s2"]);
  });

  it("round-trips pending messages and delivery policy through JSON", () => {
    const controller = new InMemorySteeringController({ delivery: "one-at-a-time" });
    controller.enqueue({
      id: "with-file",
      mode: "follow_up",
      content: {
        text: "inspect this",
        attachments: [{ type: "image", url: "https://example.com/a.png", mediaType: "image/png" }],
      },
      metadata: { channel: "telegram" },
    });

    const serialized = JSON.stringify(controller.snapshot());
    const restored = InMemorySteeringController.fromSnapshot(JSON.parse(serialized));

    expect(restored.snapshot()).toEqual(controller.snapshot());
  });

  it("rejects empty, malformed, and oversized messages", () => {
    const controller = new InMemorySteeringController({ maxContentBytes: 16 });

    expect(() => controller.enqueue({ id: "empty", mode: "steer", content: {} })).toThrow(SteeringValidationError);
    expect(() => controller.enqueue({ id: "bad-url", mode: "steer", content: {
      attachments: [{ type: "file", url: "javascript:alert(1)" }],
    } })).toThrow(SteeringValidationError);
    expect(() => controller.enqueue({ id: "insecure-url", mode: "steer", content: {
      attachments: [{ type: "file", url: "http://example.com/private.txt" }],
    } })).toThrow(SteeringValidationError);
    expect(() => controller.enqueue({ id: "large", mode: "steer", content: { text: "x".repeat(100) } }))
      .toThrow(SteeringValidationError);
  });

  it("rejects non-JSON metadata and normalizes runtime-invalid input errors", () => {
    const controller = new InMemorySteeringController();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() => controller.enqueue({
      id: "cyclic",
      mode: "steer",
      content: { text: "hello" },
      metadata: cyclic as never,
    })).toThrow(SteeringValidationError);
    expect(() => controller.enqueue({
      id: 42,
      mode: "steer",
      content: { text: "hello" },
    } as never)).toThrow(SteeringValidationError);
  });

  it("enforces queue capacity without losing accepted messages", () => {
    const controller = new InMemorySteeringController({ maxPending: 1 });
    controller.enqueue({ id: "first", mode: "steer", content: { text: "one" } });

    expect(() => controller.enqueue({ id: "second", mode: "steer", content: { text: "two" } }))
      .toThrow(SteeringQueueFullError);
    expect(controller.snapshot().pending.map((message) => message.id)).toEqual(["first"]);
  });

  it("restores atomically when a snapshot contains malformed pending data", () => {
    const controller = new InMemorySteeringController();
    controller.enqueue({ id: "existing", mode: "steer", content: { text: "keep" } });
    const before = controller.snapshot();

    expect(() => controller.restore({
      ...before,
      pending: [
        ...before.pending,
        { id: "bad", mode: "steer", content: {}, createdAt: new Date().toISOString() },
      ],
    })).toThrow(SteeringValidationError);
    expect(controller.snapshot()).toEqual(before);
  });

  it("aborts once and rejects new messages after abort or close", () => {
    const controller = new InMemorySteeringController();
    controller.abort("user cancelled");
    controller.abort("ignored");

    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBe("user cancelled");
    expect(() => controller.enqueue({ id: "after-abort", mode: "steer", content: { text: "too late" } }))
      .toThrow(SteeringAbortError);

    controller.close();
    expect(() => controller.enqueue({ id: "late", mode: "steer", content: { text: "too late" } }))
      .toThrow(SteeringClosedError);
  });

  it("seals ingress atomically only after pending messages are drained", () => {
    const controller = new InMemorySteeringController();
    controller.enqueue({ id: "pending", mode: "steer", content: { text: "deliver me" } });

    expect(controller.sealIfIdle()).toBe(false);
    expect(controller.drain({ includeFollowUps: true })).toMatchObject([{ id: "pending" }]);
    expect(controller.sealIfIdle()).toBe(true);
    expect(controller.sealIfIdle()).toBe(true);
    expect(() => controller.enqueue({ id: "late", mode: "steer", content: { text: "too late" } }))
      .toThrow(SteeringClosedError);
  });
});

describe("InMemorySteeringRunRegistry", () => {
  it("routes messages and aborts to the controller registered for one run", async () => {
    const registry = new InMemorySteeringRunRegistry();
    const controller = new InMemorySteeringController();
    const unregister = registry.register("run-1", controller);

    await expect(registry.enqueue("run-1", {
      id: "message-1",
      mode: "steer",
      content: { text: "change direction" },
    })).resolves.toMatchObject({ accepted: true });
    expect(controller.snapshot().pending).toMatchObject([{ id: "message-1" }]);

    registry.abort("run-1", "stop now");
    expect(controller.signal.reason).toBe("stop now");
    unregister();
    await expect(registry.enqueue("run-1", {
      id: "late",
      mode: "steer",
      content: { text: "too late" },
    })).rejects.toBeInstanceOf(SteeringRunNotFoundError);
  });

  it("rejects run-id collisions and stale unregister callbacks cannot remove replacements", async () => {
    const registry = new InMemorySteeringRunRegistry();
    const first = new InMemorySteeringController();
    const unregisterFirst = registry.register("same-run", first);

    expect(() => registry.register("same-run", new InMemorySteeringController()))
      .toThrow(SteeringRunConflictError);
    unregisterFirst();

    const second = new InMemorySteeringController();
    registry.register("same-run", second);
    unregisterFirst();
    await registry.enqueue("same-run", {
      id: "current",
      mode: "steer",
      content: { text: "still registered" },
    });
    expect(second.snapshot().pending).toMatchObject([{ id: "current" }]);
  });

  it("bounds active runs", () => {
    const registry = new InMemorySteeringRunRegistry({ maxActiveRuns: 1 });
    registry.register("run-1", new InMemorySteeringController());
    expect(() => registry.register("run-2", new InMemorySteeringController()))
      .toThrow(SteeringRunConflictError);
  });
});
