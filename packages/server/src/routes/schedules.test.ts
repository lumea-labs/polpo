import { describe, expect, it, vi } from "vitest";
import {
  InMemoryScheduleStore,
  type CreateScheduleInput,
  type ScheduleDriver,
} from "@polpo-ai/core/scheduling";
import { ScheduleService } from "../services/schedules.js";
import { scheduleRoutes } from "./schedules.js";

function harness() {
  let clock = new Date("2026-07-28T08:00:00.000Z");
  let sequence = 0;
  const store = new InMemoryScheduleStore({
    now: () => clock,
    createId: (kind) => `${kind}-${++sequence}`,
  });
  const driver: ScheduleDriver = {
    register: vi.fn(async (schedule) => ({
      kind: "test",
      status: "registered" as const,
      providerId: `provider:${schedule.id}`,
      updatedAt: clock.toISOString(),
    })),
    update: vi.fn(async (schedule) => ({
      kind: "test",
      status: "registered" as const,
      providerId: `provider:${schedule.id}`,
      updatedAt: clock.toISOString(),
    })),
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  };
  const service = new ScheduleService({
    store,
    driver,
    now: () => clock,
  });
  const getMission = vi.fn(async (id: string) =>
    id === "mission-1" ? { id, name: "Legacy mission" } : null
  );
  const updateMission = vi.fn(async (id: string, patch: unknown) => ({
    id,
    ...(patch as object),
  }));
  const app = scheduleRoutes(() => ({
    scheduleService: service,
    getMission,
    updateMission,
  }));
  return {
    app,
    service,
    driver,
    getMission,
    updateMission,
    setNow(value: string) {
      clock = new Date(value);
    },
  };
}

function json(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

function v2Create(): CreateScheduleInput {
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
      input: { prompt: "Prepare report" },
    },
    policy: {
      catchUp: "skip",
      misfireGraceSeconds: 300,
      maxConcurrency: 1,
    },
  };
}

describe("scheduleRoutes v2", () => {
  it("supports CRUD, pause/resume, filtering, and run history", async () => {
    const state = harness();

    const createResponse = await state.app.request(
      "/",
      json("POST", v2Create()),
    );
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();
    expect(created.data).toMatchObject({
      id: "schedule-1",
      status: "active",
      nextOccurrenceAt: "2026-07-28T09:00:00.000Z",
      invocation: { surface: "agent" },
    });

    const getResponse = await state.app.request("/schedule-1");
    expect(getResponse.status).toBe(200);
    expect((await getResponse.json()).data.id).toBe("schedule-1");

    const listResponse = await state.app.request(
      "/?status=active&surface=agent",
    );
    expect(listResponse.status).toBe(200);
    expect((await listResponse.json()).data).toHaveLength(1);

    const updateResponse = await state.app.request(
      "/schedule-1",
      {
        ...json("PATCH", { name: "Updated report" }),
        headers: {
          "content-type": "application/json",
          "if-match": String(created.data.revision),
        },
      },
    );
    expect(updateResponse.status).toBe(200);
    const updated = await updateResponse.json();
    expect(updated.data.name).toBe("Updated report");

    const pauseResponse = await state.app.request(
      "/schedule-1/pause",
      json("POST"),
    );
    expect(pauseResponse.status).toBe(200);
    expect((await pauseResponse.json()).data.status).toBe("paused");

    const resumeResponse = await state.app.request(
      "/schedule-1/resume",
      json("POST"),
    );
    expect(resumeResponse.status).toBe(200);
    expect((await resumeResponse.json()).data.status).toBe("active");

    state.setNow("2026-07-28T08:30:00.000Z");
    const triggerResponse = await state.app.request(
      "/schedule-1/runs",
      json("POST", { idempotencyKey: "smoke-1" }),
    );
    expect(triggerResponse.status).toBe(202);
    expect((await triggerResponse.json()).data).toMatchObject({
      status: "pending",
      idempotencyKey: "manual:schedule-1:smoke-1",
    });

    const runsResponse = await state.app.request(
      "/schedule-1/runs?status=pending&limit=10&order=asc",
    );
    expect(runsResponse.status).toBe(200);
    expect((await runsResponse.json()).data).toHaveLength(1);

    const deleteResponse = await state.app.request(
      "/schedule-1",
      { method: "DELETE" },
    );
    expect(deleteResponse.status).toBe(200);
    expect((await deleteResponse.json()).data).toMatchObject({
      id: "schedule-1",
      status: "deleted",
    });
    expect((await (await state.app.request("/")).json()).data).toHaveLength(0);
    expect(
      (await (await state.app.request("/?includeDeleted=true")).json()).data,
    ).toHaveLength(1);
  });

  it("maps not found, revision conflict, invalid state, and validation errors", async () => {
    const state = harness();
    const created = await state.service.create(v2Create());

    const missing = await state.app.request("/missing");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });

    const conflict = await state.app.request("/schedule-1", {
      ...json("PATCH", { name: "stale" }),
      headers: {
        "content-type": "application/json",
        "if-match": String(created.revision - 1),
      },
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      ok: false,
      code: "CONFLICT",
    });

    await state.service.pause("schedule-1");
    const invalidState = await state.app.request(
      "/schedule-1/runs",
      json("POST", { idempotencyKey: "manual-1" }),
    );
    expect(invalidState.status).toBe(409);
    expect(await invalidState.json()).toMatchObject({
      ok: false,
      code: "INVALID_STATE",
    });

    const invalid = await state.app.request(
      "/",
      json("POST", {
        ...v2Create(),
        invocation: {
          surface: "agent",
          agentName: "",
          input: { prompt: "" },
        },
      }),
    );
    expect(invalid.status).toBe(400);

    const invalidRevision = await state.app.request("/schedule-1", {
      ...json("PATCH", { name: "invalid revision" }),
      headers: {
        "content-type": "application/json",
        "if-match": "999999999999999999999999999",
      },
    });
    expect(invalidRevision.status).toBe(400);

    const invalidLimit = await state.app.request(
      "/schedule-1/runs?limit=1001",
    );
    expect(invalidLimit.status).toBe(400);
  });

  it("returns an explicit availability error for v2 when not wired", async () => {
    const app = scheduleRoutes(() => ({
      getScheduler: () => undefined,
      getMission: async () => null,
      updateMission: async () => null,
    }));

    const response = await app.request("/", json("POST", v2Create()));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      ok: false,
      code: "SCHEDULE_SERVICE_UNAVAILABLE",
    });
  });
});

