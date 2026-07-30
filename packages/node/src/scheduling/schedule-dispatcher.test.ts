import { describe, expect, it, vi } from "vitest";
import type {
  Schedule,
  ScheduleDispatcher,
  ScheduleRun,
} from "@polpo-ai/core/scheduling";
import { createLocalScheduleRunHandler } from "./schedule-dispatcher.js";

function schedule(): Schedule {
  return {
    id: "schedule-1",
    timing: {
      kind: "once",
      at: "2026-07-28T10:00:00.000Z",
      timezone: "UTC",
    },
    invocation: {
      surface: "task",
      agentName: "worker",
      title: "Import",
      prompt: "Import records",
    },
    status: "active",
    policy: {
      catchUp: "skip",
      misfireGraceSeconds: 300,
      maxConcurrency: 1,
    },
    metadata: {},
    createdAt: "2026-07-28T09:00:00.000Z",
    updatedAt: "2026-07-28T09:00:00.000Z",
    revision: 1,
  };
}

function run(): ScheduleRun {
  return {
    id: "run-1",
    scheduleId: "schedule-1",
    occurrenceAt: "2026-07-28T10:00:00.000Z",
    triggerId: "trigger-1",
    idempotencyKey: "key-1",
    status: "running",
    attempts: 1,
    references: {},
    createdAt: "2026-07-28T10:00:00.000Z",
    updatedAt: "2026-07-28T10:00:00.000Z",
  };
}

describe("createLocalScheduleRunHandler", () => {
  it("adapts the local worker context without changing dispatcher results", async () => {
    const dispatcher: ScheduleDispatcher = {
      dispatch: vi.fn(async () => ({
        status: "succeeded",
        references: { taskId: "task-1" },
      })),
    };
    const handler = createLocalScheduleRunHandler(dispatcher);
    const controller = new AbortController();
    const currentSchedule = schedule();
    const currentRun = run();

    await expect(handler({
      schedule: currentSchedule,
      run: currentRun,
      lease: {
        owner: "worker-1",
        token: "lease-1",
        expiresAt: "2026-07-28T10:01:00.000Z",
      },
      signal: controller.signal,
    })).resolves.toEqual({
      status: "succeeded",
      references: { taskId: "task-1" },
    });
    expect(dispatcher.dispatch).toHaveBeenCalledWith(
      currentRun,
      currentSchedule,
      { signal: controller.signal },
    );
  });

  it("rejects a missing dispatcher at composition time", () => {
    expect(() => createLocalScheduleRunHandler(undefined as never))
      .toThrow("requires a dispatcher");
  });
});
