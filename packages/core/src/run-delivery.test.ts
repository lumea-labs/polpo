import { describe, expect, it } from "vitest";
import {
  InMemoryRunEventStore,
  InMemoryRunExecutionLeaseStore,
  RunDeliveryValidationError,
  RunEventConflictError,
  RunEventCursorError,
  RunExecutionLeaseValidationError,
  parseRunEventCursor,
  resolveRunDeliveryPolicy,
} from "./run-delivery.js";

describe("run delivery policy", () => {
  it("preserves attached cancellation when the policy is omitted", () => {
    expect(resolveRunDeliveryPolicy()).toEqual({ onDisconnect: "cancel" });
    expect(resolveRunDeliveryPolicy({})).toEqual({ onDisconnect: "cancel" });
  });

  it("accepts the explicit durable policy without retaining caller objects", () => {
    const input = { onDisconnect: "continue" as const };
    const resolved = resolveRunDeliveryPolicy(input);

    expect(resolved).toEqual({ onDisconnect: "continue" });
    expect(resolved).not.toBe(input);
  });

  it.each([
    null,
    "continue",
    [],
    { onDisconnect: "later" },
    { onDisconnect: true },
    { onDisconnect: "continue", retention: "forever" },
  ])("rejects malformed or unbounded delivery policy %#", (value) => {
    expect(() => resolveRunDeliveryPolicy(value as never)).toThrow(
      RunDeliveryValidationError,
    );
  });
});

describe("InMemoryRunExecutionLeaseStore", () => {
  const first = {
    owner: "worker-a",
    token: "token-a",
    expiresAt: "2026-08-19T10:05:00.000Z",
  };

  it("allows one owner and makes an identical claim idempotent", async () => {
    const store = new InMemoryRunExecutionLeaseStore({
      now: () => new Date("2026-08-19T10:00:00.000Z"),
    });

    expect(await store.claim("run-a", first)).toBe(true);
    expect(await store.claim("run-a", first)).toBe(true);
    expect(await store.claim("run-a", {
      owner: "worker-b",
      token: "token-b",
      expiresAt: "2026-08-19T10:05:00.000Z",
    })).toBe(false);
    expect(await store.get("run-a")).toEqual(first);
  });

  it("renews only the exact active owner token", async () => {
    const store = new InMemoryRunExecutionLeaseStore({
      now: () => new Date("2026-08-19T10:00:00.000Z"),
    });
    await store.claim("run-a", first);

    expect(await store.renew("run-a", {
      ...first,
      expiresAt: "2026-08-19T10:10:00.000Z",
    })).toBe(true);
    expect(await store.renew("run-a", {
      owner: "worker-a",
      token: "stale-token",
      expiresAt: "2026-08-19T10:15:00.000Z",
    })).toBe(false);
    expect((await store.get("run-a"))?.expiresAt).toBe("2026-08-19T10:10:00.000Z");
  });

  it("allows takeover at expiry and prevents the stale owner from releasing it", async () => {
    let now = new Date("2026-08-19T10:00:00.000Z");
    const store = new InMemoryRunExecutionLeaseStore({ now: () => now });
    await store.claim("run-a", first);
    now = new Date(first.expiresAt);

    const takeover = {
      owner: "worker-b",
      token: "token-b",
      expiresAt: "2026-08-19T10:20:00.000Z",
    };
    expect(await store.claim("run-a", takeover)).toBe(true);
    expect(await store.release("run-a", first)).toBe(false);
    expect(await store.get("run-a")).toEqual(takeover);
    expect(await store.release("run-a", takeover)).toBe(true);
    expect(await store.get("run-a")).toBeNull();
  });

  it.each([
    ["", first],
    ["run-a", { ...first, owner: "" }],
    ["run-a", { ...first, token: "" }],
    ["run-a", { ...first, expiresAt: "invalid" }],
    ["run-a", { ...first, expiresAt: "2026-08-19T10:00:00.000Z" }],
  ])("rejects malformed or already-expired leases %#", async (runId, lease) => {
    const store = new InMemoryRunExecutionLeaseStore({
      now: () => new Date("2026-08-19T10:00:00.000Z"),
    });
    await expect(store.claim(runId, lease)).rejects.toThrow(
      RunExecutionLeaseValidationError,
    );
  });
});

describe("run event cursors", () => {
  it.each([
    [undefined, 0],
    ["", 0],
    ["0", 0],
    ["1", 1],
    ["9007199254740991", Number.MAX_SAFE_INTEGER],
  ])("parses cursor %j", (cursor, expected) => {
    expect(parseRunEventCursor(cursor)).toBe(expected);
  });

  it.each(["-1", "+1", "01", "1.2", "1e3", "NaN", "Infinity", " 1 "])(
    "rejects ambiguous cursor %j",
    (cursor) => {
      expect(() => parseRunEventCursor(cursor)).toThrow(RunEventCursorError);
    },
  );
});