describe("scheduleRoutes legacy compatibility", () => {
  it("translates mission-shaped create/update/delete without using mission state as truth", async () => {
    const state = harness();

    const createResponse = await state.app.request(
      "/",
      json("POST", {
        missionId: "mission-1",
        expression: "0 9 * * *",
        recurring: true,
        endDate: "2026-08-30T00:00:00.000Z",
      }),
    );
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();
    expect(created.data).toMatchObject({
      id: "legacy-mission:mission-1",
      missionId: "mission-1",
      expression: "0 9 * * *",
      recurring: true,
      enabled: true,
      invocation: {
        surface: "legacy_mission",
        missionId: "mission-1",
      },
      metadata: {
        compatibility: {
          source: "mission-v1",
          deprecated: true,
        },
      },
    });
    expect(state.getMission).toHaveBeenCalledWith("mission-1");

    const list = await (await state.app.request("/")).json();
    expect(list.data[0]).toMatchObject({
      missionId: "mission-1",
      enabled: true,
    });

    const updateResponse = await state.app.request(
      "/mission-1",
      json("PATCH", {
        expression: "30 10 * * *",
        recurring: true,
        enabled: false,
        endDate: null,
      }),
    );
    expect(updateResponse.status).toBe(200);
    expect((await updateResponse.json()).data).toMatchObject({
      missionId: "mission-1",
      expression: "30 10 * * *",
      enabled: false,
      status: "paused",
    });

    const deleteResponse = await state.app.request(
      "/mission-1",
      { method: "DELETE" },
    );
    expect(deleteResponse.status).toBe(200);
    expect((await deleteResponse.json()).data).toMatchObject({
      deleted: true,
      schedule: {
        id: "legacy-mission:mission-1",
        status: "deleted",
      },
    });
    expect(state.updateMission).not.toHaveBeenCalled();
  });

  it("rejects a legacy schedule when its mission does not exist", async () => {
    const state = harness();

    const response = await state.app.request(
      "/",
      json("POST", {
        missionId: "missing",
        expression: "0 9 * * *",
      }),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
  });

  it("keeps mission writes only in the legacy scheduler fallback", async () => {
    const schedules = new Map<string, {
      id: string;
      missionId: string;
      expression: string;
      recurring: boolean;
      enabled: boolean;
      createdAt: string;
    }>();
    const updateMission = vi.fn(async (missionId: string, patch: any) => ({
      id: missionId,
      name: "Legacy mission",
      status: "draft",
      ...patch,
    }));
    const app = scheduleRoutes(() => ({
      getMission: async (missionId: string) =>
        missionId === "mission-1"
          ? { id: missionId, name: "Legacy mission", status: "draft" }
          : null,
      updateMission,
      getScheduler: () => ({
        getAllSchedules: () => [...schedules.values()],
        getScheduleByMissionId: (missionId: string) =>
          schedules.get(`sched-${missionId}`),
        registerMission: (mission: any) => {
          const entry = {
            id: `sched-${mission.id}`,
            missionId: mission.id,
            expression: mission.schedule,
            recurring: mission.status === "recurring",
            enabled: true,
            createdAt: "2026-07-28T08:00:00.000Z",
          };
          schedules.set(entry.id, entry);
          return entry;
        },
        unregisterMission: (missionId: string) =>
          schedules.delete(`sched-${missionId}`),
      }),
    }));

    expect((await app.request("/", json("POST", {
      missionId: "mission-1",
      expression: "0 9 * * *",
      recurring: true,
    }))).status).toBe(201);
    expect((await app.request("/mission-1", json("PATCH", {
      expression: "30 10 * * *",
      recurring: true,
      endDate: "2026-08-30T00:00:00.000Z",
    }))).status).toBe(200);
    expect((await app.request("/mission-1", { method: "DELETE" })).status)
      .toBe(200);

    expect(updateMission).toHaveBeenCalledWith("mission-1", {
      schedule: "0 9 * * *",
      status: "recurring",
    });
    expect(updateMission).toHaveBeenCalledWith("mission-1", {
      schedule: "30 10 * * *",
      status: "recurring",
    });
    expect(updateMission).toHaveBeenCalledWith("mission-1", {
      endDate: "2026-08-30T00:00:00.000Z",
    });
    expect(updateMission).toHaveBeenCalledWith("mission-1", {
      schedule: undefined,
      status: "draft",
    });
  });
});
