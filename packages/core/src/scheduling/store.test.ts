import { describe, expect, it } from "vitest";
import {
  InMemoryScheduleStore,
  ScheduleConflictError,
  ScheduleInvalidStateError,
  ScheduleNotFoundError,
  type CreateScheduleInput,
  type ScheduleLease,
} from "./index.js";

function scheduleInput(
  overrides: Partial<CreateScheduleInput> = {},
): CreateScheduleInput {
  return {
    name: "Daily summary",
    timing: {
      kind: "cron",
      expression: "0 9 * * 1-5",
      timezone: "UTC",
    },
    invocation: {
      surface: "agent",
      agentName: "assistant",
      input: { prompt: "Summarize yesterday" },
    },
    ...overrides,
  };
}

function createFixture() {
  let clock = new Date("2026-07-28T10:00:00.000Z");
  let sequence = 0;
  const store = new InMemoryScheduleStore({
    now: () => clock,
    createId: (kind) => `${kind}-${++sequence}`,
  });
  return {
    store,
    now: () => clock,
    advance(ms: number) {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

function lease(
  fixture: ReturnType<typeof createFixture>,
  owner = "worker-1",
  token = "lease-1",
  durationMs = 60_000,
): ScheduleLease {
  return {
    owner,
    token,
    expiresAt: new Date(fixture.now().getTime() + durationMs).toISOString(),
  };
}

describe("InMemoryScheduleStore schedule conformance", () => {
  it("creates normalized detached schedule records", async () => {
    const fixture = createFixture();
    const input = scheduleInput({
      name: " Daily summary ",
      metadata: { owner: "ops" },
    });
    const created = await fixture.store.create(input);

    expect(created).toMatchObject({
      id: "schedule-1",
      name: "Daily summary",
      status: "active",
      policy: {
        catchUp: "skip",
        misfireGraceSeconds: 300,
        maxConcurrency: 1,
      },
      revision: 1,
      createdAt: "2026-07-28T10:00:00.000Z",
      updatedAt: "2026-07-28T10:00:00.000Z",
    });

    (input.metadata as Record<string, string>).owner = "changed";
    created.metadata.owner = "changed-again";
    expect((await fixture.store.get(created.id))?.metadata).toEqual({ owner: "ops" });
  });

  it("rejects duplicate ids and lists by status and surface", async () => {
    const fixture = createFixture();
    await fixture.store.create(scheduleInput({ id: "fixed" }));
    await expect(
      fixture.store.create(scheduleInput({ id: "fixed" })),
    ).rejects.toBeInstanceOf(ScheduleConflictError);
    await fixture.store.create(scheduleInput({
      status: "paused",
      invocation: {
        surface: "webhook",
        webhookId: "hook-1",
      },
    }));

    expect(await fixture.store.list({ status: ["active"] })).toHaveLength(1);
    expect(await fixture.store.list({ surface: "webhook" })).toHaveLength(1);
    expect(await fixture.store.list({ includeDeleted: true })).toHaveLength(2);
  });

  it("uses optimistic revisions and deterministic lifecycle transitions", async () => {
    const fixture = createFixture();
    const created = await fixture.store.create(scheduleInput());
    fixture.advance(1_000);

    const paused = await fixture.store.update(
      created.id,
      { status: "paused", description: "Temporarily disabled" },
      { expectedRevision: 1 },
    );
    expect(paused).toMatchObject({
      status: "paused",
      description: "Temporarily disabled",
      revision: 2,
      updatedAt: "2026-07-28T10:00:01.000Z",
    });

    await expect(
      fixture.store.update(created.id, { status: "active" }, { expectedRevision: 1 }),
    ).rejects.toBeInstanceOf(ScheduleConflictError);

    const completed = await fixture.store.update(
      created.id,
      { status: "completed" },
      { expectedRevision: 2 },
    );
    await expect(
      fixture.store.update(completed.id, { status: "active" }),
    ).rejects.toThrow(/transition/i);
  });

  it("soft deletes schedules and keeps them addressable for audit", async () => {
    const fixture = createFixture();
    const created = await fixture.store.create(scheduleInput());
    await fixture.store.markDeleted(created.id, { expectedRevision: 1 });

    expect(await fixture.store.list()).toEqual([]);
    expect(await fixture.store.list({ includeDeleted: true })).toHaveLength(1);
    expect(await fixture.store.get(created.id)).toMatchObject({
      status: "deleted",
      revision: 2,
    });
    await expect(fixture.store.markDeleted(created.id)).resolves.toBeUndefined();
    await expect(
      fixture.store.update(created.id, { status: "paused" }),
    ).rejects.toThrow(/deleted/i);
  });

  it("reports missing schedules consistently", async () => {
    const fixture = createFixture();
    await expect(
      fixture.store.update("missing", { status: "paused" }),
    ).rejects.toBeInstanceOf(ScheduleNotFoundError);
    await expect(
      fixture.store.markDeleted("missing"),
    ).rejects.toBeInstanceOf(ScheduleNotFoundError);
  });

  it("updates driver and occurrence state through a separate CAS surface", async () => {
    const fixture = createFixture();
    const schedule = await fixture.store.create(scheduleInput());
    const updated = await fixture.store.updateOperationalState(
      schedule.id,
      {
        nextOccurrenceAt: "2026-07-28T11:00:00Z",
        lastOccurrenceAt: "2026-07-28T09:00:00Z",
        driver: {
          kind: "local",
          status: "registered",
          providerId: "local:schedule-1",
          metadata: { generation: 1 },
          updatedAt: "2026-07-28T10:00:00Z",
        },
      },
      { expectedRevision: 1 },
    );

    expect(updated).toMatchObject({
      nextOccurrenceAt: "2026-07-28T11:00:00.000Z",
      lastOccurrenceAt: "2026-07-28T09:00:00.000Z",
      driver: {
        kind: "local",
        status: "registered",
        providerId: "local:schedule-1",
        metadata: { generation: 1 },
        updatedAt: "2026-07-28T10:00:00.000Z",
      },
      revision: 2,
    });
    await expect(fixture.store.updateOperationalState(
      schedule.id,
      { nextOccurrenceAt: null },
      { expectedRevision: 1 },
    )).rejects.toBeInstanceOf(ScheduleConflictError);

    const cleared = await fixture.store.updateOperationalState(
      schedule.id,
      { nextOccurrenceAt: null, driver: null },
      { expectedRevision: 2 },
    );
    expect(cleared.nextOccurrenceAt).toBeUndefined();
    expect(cleared.driver).toBeUndefined();
  });

  it("rejects malformed driver state instead of storing provider drift", async () => {
    const fixture = createFixture();
    const schedule = await fixture.store.create(scheduleInput());
    await expect(fixture.store.updateOperationalState(schedule.id, {
      driver: {
        kind: "local",
        status: "registered",
        updatedAt: "2026-07-28T10:00:00Z",
      } as any,
    })).rejects.toThrow(/providerId/i);
    await expect(fixture.store.updateOperationalState(schedule.id, {
      futureState: true,
    } as any)).rejects.toThrow(/futureState/);
  });
});

describe("InMemoryScheduleStore run conformance", () => {
  it("creates one run for a stable idempotency key", async () => {
    const fixture = createFixture();
    const schedule = await fixture.store.create(scheduleInput());
    const input = {
      scheduleId: schedule.id,
      occurrenceAt: "2026-07-28T11:00:00.000Z",
      triggerId: "provider-delivery-1",
      idempotencyKey: `${schedule.id}:2026-07-28T11:00:00.000Z`,
    };

    const [first, duplicate] = await Promise.all([
      fixture.store.createRun(input),
      fixture.store.createRun(input),
    ]);

    expect(first.id).toBe(duplicate.id);
    expect(first).toMatchObject({
      scheduleId: schedule.id,
      status: "pending",
      attempts: 0,
      references: {},
    });
    expect(await fixture.store.listRuns({ scheduleId: schedule.id })).toHaveLength(1);
  });

  it("rejects reuse of an idempotency key for a different occurrence", async () => {
    const fixture = createFixture();
    const schedule = await fixture.store.create(scheduleInput());
    await fixture.store.createRun({
      scheduleId: schedule.id,
      occurrenceAt: "2026-07-28T11:00:00.000Z",
      triggerId: "delivery-1",
      idempotencyKey: "stable-key",
    });

    await expect(fixture.store.createRun({
      scheduleId: schedule.id,
      occurrenceAt: "2026-07-28T12:00:00.000Z",
      triggerId: "delivery-2",
      idempotencyKey: "stable-key",
    })).rejects.toBeInstanceOf(ScheduleConflictError);
  });

  it("does not accept new runs for paused, completed, or deleted schedules", async () => {
    const states = ["paused", "completed", "deleted"] as const;
    for (const status of states) {
      const fixture = createFixture();
      const schedule = await fixture.store.create(scheduleInput({
        status: status === "paused" ? "paused" : "active",
      }));
      if (status === "completed") {
        await fixture.store.update(schedule.id, { status });
      }
      if (status === "deleted") {
        await fixture.store.markDeleted(schedule.id);
      }

      await expect(fixture.store.createRun({
        scheduleId: schedule.id,
        occurrenceAt: "2026-07-28T11:00:00.000Z",
        triggerId: `delivery-${status}`,
        idempotencyKey: `key-${status}`,
      })).rejects.toThrow(/not active/i);
    }
  });

  it("lets exactly one worker claim a pending run", async () => {
    const fixture = createFixture();
    const schedule = await fixture.store.create(scheduleInput());
    const run = await fixture.store.createRun({
      scheduleId: schedule.id,
      occurrenceAt: "2026-07-28T11:00:00.000Z",
      triggerId: "delivery-1",
      idempotencyKey: "key-1",
    });
    const [first, second] = await Promise.all([
      fixture.store.claimRun(run.id, lease(fixture, "worker-1", "token-1")),
      fixture.store.claimRun(run.id, lease(fixture, "worker-2", "token-2")),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect((await fixture.store.getRun(run.id))?.attempts).toBe(1);
  });

  it("reclaims an expired lease and rejects the stale worker completion", async () => {
    const fixture = createFixture();
    const schedule = await fixture.store.create(scheduleInput());
    const run = await fixture.store.createRun({
      scheduleId: schedule.id,
      occurrenceAt: "2026-07-28T11:00:00.000Z",
      triggerId: "delivery-1",
      idempotencyKey: "key-1",
    });
    const oldLease = lease(fixture, "worker-1", "token-1", 1_000);
    expect(await fixture.store.claimRun(run.id, oldLease)).not.toBeNull();
    fixture.advance(1_001);
    const newLease = lease(fixture, "worker-2", "token-2");
    const reclaimed = await fixture.store.claimRun(run.id, newLease);

    expect(reclaimed).toMatchObject({
      status: "claimed",
      attempts: 2,
      lease: newLease,
    });
    await expect(fixture.store.completeRun(run.id, {
      lease: oldLease,
      status: "succeeded",
      references: { runtimeId: "stale-runtime" },
    })).rejects.toBeInstanceOf(ScheduleConflictError);
    expect((await fixture.store.getRun(run.id))?.status).toBe("claimed");
  });

  it("renews and starts only with the current unexpired lease", async () => {
    const fixture = createFixture();
    const schedule = await fixture.store.create(scheduleInput());
    const run = await fixture.store.createRun({
      scheduleId: schedule.id,
      occurrenceAt: "2026-07-28T11:00:00.000Z",
      triggerId: "delivery-1",
      idempotencyKey: "key-1",
    });
    const firstLease = lease(fixture);
    await fixture.store.claimRun(run.id, firstLease);
    const renewed = lease(fixture, firstLease.owner, firstLease.token, 120_000);

    expect(await fixture.store.renewLease(run.id, renewed)).toBe(true);
    expect(await fixture.store.renewLease(run.id, firstLease)).toBe(false);
    expect(await fixture.store.renewLease(run.id, {
      ...renewed,
      token: "wrong",
    })).toBe(false);
    expect(await fixture.store.startRun(run.id, renewed)).toMatchObject({
      status: "running",
      startedAt: "2026-07-28T10:00:00.000Z",
    });
  });

  it("does not start claimed work after the schedule is paused", async () => {
    const fixture = createFixture();
    const schedule = await fixture.store.create(scheduleInput());
    const run = await fixture.store.createRun({
      scheduleId: schedule.id,
      occurrenceAt: "2026-07-28T11:00:00.000Z",
      triggerId: "delivery-1",
      idempotencyKey: "key-1",
    });
    const currentLease = lease(fixture);
    await fixture.store.claimRun(run.id, currentLease);
    await fixture.store.update(schedule.id, { status: "paused" });

    await expect(
      fixture.store.startRun(run.id, currentLease),
    ).rejects.toBeInstanceOf(ScheduleInvalidStateError);
    expect(await fixture.store.getRun(run.id)).toMatchObject({
      status: "claimed",
      lease: currentLease,
    });
  });

  it("releases a claimed run for retry without making it terminal", async () => {
    const fixture = createFixture();
    const schedule = await fixture.store.create(scheduleInput());
    const run = await fixture.store.createRun({
      scheduleId: schedule.id,
      occurrenceAt: "2026-07-28T11:00:00.000Z",
      triggerId: "delivery-1",
      idempotencyKey: "key-1",
    });
    const firstLease = lease(fixture);
    await fixture.store.claimRun(run.id, firstLease);
    const released = await fixture.store.releaseRun(run.id, firstLease);

    expect(released).toMatchObject({
      status: "pending",
      attempts: 1,
    });
    expect(released.lease).toBeUndefined();
    expect(
      await fixture.store.claimRun(run.id, lease(fixture, "worker-2", "token-2")),
    ).toMatchObject({ attempts: 2 });
  });

  it("completes atomically and never revives a terminal run", async () => {
    const fixture = createFixture();
    const schedule = await fixture.store.create(scheduleInput());
    const run = await fixture.store.createRun({
      scheduleId: schedule.id,
      occurrenceAt: "2026-07-28T11:00:00.000Z",
      triggerId: "delivery-1",
      idempotencyKey: "key-1",
    });
    const currentLease = lease(fixture);
    await fixture.store.claimRun(run.id, currentLease);
    await fixture.store.startRun(run.id, currentLease);
    const completed = await fixture.store.completeRun(run.id, {
      lease: currentLease,
      status: "succeeded",
      references: {
        runtimeId: "runtime-1",
        sessionId: "session-1",
      },
      result: { output: "done" },
    });

    expect(completed).toMatchObject({
      status: "succeeded",
      references: {
        runtimeId: "runtime-1",
        sessionId: "session-1",
      },
      result: { output: "done" },
      completedAt: "2026-07-28T10:00:00.000Z",
    });
    expect(completed.lease).toBeUndefined();
    expect(await fixture.store.claimRun(run.id, lease(fixture))).toBeNull();
    await expect(fixture.store.completeRun(run.id, {
      lease: currentLease,
      status: "failed",
      references: {},
      error: {
        code: "late",
        message: "late completion",
        retryable: false,
      },
    })).rejects.toBeInstanceOf(ScheduleConflictError);
  });

  it("counts only active unexpired runs for concurrency", async () => {
    const fixture = createFixture();
    const schedule = await fixture.store.create(scheduleInput());
    const first = await fixture.store.createRun({
      scheduleId: schedule.id,
      occurrenceAt: "2026-07-28T11:00:00.000Z",
      triggerId: "delivery-1",
      idempotencyKey: "key-1",
    });
    const second = await fixture.store.createRun({
      scheduleId: schedule.id,
      occurrenceAt: "2026-07-28T12:00:00.000Z",
      triggerId: "delivery-2",
      idempotencyKey: "key-2",
    });
    await fixture.store.claimRun(first.id, lease(fixture, "worker-1", "token-1", 1_000));
    await fixture.store.claimRun(second.id, lease(fixture, "worker-2", "token-2", 60_000));

    expect(await fixture.store.countActiveRuns(schedule.id)).toBe(2);
    fixture.advance(1_001);
    expect(await fixture.store.countActiveRuns(schedule.id)).toBe(1);
  });

  it("rejects malformed leases and invalid completion payloads", async () => {
    const fixture = createFixture();
    const schedule = await fixture.store.create(scheduleInput());
    const run = await fixture.store.createRun({
      scheduleId: schedule.id,
      occurrenceAt: "2026-07-28T11:00:00.000Z",
      triggerId: "delivery-1",
      idempotencyKey: "key-1",
    });

    await expect(fixture.store.claimRun(run.id, {
      owner: "",
      token: "token",
      expiresAt: "2026-07-28T11:00:00.000Z",
    })).rejects.toThrow(/owner/i);
    await expect(fixture.store.claimRun(run.id, {
      owner: "worker",
      token: "token",
      expiresAt: "2026-07-28T09:00:00.000Z",
    })).rejects.toThrow(/future/i);
    await expect(fixture.store.claimRun(run.id, {
      owner: "worker",
      token: "token",
      expiresAt: "2026-07-28T11:00:00.000Z",
      futureLeaseField: true,
    } as any)).rejects.toThrow(/futureLeaseField/);
  });
});
