import { describe, expect, it } from "vitest";
import { MemoryLoopRunStore } from "./run-store.js";

describe("MemoryLoopRunStore", () => {
  it("persists loop run status, context, and trace events", async () => {
    const store = new MemoryLoopRunStore();
    const run = await store.createRun({
      id: "run-1",
      loop: { name: "coding-flow" },
      agentName: "engineer",
      user: "user-1",
    });

    expect(run).toMatchObject({
      id: "run-1",
      loopName: "coding-flow",
      agentName: "engineer",
      status: "running",
    });

    await store.appendTrace("run-1", {
      id: "trace-1",
      type: "loop.start",
      ts: "2026-06-13T00:00:00.000Z",
      loop: "coding-flow",
      status: "started",
    });
    await store.appendTrace("run-1", {
      id: "trace-2",
      type: "sandbox.acquired",
      ts: "2026-06-13T00:00:00.100Z",
      sandboxId: "sb-1",
      operation: "acquire",
      source: "pool",
    });
    await store.updateRun("run-1", {
      status: "completed",
      context: { build: { passed: true } },
      completedAt: "2026-06-13T00:00:01.000Z",
    });

    const fetched = await store.getRun("run-1");
    expect(fetched?.trace).toHaveLength(2);
    expect(fetched?.trace[1]).toMatchObject({
      type: "sandbox.acquired",
      sandboxId: "sb-1",
      source: "pool",
    });
    expect(fetched?.context).toEqual({ build: { passed: true } });
    expect(await store.listRuns({ status: "completed" })).toHaveLength(1);
  });

  it("allows exactly one concurrent conditional update for the same run version", async () => {
    const store = new MemoryLoopRunStore();
    const created = await store.createRun({
      id: "run-cas",
      loop: { name: "coding-flow" },
      metadata: { deliveryRunId: "delivery-1" },
    });
    const expected = {
      status: created.status,
      updatedAt: created.updatedAt,
      deliveryRunId: "delivery-1",
    } as const;

    const attempts = await Promise.all([
      store.updateRunIfCurrent("run-cas", expected, { error: "sweeper-a" }),
      store.updateRunIfCurrent("run-cas", expected, { error: "sweeper-b" }),
    ]);

    expect(attempts.filter(Boolean)).toHaveLength(1);
    expect(attempts.filter(Boolean)[0]?.updatedAt.localeCompare(created.updatedAt)).toBe(1);
    expect(["sweeper-a", "sweeper-b"]).toContain((await store.getRun("run-cas"))?.error);
  });

  it("rejects a stale conditional update after status changes", async () => {
    const store = new MemoryLoopRunStore();
    const created = await store.createRun({
      id: "run-status",
      loop: { name: "coding-flow" },
      metadata: { deliveryRunId: "delivery-1" },
    });
    await store.updateRun("run-status", { status: "completed" });

    await expect(store.updateRunIfCurrent("run-status", {
      status: created.status,
      updatedAt: created.updatedAt,
      deliveryRunId: "delivery-1",
    }, { status: "failed", error: "stale sweep" })).resolves.toBeUndefined();
    expect((await store.getRun("run-status"))?.status).toBe("completed");
  });

  it("rejects a stale conditional update after delivery ownership changes", async () => {
    const store = new MemoryLoopRunStore();
    const created = await store.createRun({
      id: "run-delivery",
      loop: { name: "coding-flow" },
      metadata: { deliveryRunId: "delivery-1" },
    });
    await store.updateRun("run-delivery", {
      metadata: { deliveryRunId: "delivery-2" },
    });

    await expect(store.updateRunIfCurrent("run-delivery", {
      status: created.status,
      updatedAt: created.updatedAt,
      deliveryRunId: "delivery-1",
    }, { status: "failed", error: "stale sweep" })).resolves.toBeUndefined();
    expect((await store.getRun("run-delivery"))?.metadata?.deliveryRunId).toBe("delivery-2");
  });

  it("treats an undefined expected delivery id as absent rather than unconstrained", async () => {
    const store = new MemoryLoopRunStore();
    const absent = await store.createRun({
      id: "run-no-delivery",
      loop: { name: "coding-flow" },
    });
    const present = await store.createRun({
      id: "run-with-delivery",
      loop: { name: "coding-flow" },
      metadata: { deliveryRunId: "delivery-1" },
    });

    await expect(store.updateRunIfCurrent("run-no-delivery", {
      status: absent.status,
      updatedAt: absent.updatedAt,
      deliveryRunId: undefined,
    }, { error: "claimed" })).resolves.toMatchObject({ error: "claimed" });
    await expect(store.updateRunIfCurrent("run-with-delivery", {
      status: present.status,
      updatedAt: present.updatedAt,
      deliveryRunId: undefined,
    }, { error: "must-not-win" })).resolves.toBeUndefined();
  });
});
