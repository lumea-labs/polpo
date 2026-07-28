import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type {
  CreateScheduleInput,
  ScheduleLease,
} from "@polpo-ai/core/scheduling";
import {
  ScheduleConflictError,
  ScheduleInvalidStateError,
} from "@polpo-ai/core/scheduling";
import { SQLiteScheduleStore } from "./sqlite-schedule-store.js";

const tempDirs: string[] = [];

async function tempDatabase(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "polpo-schedules-"));
  tempDirs.push(directory);
  return join(directory, "schedules.db");
}

function input(overrides: Partial<CreateScheduleInput> = {}): CreateScheduleInput {
  return {
    timing: {
      kind: "cron",
      expression: "0 9 * * *",
      timezone: "UTC",
    },
    invocation: {
      surface: "task",
      agentName: "assistant",
      title: "Daily summary",
      prompt: "Summarize the day",
    },
    ...overrides,
  };
}

function lease(
  now: Date,
  owner = "worker-1",
  token = "token-1",
  durationMs = 60_000,
): ScheduleLease {
  return {
    owner,
    token,
    expiresAt: new Date(now.getTime() + durationMs).toISOString(),
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("SQLiteScheduleStore", () => {
  it("persists schedules and runs across independent store instances", async () => {
    const path = await tempDatabase();
    const now = new Date("2026-07-28T10:00:00.000Z");
    const first = await SQLiteScheduleStore.open(path, {
      now: () => now,
      createId: (kind) => `${kind}-fixed`,
    });
    const schedule = await first.create(input());
    const run = await first.createRun({
      scheduleId: schedule.id,
      occurrenceAt: "2026-07-28T11:00:00.000Z",
      triggerId: "delivery-1",
      idempotencyKey: "key-1",
    });
    first.close();

    const reopened = await SQLiteScheduleStore.open(path, { now: () => now });
    expect(await reopened.get(schedule.id)).toEqual(schedule);
    expect(await reopened.getRun(run.id)).toEqual(run);
    reopened.close();
  });

  it("deduplicates provider delivery across store instances", async () => {
    const path = await tempDatabase();
    const now = new Date("2026-07-28T10:00:00.000Z");
    const first = await SQLiteScheduleStore.open(path, { now: () => now });
    const second = await SQLiteScheduleStore.open(path, { now: () => now });
    const schedule = await first.create(input({ id: "schedule-1" }));
    const runInput = {
      scheduleId: schedule.id,
      occurrenceAt: "2026-07-28T11:00:00.000Z",
      triggerId: "delivery-1",
      idempotencyKey: "stable-key",
    };

    const [a, b] = await Promise.all([
      first.createRun(runInput),
      second.createRun(runInput),
    ]);
    expect(a.id).toBe(b.id);
    expect(await first.listRuns({ scheduleId: schedule.id })).toHaveLength(1);
    first.close();
    second.close();
  });

  it("uses revision CAS across independent store instances", async () => {
    const path = await tempDatabase();
    const now = new Date("2026-07-28T10:00:00.000Z");
    const first = await SQLiteScheduleStore.open(path, { now: () => now });
    const second = await SQLiteScheduleStore.open(path, { now: () => now });
    const schedule = await first.create(input({ id: "schedule-1" }));

    await first.update(
      schedule.id,
      { status: "paused" },
      { expectedRevision: 1 },
    );
    await expect(second.update(
      schedule.id,
      { description: "stale" },
      { expectedRevision: 1 },
    )).rejects.toBeInstanceOf(ScheduleConflictError);
    first.close();
    second.close();
  });

  it("persists operational timing and driver registration with revision CAS", async () => {
    const path = await tempDatabase();
    const now = new Date("2026-07-28T10:00:00.000Z");
    const store = await SQLiteScheduleStore.open(path, { now: () => now });
    const schedule = await store.create(input({ id: "schedule-1" }));
    const updated = await store.updateOperationalState(
      schedule.id,
      {
        nextOccurrenceAt: "2026-07-28T11:00:00Z",
        driver: {
          kind: "local",
          status: "registered",
          providerId: "local:schedule-1",
          updatedAt: "2026-07-28T10:00:00Z",
        },
      },
      { expectedRevision: 1 },
    );
    store.close();

    const reopened = await SQLiteScheduleStore.open(path, { now: () => now });
    expect(await reopened.get(schedule.id)).toEqual(updated);
    await expect(reopened.updateOperationalState(
      schedule.id,
      { nextOccurrenceAt: null },
      { expectedRevision: 1 },
    )).rejects.toBeInstanceOf(ScheduleConflictError);
    reopened.close();
  });

  it("allows only one active lease and reclaims it after expiry", async () => {
    const path = await tempDatabase();
    let now = new Date("2026-07-28T10:00:00.000Z");
    const first = await SQLiteScheduleStore.open(path, { now: () => now });
    const second = await SQLiteScheduleStore.open(path, { now: () => now });
    const schedule = await first.create(input({ id: "schedule-1" }));
    const run = await first.createRun({
      scheduleId: schedule.id,
      occurrenceAt: "2026-07-28T11:00:00.000Z",
      triggerId: "delivery-1",
      idempotencyKey: "key-1",
    });
    const oldLease = lease(now, "worker-1", "token-1", 1_000);
    expect(await first.claimRun(run.id, oldLease)).not.toBeNull();
    expect(await second.claimRun(
      run.id,
      lease(now, "worker-2", "token-2"),
    )).toBeNull();

    now = new Date(now.getTime() + 1_001);
    const newLease = lease(now, "worker-2", "token-2");
    expect(await second.claimRun(run.id, newLease)).toMatchObject({
      attempts: 2,
      lease: newLease,
    });
    await expect(first.completeRun(run.id, {
      lease: oldLease,
      status: "succeeded",
      references: {},
    })).rejects.toBeInstanceOf(ScheduleConflictError);
    first.close();
    second.close();
  });

  it("enforces max concurrency atomically across store instances", async () => {
    const path = await tempDatabase();
    const now = new Date("2026-07-28T10:00:00.000Z");
    const first = await SQLiteScheduleStore.open(path, { now: () => now });
    const second = await SQLiteScheduleStore.open(path, { now: () => now });
    const schedule = await first.create(input({
      id: "schedule-1",
      policy: { maxConcurrency: 1 },
    }));
    const firstRun = await first.createRun({
      scheduleId: schedule.id,
      occurrenceAt: "2026-07-28T11:00:00.000Z",
      triggerId: "delivery-1",
      idempotencyKey: "key-1",
    });
    const secondRun = await first.createRun({
      scheduleId: schedule.id,
      occurrenceAt: "2026-07-28T12:00:00.000Z",
      triggerId: "delivery-2",
      idempotencyKey: "key-2",
    });

    const [a, b] = await Promise.all([
      first.claimRun(firstRun.id, lease(now, "worker-1", "token-1")),
      second.claimRun(secondRun.id, lease(now, "worker-2", "token-2")),
    ]);

    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await first.countActiveRuns(schedule.id)).toBe(1);
    first.close();
    second.close();
  });

  it("atomically rejects starting a claimed run after pause", async () => {
    const path = await tempDatabase();
    const now = new Date("2026-07-28T10:00:00.000Z");
    const first = await SQLiteScheduleStore.open(path, { now: () => now });
    const second = await SQLiteScheduleStore.open(path, { now: () => now });
    const schedule = await first.create(input({ id: "schedule-1" }));
    const run = await first.createRun({
      scheduleId: schedule.id,
      occurrenceAt: "2026-07-28T11:00:00.000Z",
      triggerId: "delivery-1",
      idempotencyKey: "key-1",
    });
    const currentLease = lease(now);
    await first.claimRun(run.id, currentLease);
    await second.update(schedule.id, { status: "paused" });

    await expect(
      first.startRun(run.id, currentLease),
    ).rejects.toBeInstanceOf(ScheduleInvalidStateError);
    expect(await second.getRun(run.id)).toMatchObject({
      status: "claimed",
      lease: currentLease,
    });
    first.close();
    second.close();
  });

  it("persists lease renewal, start, release, and terminal completion", async () => {
    const path = await tempDatabase();
    const now = new Date("2026-07-28T10:00:00.000Z");
    const store = await SQLiteScheduleStore.open(path, { now: () => now });
    const schedule = await store.create(input({ id: "schedule-1" }));
    const run = await store.createRun({
      scheduleId: schedule.id,
      occurrenceAt: "2026-07-28T11:00:00.000Z",
      triggerId: "delivery-1",
      idempotencyKey: "key-1",
    });
    const firstLease = lease(now);
    await store.claimRun(run.id, firstLease);
    const renewed = lease(now, firstLease.owner, firstLease.token, 120_000);
    expect(await store.renewLease(run.id, renewed)).toBe(true);
    await store.startRun(run.id, renewed);
    expect(await store.countActiveRuns(schedule.id)).toBe(1);
    await store.releaseRun(run.id, renewed);
    const retryLease = lease(now, "worker-2", "token-2");
    await store.claimRun(run.id, retryLease);
    await store.startRun(run.id, retryLease);
    const completed = await store.completeRun(run.id, {
      lease: retryLease,
      status: "succeeded",
      references: { taskId: "task-1" },
      result: { accepted: true },
    });

    expect(completed).toMatchObject({
      status: "succeeded",
      attempts: 2,
      references: { taskId: "task-1" },
      result: { accepted: true },
    });
    expect(await store.countActiveRuns(schedule.id)).toBe(0);
    store.close();
  });

  it("fails closed on corrupted persisted JSON", async () => {
    const path = await tempDatabase();
    const now = new Date("2026-07-28T10:00:00.000Z");
    const store = await SQLiteScheduleStore.open(path, { now: () => now });
    const schedule = await store.create(input({ id: "schedule-1" }));
    store.close();

    const sqlite = new Database(path);
    sqlite.prepare(
      "UPDATE polpo_schedules_v2 SET data = ? WHERE id = ?",
    ).run("{not-json", schedule.id);
    sqlite.close();

    const reopened = await SQLiteScheduleStore.open(path, { now: () => now });
    await expect(reopened.get(schedule.id)).rejects.toBeInstanceOf(
      ScheduleInvalidStateError,
    );
    reopened.close();
  });

  it("does not modify an existing non-schedule SQLite database schema", async () => {
    const path = await tempDatabase();
    const sqlite = new Database(path);
    sqlite.exec("CREATE TABLE app_data (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
    sqlite.prepare("INSERT INTO app_data (id, value) VALUES (?, ?)").run("1", "keep");
    sqlite.close();

    const store = await SQLiteScheduleStore.open(path);
    store.close();
    const reopened = new Database(path, { readonly: true });
    expect(
      reopened.prepare("SELECT value FROM app_data WHERE id = ?").get("1"),
    ).toEqual({ value: "keep" });
    reopened.close();
  });

  it("recovers cleanly when an unrelated temporary file exists", async () => {
    const path = await tempDatabase();
    await writeFile(`${path}.tmp`, "partial", "utf8");
    const store = await SQLiteScheduleStore.open(path);
    await store.create(input({ id: "schedule-1" }));
    store.close();
    expect(await readFile(`${path}.tmp`, "utf8")).toBe("partial");
  });
});
