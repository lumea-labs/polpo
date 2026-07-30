import { describe, expect, it, vi } from "vitest";
import {
  InMemoryScheduleStore,
  ScheduleConflictError,
  type CreateScheduleInput,
  type Schedule,
  type ScheduleDriver,
} from "@polpo-ai/core/scheduling";
import {
  ScheduleService,
  ScheduleServiceError,
} from "./schedules.js";

function input(
  overrides: Partial<CreateScheduleInput> = {},
): CreateScheduleInput {
  return {
    id: "schedule-1",
    name: "Daily report",
    timing: {
      kind: "cron",
      expression: "0 9 * * *",
      timezone: "UTC",
    },
    invocation: {
      surface: "agent",
      agentName: "reporter",
      input: { prompt: "Prepare the daily report" },
    },
    ...overrides,
  };
}

function harness(driverOverrides: Partial<ScheduleDriver> = {}) {
  let clock = new Date("2026-07-28T08:00:00.000Z");
  let runSequence = 0;
  const store = new InMemoryScheduleStore({
    now: () => clock,
    createId: (kind) =>
      kind === "schedule" ? "generated-schedule" : `run-${++runSequence}`,
  });
  const driver: ScheduleDriver = {
    register: vi.fn(async (schedule: Schedule) => ({
      kind: "test",
      status: "registered" as const,
      providerId: `provider:${schedule.id}`,
      updatedAt: clock.toISOString(),
    })),
    update: vi.fn(async (schedule: Schedule) => ({
      kind: "test",
      status: "registered" as const,
      providerId: `provider:${schedule.id}`,
      updatedAt: clock.toISOString(),
    })),
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    ...driverOverrides,
  };
  const onRunCreated = vi.fn(async () => {});
  const service = new ScheduleService({
    store,
    driver,
    now: () => clock,
    onRunCreated,
  });
  return {
    store,
    driver,
    service,
    onRunCreated,
    setNow(value: string) {
      clock = new Date(value);
    },
  };
}

