import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InMemoryScheduleStore,
  ScheduleConflictError,
  type CreateScheduleInput,
  type Schedule,
  type ScheduleLease,
  type ScheduleRun,
} from "@polpo-ai/core/scheduling";
import {
  LocalScheduleDriver,
  LocalScheduleWorker,
  type LocalScheduleRunHandler,
} from "./local-schedule-driver.js";

function input(
  overrides: Partial<CreateScheduleInput> = {},
): CreateScheduleInput {
  return {
    id: "schedule-1",
    timing: {
      kind: "cron",
      expression: "* * * * *",
      timezone: "UTC",
    },
    invocation: {
      surface: "agent",
      agentName: "assistant",
      input: { prompt: "Run" },
    },
    policy: {
      catchUp: "skip",
      misfireGraceSeconds: 300,
      maxConcurrency: 1,
    },
    ...overrides,
  };
}

function fixture() {
  let clock = new Date("2026-07-28T10:00:00.000Z");
  let sequence = 0;
  const store = new InMemoryScheduleStore({
    now: () => clock,
    createId: (kind) => `${kind}-${++sequence}`,
  });
  return {
    store,
    now: () => clock,
    setNow(value: string) {
      clock = new Date(value);
    },
    advance(milliseconds: number) {
      clock = new Date(clock.getTime() + milliseconds);
    },
  };
}

function handler(
  implementation?: LocalScheduleRunHandler,
): LocalScheduleRunHandler {
  return vi.fn(
    implementation ?? (async () => ({
      status: "succeeded" as const,
      references: { runtimeId: "runtime-1" },
    })),
  );
}

