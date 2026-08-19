import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_RUN_EVENT_BATCH_SIZE,
  RunDeliveryValidationError,
  RunEventConflictError,
} from "@polpo-ai/core/run-delivery";
import { createSqliteStores, type DrizzleStores } from "../index.js";
import { migrateSqliteSchema } from "../sqlite-migrator.js";
import { runExecutionLeasesSqlite } from "../schema/index.js";
import { DrizzleRunExecutionLeaseStore } from "../stores/index.js";

process.env.POLPO_VAULT_KEY = randomBytes(32).toString("hex");

let sqlite: InstanceType<typeof Database>;
let db: ReturnType<typeof drizzle>;
let stores: DrizzleStores;

beforeEach(async () => {
  sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  db = drizzle(sqlite);
  await migrateSqliteSchema(db);
  stores = createSqliteStores(db);
});

afterEach(() => {
  sqlite.close();
});

describe("DrizzleRunEventStore", () => {
  it("persists ordered events and resumes strictly after the supplied cursor", async () => {
    await stores.runEventStore.append("run-a", { type: "run.started", data: {} });
    await stores.runEventStore.append("run-a", {
      type: "output.text.delta",
      data: { text: "hello" },
    });
    await stores.runEventStore.append("run-a", {
      type: "run.completed",
      data: { finishReason: "stop" },
    });

    const first = await stores.runEventStore.listAfter("run-a", undefined, 2);
    expect(first.events.map((event) => [event.sequence, event.type])).toEqual([
      [1, "run.started"],
      [2, "output.text.delta"],
    ]);
    expect(first.nextCursor).toBe("2");
    expect(first.hasMore).toBe(true);

    const second = await stores.runEventStore.listAfter("run-a", first.nextCursor, 2);
    expect(second.events.map((event) => event.sequence)).toEqual([3]);
    expect(second.nextCursor).toBe("3");
    expect(second.hasMore).toBe(false);
    expect(await stores.runEventStore.bounds("run-a")).toEqual({
      firstCursor: "1",
      lastCursor: "3",
      count: 3,
    });
  });

  it("isolates run-local cursors and producer ids", async () => {
    await stores.runEventStore.append("run-a", {
      id: "provider-event",
      type: "tool.completed",
      data: { result: "left" },
    });
    await stores.runEventStore.append("run-b", {
      id: "provider-event",
      type: "tool.completed",
      data: { result: "right" },
    });

    expect((await stores.runEventStore.listAfter("run-a")).events[0]?.sequence).toBe(1);
    expect((await stores.runEventStore.listAfter("run-b")).events[0]?.sequence).toBe(1);
  });

  it("deduplicates identical producer retries and rejects changed content", async () => {
    const input = {
      id: "stable-result",
      type: "tool.completed" as const,
      data: { toolCallId: "call-1", result: { ok: true } },
      createdAt: "2026-08-19T10:00:00.000Z",
    };

    const first = await stores.runEventStore.append("run-a", input);
    await expect(stores.runEventStore.append("run-a", input)).resolves.toEqual(first);
    await expect(stores.runEventStore.append("run-a", {
      ...input,
      data: { toolCallId: "call-1", result: { ok: false } },
    })).rejects.toBeInstanceOf(RunEventConflictError);
    expect((await stores.runEventStore.listAfter("run-a")).events).toHaveLength(1);
  });

  it("deduplicates a later retry when the producer omitted createdAt", async () => {
    let now = new Date("2026-08-19T10:00:00.000Z");
    const { runEventSequencesSqlite, runStreamEventsSqlite } = await import("../schema/index.js");
    const { DrizzleRunEventStore } = await import("../stores/index.js");
    const store = new DrizzleRunEventStore(db, {
      sequences: runEventSequencesSqlite,
      events: runStreamEventsSqlite,
    }, "sqlite", { now: () => now });
    const input = {
      id: "stable-result",
      type: "tool.completed" as const,
      data: { result: "done" },
    };
    const first = await store.append("run-a", input);
    now = new Date("2026-08-19T10:01:00.000Z");

    await expect(store.append("run-a", input)).resolves.toEqual(first);
    expect((await store.listAfter("run-a")).events).toHaveLength(1);
  });

  it("serializes concurrent writers without duplicate run-local sequences", async () => {
    const appended = await Promise.all(
      Array.from({ length: 50 }, (_, index) => stores.runEventStore.append("run-a", {
        id: `event-${index}`,
        type: "output.text.delta",
        data: { text: String(index) },
      })),
    );

    expect(new Set(appended.map((event) => event.sequence)).size).toBe(50);
    expect((await stores.runEventStore.listAfter("run-a", undefined, 50)).events).toHaveLength(50);
  });

  it("allocates one contiguous sequence range for an ordered event batch", async () => {
    const batch = await stores.runEventStore.appendMany!("run-a", [
      { type: "response.chunk", data: { data: "one" } },
      { type: "response.chunk", data: { data: "two" } },
      { type: "response.done", data: { data: "[DONE]" } },
    ]);
    const next = await stores.runEventStore.append("run-a", {
      type: "run.completed",
      data: {},
    });

    expect(batch.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(next.sequence).toBe(4);
    expect((await stores.runEventStore.listAfter("run-a")).events.map(
      (event) => event.type,
    )).toEqual([
      "response.chunk",
      "response.chunk",
      "response.done",
      "run.completed",
    ]);
  });

  it("keeps batch and single-writer sequence allocation collision-free", async () => {
    const [batch, single] = await Promise.all([
      stores.runEventStore.appendMany!("run-a", [
        { type: "response.chunk", data: { data: "one" } },
        { type: "response.chunk", data: { data: "two" } },
        { type: "response.chunk", data: { data: "three" } },
      ]),
      stores.runEventStore.append("run-a", {
        type: "tool.completed",
        data: { result: "done" },
      }),
    ]);
    const sequences = [...batch.map((event) => event.sequence), single.sequence];

    expect(new Set(sequences).size).toBe(4);
    expect(sequences.toSorted((left, right) => left - right)).toEqual([1, 2, 3, 4]);
    expect((await stores.runEventStore.listAfter("run-a")).events).toHaveLength(4);
  });

  it("keeps explicit producer retry semantics on the batch compatibility path", async () => {
    const input = {
      id: "stable-batch-event",
      type: "tool.completed" as const,
      data: { result: "done" },
      createdAt: "2026-08-19T10:00:00.000Z",
    };

    const first = await stores.runEventStore.appendMany!("run-a", [input]);
    const retry = await stores.runEventStore.appendMany!("run-a", [input]);

    expect(retry).toEqual(first);
    expect((await stores.runEventStore.listAfter("run-a")).events).toHaveLength(1);
  });

  it("rejects oversized batches before allocating a sequence range", async () => {
    const oversized = Array.from({ length: MAX_RUN_EVENT_BATCH_SIZE + 1 }, () => ({
      type: "response.chunk" as const,
      data: { data: "x" },
    }));

    await expect(stores.runEventStore.appendMany!("run-a", oversized))
      .rejects.toBeInstanceOf(RunDeliveryValidationError);
    expect(await stores.runEventStore.bounds("run-a")).toBeNull();
  });
});

describe("DrizzleRunExecutionLeaseStore", () => {
  const first = {
    owner: "worker-a",
    token: "token-a",
    expiresAt: "2026-08-19T10:05:00.000Z",
  };

  it("allows one active owner and an idempotent identical claim", async () => {
    const leaseStore = new DrizzleRunExecutionLeaseStore(
      db,
      runExecutionLeasesSqlite,
      { now: () => new Date("2026-08-19T10:00:00.000Z") },
    );

    await expect(leaseStore.claim("run-a", first)).resolves.toBe(true);
    await expect(leaseStore.claim("run-a", first)).resolves.toBe(true);
    await expect(leaseStore.claim("run-a", {
      owner: "worker-b",
      token: "token-b",
      expiresAt: first.expiresAt,
    })).resolves.toBe(false);
    await expect(leaseStore.get("run-a")).resolves.toEqual(first);
  });

  it("permits takeover at expiry and rejects stale release", async () => {
    let now = new Date("2026-08-19T10:00:00.000Z");
    const leaseStore = new DrizzleRunExecutionLeaseStore(
      db,
      runExecutionLeasesSqlite,
      { now: () => now },
    );
    await leaseStore.claim("run-a", first);
    now = new Date(first.expiresAt);

    const takeover = {
      owner: "worker-b",
      token: "token-b",
      expiresAt: "2026-08-19T10:20:00.000Z",
    };
    await expect(leaseStore.claim("run-a", takeover)).resolves.toBe(true);
    await expect(leaseStore.release("run-a", first)).resolves.toBe(false);
    await expect(leaseStore.release("run-a", takeover)).resolves.toBe(true);
    await expect(leaseStore.get("run-a")).resolves.toBeNull();
  });

  it("exposes the lease store through the standard store bundle", async () => {
    const lease = {
      owner: "worker-a",
      token: "token-a",
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    await expect(stores.runExecutionLeaseStore.claim("run-a", lease)).resolves.toBe(true);
    await expect(stores.runExecutionLeaseStore.get("run-a")).resolves.toEqual(lease);
  });
});

describe("DrizzleRunCancellationStore", () => {
  it("persists the first request idempotently and clears it after terminalization", async () => {
    const first = {
      requestedAt: "2026-08-19T10:00:00.000Z",
      reason: "user_request",
    };
    await expect(stores.runCancellationStore.request("run-a", first)).resolves.toEqual(first);
    await expect(stores.runCancellationStore.request("run-a", {
      requestedAt: "2026-08-19T10:01:00.000Z",
      reason: "duplicate",
    })).resolves.toEqual(first);
    await expect(stores.runCancellationStore.get("run-a")).resolves.toEqual(first);
    await expect(stores.runCancellationStore.clear("run-a")).resolves.toBe(true);
    await expect(stores.runCancellationStore.clear("run-a")).resolves.toBe(false);
    await expect(stores.runCancellationStore.get("run-a")).resolves.toBeNull();
  });
});