describe("ScheduleService", () => {
  it("creates a normalized schedule with next occurrence and driver state", async () => {
    const state = harness();

    await expect(state.service.create(input())).resolves.toMatchObject({
      id: "schedule-1",
      status: "active",
      nextOccurrenceAt: "2026-07-28T09:00:00.000Z",
      driver: {
        kind: "test",
        status: "registered",
        providerId: "provider:schedule-1",
      },
    });
    expect(state.driver.register).toHaveBeenCalledTimes(1);
    expect(state.driver.register).toHaveBeenCalledWith(expect.objectContaining({
      id: "schedule-1",
      nextOccurrenceAt: "2026-07-28T09:00:00.000Z",
    }));
  });

  it("persists a failed driver registration instead of losing the schedule", async () => {
    const state = harness({
      register: vi.fn(async () => {
        throw new Error("provider unavailable");
      }),
    });

    const created = await state.service.create(input());

    expect(created).toMatchObject({
      id: "schedule-1",
      status: "active",
      driver: {
        kind: "unknown",
        status: "failed",
        error: {
          code: "DRIVER_REGISTER_FAILED",
          retryable: true,
        },
      },
    });
    expect(created.driver?.error?.message).toBe(
      "Schedule driver register operation failed",
    );
    expect(await state.store.get("schedule-1")).toEqual(created);
  });

  it("recomputes occurrence on timing update and uses optimistic revision", async () => {
    const state = harness();
    const created = await state.service.create(input());

    const updated = await state.service.update(
      created.id,
      {
        timing: {
          kind: "cron",
          expression: "30 10 * * *",
          timezone: "UTC",
        },
      },
      { expectedRevision: created.revision },
    );

    expect(updated).toMatchObject({
      nextOccurrenceAt: "2026-07-28T10:30:00.000Z",
      driver: { status: "registered" },
    });
    expect(state.driver.update).toHaveBeenCalledTimes(1);
    await expect(state.service.update(
      created.id,
      { name: "stale" },
      { expectedRevision: created.revision },
    )).rejects.toBeInstanceOf(ScheduleConflictError);
  });

  it("uses lifecycle methods for status transitions made through update", async () => {
    const state = harness();
    const created = await state.service.create(input());
    vi.mocked(state.driver.update).mockClear();

    const paused = await state.service.update(created.id, {
      status: "paused",
    });
    expect(paused.status).toBe("paused");
    expect(state.driver.pause).toHaveBeenCalledTimes(1);
    expect(state.driver.update).not.toHaveBeenCalled();

    const resumed = await state.service.update(created.id, {
      status: "active",
    });
    expect(resumed.status).toBe("active");
    expect(state.driver.resume).toHaveBeenCalledTimes(1);
  });

  it("persists provider registrations returned by lifecycle operations", async () => {
    const state = harness({
      register: vi.fn(async () => ({
        kind: "test",
        status: "not_required" as const,
        metadata: { mode: "once", paused: true },
        updatedAt: "2026-07-28T08:00:00.000Z",
      })),
      resume: vi.fn(async () => ({
        kind: "test",
        status: "registered" as const,
        providerId: "message:resumed",
        metadata: { mode: "once", paused: false },
        updatedAt: "2026-07-28T08:00:00.000Z",
      })),
      pause: vi.fn(async () => ({
        kind: "test",
        status: "not_required" as const,
        metadata: { mode: "once", paused: true },
        updatedAt: "2026-07-28T08:00:00.000Z",
      })),
      delete: vi.fn(async () => ({
        kind: "test",
        status: "not_required" as const,
        metadata: { mode: "once", deleted: true },
        updatedAt: "2026-07-28T08:00:00.000Z",
      })),
    });

    const created = await state.service.create(input({
      status: "paused",
      timing: {
        kind: "once",
        at: "2026-07-28T10:00:00.000Z",
        timezone: "UTC",
      },
    }));
    expect(created.driver).toMatchObject({
      status: "not_required",
      metadata: { mode: "once", paused: true },
    });

    const resumed = await state.service.resume(created.id);
    expect(resumed.driver).toMatchObject({
      status: "registered",
      providerId: "message:resumed",
      metadata: { mode: "once", paused: false },
    });

    const paused = await state.service.pause(created.id);
    expect(paused.driver).toMatchObject({
      status: "not_required",
      metadata: { mode: "once", paused: true },
    });
    expect(paused.driver).not.toHaveProperty("providerId");

    const deleted = await state.service.delete(created.id);
    expect(deleted.driver).toMatchObject({
      status: "not_required",
      metadata: { mode: "once", deleted: true },
    });
  });

  it("classifies deep core validation failures as invalid requests", async () => {
    const state = harness();

    await expect(state.service.create(input({
      invocation: {
        surface: "agent",
        agentName: "",
        input: { prompt: "" },
      },
    }))).rejects.toMatchObject({
      name: "ScheduleServiceError",
      code: "INVALID_REQUEST",
      retryable: false,
    });
  });

  it("pauses, resumes, and deletes local truth even if driver lifecycle fails", async () => {
    const state = harness({
      pause: vi.fn(async () => {
        throw new Error("pause failed");
      }),
      resume: vi.fn(async () => {
        throw new Error("resume failed");
      }),
      delete: vi.fn(async () => {
        throw new Error("delete failed");
      }),
    });
    const created = await state.service.create(input());

    const paused = await state.service.pause(created.id);
    expect(paused).toMatchObject({
      status: "paused",
      driver: {
        status: "failed",
        error: { code: "DRIVER_PAUSE_FAILED" },
      },
    });

    const resumed = await state.service.resume(created.id);
    expect(resumed).toMatchObject({
      status: "active",
      driver: {
        status: "failed",
        error: { code: "DRIVER_RESUME_FAILED" },
      },
    });

    const deleted = await state.service.delete(created.id);
    expect(deleted).toMatchObject({
      status: "deleted",
      driver: {
        status: "failed",
        error: { code: "DRIVER_DELETE_FAILED" },
      },
    });
    expect(await state.service.list()).toEqual([]);
    expect(await state.service.list({ includeDeleted: true }))
      .toEqual([deleted]);
  });

  it("creates one durable manual run per caller idempotency key", async () => {
    const state = harness();
    const created = await state.service.create(input());
    state.setNow("2026-07-28T08:10:00.000Z");

    const first = await state.service.trigger(created.id, {
      idempotencyKey: " manual-test-1 ",
    });
    const duplicate = await state.service.trigger(created.id, {
      idempotencyKey: "manual-test-1",
    });

    expect(first).toEqual(duplicate);
    expect(first).toMatchObject({
      scheduleId: "schedule-1",
      occurrenceAt: "2026-07-28T08:10:00.000Z",
      triggerId: "manual:schedule-1:manual-test-1",
      idempotencyKey: "manual:schedule-1:manual-test-1",
      status: "pending",
    });
    expect(await state.service.listRuns(created.id)).toHaveLength(1);
    expect(state.onRunCreated).toHaveBeenCalledTimes(2);
  });

  it("rejects manual runs for inactive schedules and malformed keys", async () => {
    const state = harness();
    const created = await state.service.create(input());
    await state.service.pause(created.id);

    await expect(state.service.trigger(created.id, {
      idempotencyKey: "manual-1",
    })).rejects.toMatchObject({
      code: "INVALID_STATE",
      retryable: false,
    });
    const activeState = harness();
    const active = await activeState.service.create(input());
    await expect(activeState.service.trigger(active.id, {
      idempotencyKey: " ",
    })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      retryable: false,
    });
  });

  it("requires schedule existence for reads, updates, and run history", async () => {
    const state = harness();

    await expect(state.service.get("missing")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(state.service.update("missing", { name: "x" }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(state.service.listRuns("missing")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("reports callback failures without rolling back a durable manual run", async () => {
    const state = harness();
    const created = await state.service.create(input());
    state.onRunCreated.mockRejectedValueOnce(new Error("wake failed"));

    await expect(state.service.trigger(created.id, {
      idempotencyKey: "manual-1",
    })).resolves.toMatchObject({ status: "pending" });
    expect(await state.service.listRuns(created.id)).toHaveLength(1);
  });

  it("exposes stable service errors", () => {
    const error = new ScheduleServiceError(
      "INVALID_REQUEST",
      "Invalid request",
      false,
    );
    expect(error).toMatchObject({
      name: "ScheduleServiceError",
      code: "INVALID_REQUEST",
      retryable: false,
    });
  });
});