function worker(
  state: ReturnType<typeof fixture>,
  runHandler: LocalScheduleRunHandler,
  overrides: Partial<ConstructorParameters<typeof LocalScheduleWorker>[0]> = {},
) {
  return new LocalScheduleWorker({
    store: state.store,
    handler: runHandler,
    workerId: "worker-1",
    now: state.now,
    createLeaseToken: () => "lease-1",
    ...overrides,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("LocalScheduleDriver", () => {
  it("returns deterministic local registration without external side effects", async () => {
    const state = fixture();
    const schedule = await state.store.create(input());
    const driver = new LocalScheduleDriver({ now: state.now });

    await expect(driver.register(schedule)).resolves.toEqual({
      kind: "local",
      status: "registered",
      providerId: "local:schedule-1",
      updatedAt: "2026-07-28T10:00:00.000Z",
    });
    await expect(driver.pause(schedule)).resolves.toBeUndefined();
    await expect(driver.resume(schedule)).resolves.toBeUndefined();
    await expect(driver.delete(schedule)).resolves.toBeUndefined();
  });
});

describe("LocalScheduleWorker", () => {
  it("persists the next occurrence before any work is due", async () => {
    const state = fixture();
    await state.store.create(input());
    const runHandler = handler();

    const result = await worker(state, runHandler).tick();

    expect(result).toMatchObject({
      materialized: 0,
      dispatched: 0,
      failed: 0,
    });
    expect(await state.store.get("schedule-1")).toMatchObject({
      nextOccurrenceAt: "2026-07-28T10:01:00.000Z",
    });
    expect(runHandler).not.toHaveBeenCalled();
  });

  it("materializes, leases, dispatches, and completes a due occurrence", async () => {
    const state = fixture();
    await state.store.create(input());
    const runHandler = handler();
    const localWorker = worker(state, runHandler);
    await localWorker.tick();
    state.advance(60_000);

    const result = await localWorker.tick();

    expect(result).toMatchObject({
      materialized: 1,
      dispatched: 1,
      succeeded: 1,
    });
    expect(runHandler).toHaveBeenCalledTimes(1);
    expect(await state.store.listRuns()).toMatchObject([
      {
        status: "succeeded",
        occurrenceAt: "2026-07-28T10:01:00.000Z",
        attempts: 1,
        references: { runtimeId: "runtime-1" },
      },
    ]);
    expect(await state.store.get("schedule-1")).toMatchObject({
      lastOccurrenceAt: "2026-07-28T10:01:00.000Z",
      nextOccurrenceAt: "2026-07-28T10:02:00.000Z",
    });
  });

  it("deduplicates concurrent ticks from independent workers", async () => {
    const state = fixture();
    const created = await state.store.create(input());
    await state.store.updateOperationalState(created.id, {
      nextOccurrenceAt: "2026-07-28T10:00:00.000Z",
    });
    const runHandler = handler();
    const first = worker(state, runHandler, {
      workerId: "worker-1",
      createLeaseToken: () => "lease-1",
    });
    const second = worker(state, runHandler, {
      workerId: "worker-2",
      createLeaseToken: () => "lease-2",
    });

    await Promise.all([first.tick(), second.tick()]);

    expect(await state.store.listRuns()).toHaveLength(1);
    expect(runHandler).toHaveBeenCalledTimes(1);
  });

  it("recovers after a crash between run creation and occurrence CAS", async () => {
    const state = fixture();
    const created = await state.store.create(input());
    await state.store.updateOperationalState(created.id, {
      nextOccurrenceAt: "2026-07-28T10:00:00.000Z",
    });
    const originalUpdate = state.store.updateOperationalState.bind(state.store);
    let failOnce = true;
    state.store.updateOperationalState = async (...args) => {
      if (failOnce && args[1].lastOccurrenceAt) {
        failOnce = false;
        throw new ScheduleConflictError("simulated crash");
      }
      return originalUpdate(...args);
    };
    const runHandler = handler();
    const localWorker = worker(state, runHandler);

    await expect(localWorker.tick()).resolves.toMatchObject({ conflicts: 1 });
    expect(await state.store.listRuns()).toHaveLength(1);
    expect(runHandler).toHaveBeenCalledTimes(1);
    await localWorker.tick();

    expect(await state.store.listRuns()).toHaveLength(1);
    expect(runHandler).toHaveBeenCalledTimes(1);
    expect(await state.store.get(created.id)).toMatchObject({
      lastOccurrenceAt: "2026-07-28T10:00:00.000Z",
      nextOccurrenceAt: "2026-07-28T10:01:00.000Z",
    });
  });

  it("records an expired occurrence as skipped without dispatching", async () => {
    const state = fixture();
    const created = await state.store.create(input({
      policy: {
        catchUp: "skip",
        misfireGraceSeconds: 30,
        maxConcurrency: 1,
      },
    }));
    await state.store.updateOperationalState(created.id, {
      nextOccurrenceAt: "2026-07-28T09:58:00.000Z",
    });
    state.setNow("2026-07-28T10:00:45.000Z");
    const runHandler = handler();

    const result = await worker(state, runHandler).tick();

    expect(result.skipped).toBe(3);
    expect(runHandler).not.toHaveBeenCalled();
    expect((await state.store.listRuns()).every((run) => run.status === "skipped"))
      .toBe(true);
  });

  it("dispatches only the latest due occurrence under latest catch-up", async () => {
    const state = fixture();
    const created = await state.store.create(input({
      policy: {
        catchUp: "latest",
        misfireGraceSeconds: 600,
        maxConcurrency: 1,
      },
    }));
    await state.store.updateOperationalState(created.id, {
      nextOccurrenceAt: "2026-07-28T09:58:00.000Z",
    });
    const runHandler = handler();

    await worker(state, runHandler).tick();

    const runs = await state.store.listRuns();
    expect(runs).toHaveLength(3);
    expect(runs.filter((run) => run.status === "succeeded")).toMatchObject([
      { occurrenceAt: "2026-07-28T10:00:00.000Z" },
    ]);
    expect(runs.filter((run) => run.status === "skipped")).toHaveLength(2);
    expect(runHandler).toHaveBeenCalledTimes(1);
  });

  it("jumps directly to the latest occurrence when backlog exceeds the batch", async () => {
    const state = fixture();
    const created = await state.store.create(input({
      policy: {
        catchUp: "latest",
        misfireGraceSeconds: 600,
        maxConcurrency: 1,
      },
    }));
    await state.store.updateOperationalState(created.id, {
      nextOccurrenceAt: "2026-07-28T09:55:00.000Z",
    });
    const runHandler = handler();

    await worker(state, runHandler, {
      maxOccurrencesPerSchedulePerTick: 2,
    }).tick();

    expect(await state.store.listRuns()).toMatchObject([
      {
        occurrenceAt: "2026-07-28T10:00:00.000Z",
        status: "succeeded",
      },
    ]);
    expect(runHandler).toHaveBeenCalledTimes(1);
  });

  it("defers pending work when max concurrency is already reached", async () => {
    const state = fixture();
    const created = await state.store.create(input());
    const active = await state.store.createRun({
      scheduleId: created.id,
      occurrenceAt: "2026-07-28T09:59:00.000Z",
      triggerId: "active",
      idempotencyKey: "active",
    });
    await state.store.claimRun(active.id, {
      owner: "other-worker",
      token: "other-lease",
      expiresAt: "2026-07-28T10:01:00.000Z",
    });
    await state.store.updateOperationalState(created.id, {
      nextOccurrenceAt: "2026-07-28T10:00:00.000Z",
    });
    const runHandler = handler();

    const result = await worker(state, runHandler).tick();

    expect(result.deferred).toBe(1);
    expect(runHandler).not.toHaveBeenCalled();
    expect((await state.store.listRuns({ status: "pending" }))).toHaveLength(1);
  });

  it("does not dispatch if a schedule is paused after claim", async () => {
    const state = fixture();
    const created = await state.store.create(input());
    await state.store.updateOperationalState(created.id, {
      nextOccurrenceAt: "2026-07-28T10:00:00.000Z",
    });
    const originalClaim = state.store.claimRun.bind(state.store);
    state.store.claimRun = async (id: string, currentLease: ScheduleLease) => {
      const claimed = await originalClaim(id, currentLease);
      if (claimed) await state.store.update(created.id, { status: "paused" });
      return claimed;
    };
    const runHandler = handler();

    const result = await worker(state, runHandler).tick();

    expect(result.deferred).toBe(1);
    expect(runHandler).not.toHaveBeenCalled();
    expect((await state.store.listRuns())[0]).toMatchObject({
      status: "pending",
    });
  });

  it("does not dispatch if a schedule is deleted after claim", async () => {
    const state = fixture();
    const created = await state.store.create(input());
    await state.store.updateOperationalState(created.id, {
      nextOccurrenceAt: "2026-07-28T10:00:00.000Z",
    });
    const originalClaim = state.store.claimRun.bind(state.store);
    state.store.claimRun = async (id: string, currentLease: ScheduleLease) => {
      const claimed = await originalClaim(id, currentLease);
      if (claimed) await state.store.markDeleted(created.id);
      return claimed;
    };
    const runHandler = handler();

    const result = await worker(state, runHandler).tick();

    expect(result.deferred).toBe(1);
    expect(runHandler).not.toHaveBeenCalled();
    expect((await state.store.listRuns())[0]).toMatchObject({
      status: "pending",
    });
    expect(await state.store.get(created.id)).toMatchObject({
      status: "deleted",
    });
  });

  it("releases a run when the injected handler throws", async () => {
    const state = fixture();
    const created = await state.store.create(input());
    await state.store.updateOperationalState(created.id, {
      nextOccurrenceAt: "2026-07-28T10:00:00.000Z",
    });
    const runHandler = handler(async () => {
      throw new Error("temporary provider failure");
    });

    const result = await worker(state, runHandler).tick();

    expect(result.failed).toBe(1);
    expect(await state.store.listRuns()).toMatchObject([
      { status: "pending", attempts: 1 },
    ]);
  });

  it("reclaims expired claimed work after restart", async () => {
    const state = fixture();
    const created = await state.store.create(input());
    const run = await state.store.createRun({
      scheduleId: created.id,
      occurrenceAt: "2026-07-28T10:00:00.000Z",
      triggerId: "local:schedule-1:2026-07-28T10:00[UTC]",
      idempotencyKey: "schedule:schedule-1:2026-07-28T10:00[UTC]",
    });
    await state.store.claimRun(run.id, {
      owner: "crashed-worker",
      token: "stale",
      expiresAt: "2026-07-28T10:00:01.000Z",
    });
    state.advance(1_001);
    const runHandler = handler();

    await worker(state, runHandler).tick();

    expect(runHandler).toHaveBeenCalledTimes(1);
    expect(await state.store.getRun(run.id)).toMatchObject({
      status: "succeeded",
      attempts: 2,
    });
  });

  it("renews the lease while a long handler is still running", async () => {
    vi.useFakeTimers();
    const state = fixture();
    const created = await state.store.create(input());
    await state.store.updateOperationalState(created.id, {
      nextOccurrenceAt: "2026-07-28T10:00:00.000Z",
    });
    let finish: (() => void) | undefined;
    const runHandler = handler(() =>
      new Promise((resolve) => {
        finish = () => resolve({
          status: "succeeded",
          references: {},
        });
      })
    );
    const localWorker = worker(state, runHandler, {
      leaseDurationMs: 1_000,
    });

    const pendingTick = localWorker.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(runHandler).toHaveBeenCalledTimes(1);
    state.advance(400);
    await vi.advanceTimersByTimeAsync(400);

    expect((await state.store.listRuns())[0].lease?.expiresAt)
      .toBe("2026-07-28T10:00:01.400Z");
    finish?.();
    await pendingTick;
  });

  it("does not duplicate work when the wall clock moves backward", async () => {
    const state = fixture();
    await state.store.create(input());
    const runHandler = handler();
    const localWorker = worker(state, runHandler);
    await localWorker.tick();
    state.setNow("2026-07-28T09:59:00.000Z");

    await localWorker.tick();

    expect(await state.store.listRuns()).toEqual([]);
    expect(await state.store.get("schedule-1")).toMatchObject({
      nextOccurrenceAt: "2026-07-28T10:01:00.000Z",
    });
    state.setNow("2026-07-28T10:01:00.000Z");
    await localWorker.tick();
    expect(runHandler).toHaveBeenCalledTimes(1);
  });

  it("processes the oldest pending run first when a tick is bounded", async () => {
    const state = fixture();
    const created = await state.store.create(input({
      policy: {
        catchUp: "skip",
        misfireGraceSeconds: 600,
        maxConcurrency: 1,
      },
    }));
    for (const minute of [58, 59]) {
      await state.store.createRun({
        scheduleId: created.id,
        occurrenceAt: `2026-07-28T09:${minute}:00.000Z`,
        triggerId: `delivery-${minute}`,
        idempotencyKey: `key-${minute}`,
      });
    }
    const runHandler = handler();

    await worker(state, runHandler, { maxRunsPerTick: 1 }).tick();

    expect(runHandler).toHaveBeenCalledTimes(1);
    expect(runHandler).toHaveBeenCalledWith(expect.objectContaining({
      run: expect.objectContaining({
        occurrenceAt: "2026-07-28T09:58:00.000Z",
      }),
    }));
  });

  it("never dispatches an older latest-policy run outside the bounded window", async () => {
    const state = fixture();
    const created = await state.store.create(input({
      policy: {
        catchUp: "latest",
        misfireGraceSeconds: 600,
        maxConcurrency: 1,
      },
    }));
    for (const minute of [58, 59]) {
      await state.store.createRun({
        scheduleId: created.id,
        occurrenceAt: `2026-07-28T09:${minute}:00.000Z`,
        triggerId: `delivery-${minute}`,
        idempotencyKey: `key-${minute}`,
      });
    }
    const runHandler = handler();
    const localWorker = worker(state, runHandler, { maxRunsPerTick: 1 });

    const first = await localWorker.tick();

    expect(first).toMatchObject({ skipped: 1, dispatched: 0 });
    expect(runHandler).not.toHaveBeenCalled();
    expect(await state.store.listRuns({ order: "asc" })).toMatchObject([
      { occurrenceAt: "2026-07-28T09:58:00.000Z", status: "skipped" },
      { occurrenceAt: "2026-07-28T09:59:00.000Z", status: "pending" },
    ]);

    const second = await localWorker.tick();

    expect(second).toMatchObject({ succeeded: 1, dispatched: 1 });
    expect(runHandler).toHaveBeenCalledTimes(1);
    expect(runHandler).toHaveBeenCalledWith(expect.objectContaining({
      run: expect.objectContaining({
        occurrenceAt: "2026-07-28T09:59:00.000Z",
      }),
    }));
  });

  it("fails closed when persisted next occurrence no longer matches timing", async () => {
    const state = fixture();
    const created = await state.store.create(input());
    await state.store.updateOperationalState(created.id, {
      nextOccurrenceAt: "2026-07-28T10:00:30.000Z",
    });
    state.setNow("2026-07-28T10:01:00.000Z");
    const onError = vi.fn();

    const result = await worker(state, handler(), { onError }).tick();

    expect(result).toMatchObject({ failed: 1, dispatched: 0 });
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/does not match/i) }),
      expect.objectContaining({
        phase: "materialize",
        scheduleId: created.id,
      }),
    );
  });

  it("completes a one-time schedule only after its run is terminal", async () => {
    const state = fixture();
    await state.store.create(input({
      timing: {
        kind: "once",
        at: "2026-07-28T10:01:00.000Z",
        timezone: "UTC",
      },
    }));
    const runHandler = handler();
    const localWorker = worker(state, runHandler);
    await localWorker.tick();
    state.advance(60_000);

    await localWorker.tick();

    expect(await state.store.get("schedule-1")).toMatchObject({
      status: "completed",
      lastOccurrenceAt: "2026-07-28T10:01:00.000Z",
    });
    expect((await state.store.get("schedule-1"))?.nextOccurrenceAt).toBeUndefined();
  });

  it("fails closed on an invalid worker clock", async () => {
    const state = fixture();
    await state.store.create(input());
    const localWorker = worker(state, handler(), {
      now: () => "not-a-date",
    });

    await expect(localWorker.tick()).rejects.toThrow(/clock/i);
  });

  it("prevents overlapping ticks on the same worker instance", async () => {
    const state = fixture();
    const created = await state.store.create(input());
    await state.store.updateOperationalState(created.id, {
      nextOccurrenceAt: "2026-07-28T10:00:00.000Z",
    });
    let resolveHandler: (() => void) | undefined;
    const runHandler = handler(() =>
      new Promise((resolve) => {
        resolveHandler = () => resolve({
          status: "succeeded",
          references: {},
        });
      })
    );
    const localWorker = worker(state, runHandler);
    const first = localWorker.tick();
    await vi.waitFor(() => expect(runHandler).toHaveBeenCalledTimes(1));

    await expect(localWorker.tick()).resolves.toMatchObject({ alreadyRunning: true });
    resolveHandler?.();
    await first;
  });
});
