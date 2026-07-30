import { describe, expect, it, vi } from "vitest";
import {
  InMemoryScheduleStore,
  ScheduleConflictError,
  ScheduleNotFoundError,
  type Schedule,
  type ScheduleDriver,
} from "@polpo-ai/core/scheduling";
import { migrateLegacyMissionSchedules } from "./schedules-migration.js";
import { ScheduleService } from "./schedules.js";

const NOW = "2026-07-28T08:00:00.000Z";

function harness() {
  const store = new InMemoryScheduleStore({
    now: () => new Date(NOW),
  });
  const driver: ScheduleDriver = {
    register: vi.fn(async (schedule: Schedule) => ({
      kind: "test",
      status: "registered" as const,
      providerId: `provider:${schedule.id}`,
      updatedAt: NOW,
    })),
    update: vi.fn(async () => ({
      kind: "test",
      status: "registered" as const,
      updatedAt: NOW,
    })),
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  };
  return {
    store,
    driver,
    service: new ScheduleService({
      store,
      driver,
      now: () => new Date(NOW),
    }),
  };
}

describe("migrateLegacyMissionSchedules", () => {
  it("imports recurring and one-time mission schedules with deterministic ids", async () => {
    const state = harness();

    const result = await migrateLegacyMissionSchedules({
      service: state.service,
      now: NOW,
      missions: [
        {
          id: "daily-report",
          status: "recurring",
          schedule: "0 9 * * *",
          endDate: "2026-08-30T00:00:00.000Z",
          data: "must not be copied",
        },
        {
          id: "launch",
          status: "scheduled",
          schedule: "2026-07-29T10:00:00Z",
        },
      ],
    });

    expect(result).toEqual({
      scanned: 2,
      eligible: 2,
      created: 2,
      existing: 0,
      skipped: 0,
      failed: 0,
      items: [
        {
          missionId: "daily-report",
          scheduleId: "legacy-mission:daily-report",
          status: "created",
          code: "CREATED",
        },
        {
          missionId: "launch",
          scheduleId: "legacy-mission:launch",
          status: "created",
          code: "CREATED",
        },
      ],
    });
    await expect(state.service.get("legacy-mission:daily-report"))
      .resolves.toMatchObject({
        timing: {
          kind: "cron",
          expression: "0 9 * * *",
          timezone: "UTC",
        },
        invocation: {
          surface: "legacy_mission",
          missionId: "daily-report",
        },
        metadata: {
          compatibility: {
            source: "mission-v1",
            recurring: true,
            deprecated: true,
          },
        },
      });
    await expect(state.service.get("legacy-mission:launch"))
      .resolves.toMatchObject({
        timing: {
          kind: "once",
          at: "2026-07-29T10:00:00.000Z",
        },
      });
    expect(JSON.stringify(await state.service.list())).not.toContain(
      "must not be copied",
    );
  });

  it("is idempotent and never re-registers an already migrated schedule", async () => {
    const state = harness();
    const input = {
      service: state.service,
      now: NOW,
      missions: [{
        id: "daily-report",
        status: "recurring",
        schedule: "0 9 * * *",
      }],
    };

    const first = await migrateLegacyMissionSchedules(input);
    const second = await migrateLegacyMissionSchedules(input);

    expect(first.created).toBe(1);
    expect(second).toMatchObject({
      scanned: 1,
      eligible: 1,
      created: 0,
      existing: 1,
      skipped: 0,
      failed: 0,
    });
    expect(second.items).toEqual([{
      missionId: "daily-report",
      scheduleId: "legacy-mission:daily-report",
      status: "existing",
      code: "ALREADY_MIGRATED",
    }]);
    expect(state.driver.register).toHaveBeenCalledTimes(1);
  });

  it("preserves paused state and supports dry runs without writes", async () => {
    const state = harness();

    const dryRun = await migrateLegacyMissionSchedules({
      service: state.service,
      now: NOW,
      dryRun: true,
      missions: [{
        id: "paused-report",
        status: "paused",
        schedule: "0 9 * * *",
        recurring: true,
      }],
    });

    expect(dryRun).toMatchObject({
      created: 0,
      existing: 0,
      skipped: 1,
      failed: 0,
      items: [{
        missionId: "paused-report",
        scheduleId: "legacy-mission:paused-report",
        status: "skipped",
        code: "DRY_RUN",
      }],
    });
    await expect(state.service.get("legacy-mission:paused-report"))
      .rejects.toMatchObject({ code: "NOT_FOUND" });

    const migrated = await migrateLegacyMissionSchedules({
      service: state.service,
      now: NOW,
      missions: [{
        id: "paused-report",
        status: "paused",
        schedule: "0 9 * * *",
        recurring: true,
      }],
    });
    expect(migrated.created).toBe(1);
    await expect(state.service.get("legacy-mission:paused-report"))
      .resolves.toMatchObject({ status: "paused" });
  });

  it("refuses to guess recurrence for ambiguous legacy mission states", async () => {
    const state = harness();

    const result = await migrateLegacyMissionSchedules({
      service: state.service,
      now: NOW,
      missions: [{
        id: "paused-report",
        status: "paused",
        schedule: "0 9 * * *",
      }],
    });

    expect(result).toMatchObject({
      scanned: 1,
      eligible: 1,
      created: 0,
      failed: 1,
      items: [{
        missionId: "paused-report",
        scheduleId: "legacy-mission:paused-report",
        status: "failed",
        code: "AMBIGUOUS_RECURRENCE",
        message: "Legacy mission recurrence cannot be inferred safely",
      }],
    });
    expect(state.driver.register).not.toHaveBeenCalled();
  });

  it("skips unscheduled and terminal missions without invoking the driver", async () => {
    const state = harness();

    const result = await migrateLegacyMissionSchedules({
      service: state.service,
      now: NOW,
      missions: [
        { id: "no-schedule", status: "draft" },
        { id: "draft", status: "draft", schedule: "0 9 * * *" },
        { id: "completed", status: "completed", schedule: "0 9 * * *" },
        { id: "cancelled", status: "cancelled", schedule: "0 9 * * *" },
      ],
    });

    expect(result).toMatchObject({
      scanned: 4,
      eligible: 0,
      created: 0,
      existing: 0,
      skipped: 4,
      failed: 0,
    });
    expect(result.items.map((item) => item.code)).toEqual([
      "NO_SCHEDULE",
      "INACTIVE_MISSION",
      "INACTIVE_MISSION",
      "INACTIVE_MISSION",
    ]);
    expect(state.driver.register).not.toHaveBeenCalled();
  });

  it("reports malformed records without aborting the remaining batch or leaking payloads", async () => {
    const state = harness();
    const result = await migrateLegacyMissionSchedules({
      service: state.service,
      now: NOW,
      missions: [
        null,
        {
          id: "bad-expression",
          status: "scheduled",
          schedule: "super-secret-invalid-expression",
          data: "private mission content",
        },
        {
          id: "good",
          status: "recurring",
          schedule: "0 9 * * *",
        },
      ],
    });

    expect(result).toMatchObject({
      scanned: 3,
      eligible: 2,
      created: 1,
      existing: 0,
      skipped: 0,
      failed: 2,
    });
    expect(result.items).toEqual([
      {
        missionId: "<invalid>",
        status: "failed",
        code: "INVALID_MISSION",
        message: "Legacy mission record is invalid",
      },
      {
        missionId: "bad-expression",
        scheduleId: "legacy-mission:bad-expression",
        status: "failed",
        code: "INVALID_LEGACY_SCHEDULE",
        message: "Legacy mission schedule is invalid",
      },
      {
        missionId: "good",
        scheduleId: "legacy-mission:good",
        status: "created",
        code: "CREATED",
      },
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("super-secret-invalid-expression");
    expect(serialized).not.toContain("private mission content");
  });

  it("does not overwrite deterministic-id collisions", async () => {
    const state = harness();
    await state.service.create({
      id: "legacy-mission:mission-1",
      timing: {
        kind: "cron",
        expression: "30 12 * * *",
        timezone: "UTC",
      },
      invocation: {
        surface: "agent",
        agentName: "other-agent",
        input: { prompt: "Keep this schedule" },
      },
    });

    const result = await migrateLegacyMissionSchedules({
      service: state.service,
      now: NOW,
      missions: [{
        id: "mission-1",
        status: "recurring",
        schedule: "0 9 * * *",
      }],
    });

    expect(result).toMatchObject({
      scanned: 1,
      eligible: 1,
      created: 0,
      existing: 0,
      skipped: 0,
      failed: 1,
      items: [{
        missionId: "mission-1",
        scheduleId: "legacy-mission:mission-1",
        status: "failed",
        code: "ID_CONFLICT",
        message: "Schedule id is already used by a different definition",
      }],
    });
    await expect(state.service.get("legacy-mission:mission-1"))
      .resolves.toMatchObject({
        invocation: {
          surface: "agent",
          agentName: "other-agent",
        },
      });
  });

  it("reports definition drift instead of silently accepting stale migrated state", async () => {
    const state = harness();
    await migrateLegacyMissionSchedules({
      service: state.service,
      now: NOW,
      missions: [{
        id: "mission-1",
        status: "recurring",
        schedule: "0 9 * * *",
      }],
    });

    const result = await migrateLegacyMissionSchedules({
      service: state.service,
      now: NOW,
      missions: [{
        id: "mission-1",
        status: "recurring",
        schedule: "30 10 * * *",
      }],
    });

    expect(result).toMatchObject({
      created: 0,
      existing: 0,
      failed: 1,
      items: [{
        missionId: "mission-1",
        scheduleId: "legacy-mission:mission-1",
        status: "failed",
        code: "DEFINITION_CONFLICT",
        message: "Migrated schedule differs from the legacy definition",
      }],
    });
    await expect(state.service.get("legacy-mission:mission-1"))
      .resolves.toMatchObject({
        timing: { expression: "0 9 * * *" },
      });
  });

  it("isolates schedule-store read failures and continues the batch", async () => {
    const state = harness();
    const originalGet = state.service.get.bind(state.service);
    vi.spyOn(state.service, "get").mockImplementation(async (id) => {
      if (id === "legacy-mission:unreadable") {
        throw new Error("database password appeared in provider failure");
      }
      return originalGet(id);
    });

    const result = await migrateLegacyMissionSchedules({
      service: state.service,
      now: NOW,
      missions: [
        {
          id: "unreadable",
          status: "recurring",
          schedule: "0 9 * * *",
        },
        {
          id: "good",
          status: "recurring",
          schedule: "0 10 * * *",
        },
      ],
    });

    expect(result).toMatchObject({
      scanned: 2,
      eligible: 2,
      created: 1,
      failed: 1,
      items: [
        {
          missionId: "unreadable",
          scheduleId: "legacy-mission:unreadable",
          status: "failed",
          code: "READ_FAILED",
          message: "Existing schedule could not be inspected",
        },
        {
          missionId: "good",
          scheduleId: "legacy-mission:good",
          status: "created",
          code: "CREATED",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("database password");
  });

  it("accepts async mission sources and normalizes identifiers", async () => {
    const state = harness();
    async function* missions() {
      yield {
        id: " mission-1 ",
        status: "recurring",
        schedule: "0 9 * * *",
      };
      await Promise.resolve();
      yield {
        id: "mission-2",
        status: "scheduled",
        schedule: "2026-07-29T10:00:00Z",
      };
    }

    const result = await migrateLegacyMissionSchedules({
      service: state.service,
      now: NOW,
      missions: missions(),
    });

    expect(result.created).toBe(2);
    expect(result.items.map((item) => item.scheduleId)).toEqual([
      "legacy-mission:mission-1",
      "legacy-mission:mission-2",
    ]);
  });

  it("handles create races as idempotent success only for the same legacy mission", async () => {
    const state = harness();
    const originalCreate = state.service.create.bind(state.service);
    const get = vi.spyOn(state.service, "get")
      .mockRejectedValueOnce(new ScheduleNotFoundError(
        "Schedule",
        "legacy-mission:mission-1",
      ));
    const create = vi.spyOn(state.service, "create")
      .mockImplementationOnce(async (input) => {
        get.mockRestore();
        await originalCreate(input);
        throw new ScheduleConflictError("race");
      });

    const result = await migrateLegacyMissionSchedules({
      service: state.service,
      now: NOW,
      missions: [{
        id: "mission-1",
        status: "recurring",
        schedule: "0 9 * * *",
      }],
    });

    expect(result).toMatchObject({
      created: 0,
      existing: 1,
      failed: 0,
    });
    create.mockRestore();
  });
});