describe("InMemoryRunEventStore", () => {
  it("assigns ordered run-scoped sequences and paginates strictly after a cursor", async () => {
    const store = new InMemoryRunEventStore({
      now: () => new Date("2026-08-19T10:00:00.000Z"),
    });

    await store.append("run-a", { type: "run.started", data: {} });
    await store.append("run-a", {
      type: "output.text.delta",
      data: { text: "hello" },
    });
    await store.append("run-a", {
      type: "run.completed",
      data: { finishReason: "stop" },
    });

    const first = await store.listAfter("run-a", undefined, 2);
    expect(first.events.map((event) => [event.id, event.sequence, event.type])).toEqual([
      ["1", 1, "run.started"],
      ["2", 2, "output.text.delta"],
    ]);
    expect(first.nextCursor).toBe("2");
    expect(first.hasMore).toBe(true);

    const second = await store.listAfter("run-a", first.nextCursor, 2);
    expect(second.events.map((event) => event.id)).toEqual(["3"]);
    expect(second.nextCursor).toBe("3");
    expect(second.hasMore).toBe(false);
  });

  it("keeps runs isolated even when they use the same producer event id", async () => {
    const store = new InMemoryRunEventStore();

    const left = await store.append("run-a", {
      id: "provider-event",
      type: "tool.completed",
      data: { tool: "left" },
    });
    const right = await store.append("run-b", {
      id: "provider-event",
      type: "tool.completed",
      data: { tool: "right" },
    });

    expect(left.sequence).toBe(1);
    expect(right.sequence).toBe(1);
    expect((await store.listAfter("run-a")).events[0]?.data).toEqual({ tool: "left" });
    expect((await store.listAfter("run-b")).events[0]?.data).toEqual({ tool: "right" });
  });

  it("returns the existing event for an identical producer retry", async () => {
    const store = new InMemoryRunEventStore();
    const input = {
      id: "stable-tool-result",
      type: "tool.completed" as const,
      data: { toolCallId: "call-1", result: { ok: true } },
      createdAt: "2026-08-19T10:00:00.000Z",
    };

    const first = await store.append("run-a", input);
    const retried = await store.append("run-a", {
      ...input,
      data: { toolCallId: "call-1", result: { ok: true } },
    });

    expect(retried).toEqual(first);
    expect((await store.listAfter("run-a")).events).toHaveLength(1);
  });

  it("deduplicates a later producer retry when createdAt was server-generated", async () => {
    let now = new Date("2026-08-19T10:00:00.000Z");
    const store = new InMemoryRunEventStore({ now: () => now });
    const input = {
      id: "stable-tool-result",
      type: "tool.completed" as const,
      data: { toolCallId: "call-1", result: { ok: true } },
    };
    const first = await store.append("run-a", input);
    now = new Date("2026-08-19T10:01:00.000Z");

    await expect(store.append("run-a", input)).resolves.toEqual(first);
    expect((await store.listAfter("run-a")).events).toHaveLength(1);
  });

  it("fails closed when a producer reuses an event id with different content", async () => {
    const store = new InMemoryRunEventStore();
    await store.append("run-a", {
      id: "stable-id",
      type: "output.text.delta",
      data: { text: "one" },
    });

    await expect(store.append("run-a", {
      id: "stable-id",
      type: "output.text.delta",
      data: { text: "two" },
    })).rejects.toBeInstanceOf(RunEventConflictError);
  });

  it("serializes concurrent append calls without duplicate sequences", async () => {
    const store = new InMemoryRunEventStore();
    const events = await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        store.append("run-a", {
          id: `event-${index}`,
          type: "output.text.delta",
          data: { text: String(index) },
        })),
    );

    expect(events.map((event) => event.sequence).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 100 }, (_, index) => index + 1),
    );
    expect((await store.bounds("run-a"))).toEqual({
      firstCursor: "1",
      lastCursor: "100",
      count: 100,
    });
  });

  it.each([
    ["", { type: "run.started", data: {} }],
    ["run-a", { type: "", data: {} }],
    ["run-a", { type: "run.started", data: { invalid: undefined } }],
    ["run-a", { type: "run.started", data: { invalid: Number.NaN } }],
  ])("rejects malformed event input %#", async (runId, event) => {
    const store = new InMemoryRunEventStore();
    await expect(store.append(runId, event as never)).rejects.toThrow(
      RunDeliveryValidationError,
    );
  });
});
