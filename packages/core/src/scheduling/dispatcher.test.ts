import { describe, expect, it, vi } from "vitest";
import {
  InjectedScheduleDispatcher,
  ScheduleDispatchError,
  type Schedule,
  type ScheduleRun,
  type ScheduleSurfaceHandlers,
} from "./index.js";

function schedule(
  invocation: Schedule["invocation"] = {
    surface: "agent",
    agentName: "assistant",
    input: { prompt: "Prepare the report" },
    session: {
      mode: "reuse",
      sessionId: "session-1",
      userId: "user-1",
    },
    execution: {
      loop: "research",
      model: "openai/gpt-5",
      sandbox: { isolation: "fresh" },
      guardrails: { mode: "strict" },
      metadata: { source: "schedule" },
    },
  },
): Schedule {
  return {
    id: "schedule-1",
    timing: {
      kind: "cron",
      expression: "0 9 * * *",
      timezone: "Europe/Rome",
    },
    invocation,
    status: "active",
    policy: {
      catchUp: "skip",
      misfireGraceSeconds: 300,
      maxConcurrency: 1,
    },
    metadata: {},
    createdAt: "2026-07-28T08:00:00.000Z",
    updatedAt: "2026-07-28T08:00:00.000Z",
    revision: 1,
  };
}

function run(overrides: Partial<ScheduleRun> = {}): ScheduleRun {
  return {
    id: "schedule-run-1",
    scheduleId: "schedule-1",
    occurrenceAt: "2026-07-28T09:00:00.000Z",
    triggerId: "trigger-1",
    idempotencyKey: "schedule:schedule-1:2026-07-28T09:00:00.000Z",
    status: "running",
    attempts: 1,
    references: {},
    createdAt: "2026-07-28T09:00:00.000Z",
    updatedAt: "2026-07-28T09:00:01.000Z",
    startedAt: "2026-07-28T09:00:01.000Z",
    ...overrides,
  };
}

describe("InjectedScheduleDispatcher", () => {
  it("dispatches an agent invocation with normalized execution context", async () => {
    const agent = vi.fn(async () => ({
      status: "succeeded" as const,
      references: {
        runtimeId: "runtime-1",
        sessionId: "session-1",
        loopRunId: "loop-run-1",
      },
      result: { answer: "ready" },
    }));
    const dispatcher = new InjectedScheduleDispatcher({ agent });
    const controller = new AbortController();

    await expect(dispatcher.dispatch(run(), schedule(), {
      signal: controller.signal,
    })).resolves.toEqual({
      status: "succeeded",
      references: {
        runtimeId: "runtime-1",
        sessionId: "session-1",
        loopRunId: "loop-run-1",
      },
      result: { answer: "ready" },
    });
    expect(agent).toHaveBeenCalledTimes(1);
    expect(agent).toHaveBeenCalledWith(expect.objectContaining({
      schedule: expect.objectContaining({ id: "schedule-1" }),
      run: expect.objectContaining({
        id: "schedule-run-1",
        idempotencyKey: "schedule:schedule-1:2026-07-28T09:00:00.000Z",
      }),
      invocation: expect.objectContaining({
        surface: "agent",
        agentName: "assistant",
        input: { prompt: "Prepare the report" },
        execution: expect.objectContaining({
          loop: "research",
          model: "openai/gpt-5",
          sandbox: { isolation: "fresh" },
        }),
      }),
      signal: controller.signal,
    }));
  });

  it.each([
    {
      surface: "task",
      invocation: {
        surface: "task",
        agentName: "worker",
        title: "Nightly import",
        prompt: "Import records",
        userId: "external-user-1",
        execution: { loop: "import" },
      },
      result: {
        status: "succeeded",
        references: { taskId: "task-1" },
      },
    },
    {
      surface: "channel",
      invocation: {
        surface: "channel",
        channelId: "channel-1",
        routeId: "route-1",
        externalThreadId: "thread-1",
        mode: "send",
        text: "Daily report ready",
      },
      result: {
        status: "succeeded",
        references: { providerDeliveryId: "delivery-1" },
      },
    },
    {
      surface: "webhook",
      invocation: {
        surface: "webhook",
        webhookId: "webhook-1",
        payload: { reportId: "report-1" },
      },
      result: {
        status: "succeeded",
        references: { providerDeliveryId: "delivery-1" },
      },
    },
    {
      surface: "legacy_mission",
      invocation: {
        surface: "legacy_mission",
        missionId: "mission-1",
      },
      result: {
        status: "succeeded",
        references: {},
        result: { missionId: "mission-1" },
      },
    },
  ] as const)(
    "dispatches $surface through only its injected handler",
    async ({ surface, invocation, result }) => {
      const selected = vi.fn(async () => result);
      const unexpected = vi.fn();
      const handlers = {
        agent: unexpected,
        task: unexpected,
        channel: unexpected,
        webhook: unexpected,
        legacyMission: unexpected,
        [surface === "legacy_mission" ? "legacyMission" : surface]: selected,
      } as unknown as ScheduleSurfaceHandlers;
      const dispatcher = new InjectedScheduleDispatcher(handlers);

      await expect(
        dispatcher.dispatch(run(), schedule(invocation)),
      ).resolves.toEqual(result);
      expect(selected).toHaveBeenCalledTimes(1);
      expect(selected).toHaveBeenCalledWith(expect.objectContaining({
        invocation: expect.objectContaining({ surface }),
      }));
      expect(unexpected).not.toHaveBeenCalled();
    },
  );

  it("fails closed when the required surface handler is unavailable", async () => {
    const dispatcher = new InjectedScheduleDispatcher({});

    await expect(dispatcher.dispatch(run(), schedule())).rejects.toMatchObject({
      name: "ScheduleDispatchError",
      code: "HANDLER_UNAVAILABLE",
      retryable: false,
    });
  });

  it.each([
    {
      label: "schedule mismatch",
      currentRun: run({ scheduleId: "another-schedule" }),
      currentSchedule: schedule(),
      code: "INVALID_CONTEXT",
    },
    {
      label: "non-running run",
      currentRun: run({ status: "claimed" }),
      currentSchedule: schedule(),
      code: "INVALID_CONTEXT",
    },
    {
      label: "paused schedule",
      currentRun: run(),
      currentSchedule: { ...schedule(), status: "paused" as const },
      code: "INVALID_CONTEXT",
    },
  ])("rejects $label before invoking a handler", async ({
    currentRun,
    currentSchedule,
    code,
  }) => {
    const agent = vi.fn();
    const dispatcher = new InjectedScheduleDispatcher({ agent });

    await expect(
      dispatcher.dispatch(currentRun, currentSchedule),
    ).rejects.toMatchObject({ code });
    expect(agent).not.toHaveBeenCalled();
  });

  it("revalidates persisted invocation data before invoking a handler", async () => {
    const agent = vi.fn();
    const dispatcher = new InjectedScheduleDispatcher({ agent });
    const malformed = schedule();
    malformed.invocation = {
      surface: "agent",
      agentName: "",
      input: { prompt: "" },
    };

    await expect(
      dispatcher.dispatch(run(), malformed),
    ).rejects.toMatchObject({
      code: "INVALID_INVOCATION",
      retryable: false,
    });
    expect(agent).not.toHaveBeenCalled();
  });

  it("requires durable references for successful surface outcomes", async () => {
    const cases: Array<{
      invocation: Schedule["invocation"];
      handlers: ScheduleSurfaceHandlers;
    }> = [
      {
        invocation: schedule().invocation,
        handlers: {
          agent: async () => ({ status: "succeeded", references: {} }),
        },
      },
      {
        invocation: {
          surface: "task",
          agentName: "worker",
          title: "Task",
          prompt: "Run task",
        },
        handlers: {
          task: async () => ({ status: "succeeded", references: {} }),
        },
      },
      {
        invocation: {
          surface: "channel",
          channelId: "channel-1",
          mode: "send",
          text: "Hello",
        },
        handlers: {
          channel: async () => ({ status: "succeeded", references: {} }),
        },
      },
      {
        invocation: {
          surface: "webhook",
          webhookId: "webhook-1",
        },
        handlers: {
          webhook: async () => ({ status: "succeeded", references: {} }),
        },
      },
    ];

    for (const testCase of cases) {
      const dispatcher = new InjectedScheduleDispatcher(testCase.handlers);
      await expect(
        dispatcher.dispatch(run(), schedule(testCase.invocation)),
      ).rejects.toMatchObject({
        code: "INVALID_RESULT",
        retryable: false,
      });
    }
  });

  it.each([
    {
      label: "unknown result field",
      result: {
        status: "succeeded",
        references: { runtimeId: "runtime-1" },
        unexpected: true,
      },
    },
    {
      label: "unknown reference",
      result: {
        status: "succeeded",
        references: { runtimeId: "runtime-1", otherId: "other-1" },
      },
    },
    {
      label: "failed result without error",
      result: {
        status: "failed",
        references: {},
      },
    },
    {
      label: "successful result with error",
      result: {
        status: "succeeded",
        references: { runtimeId: "runtime-1" },
        error: {
          code: "UNEXPECTED",
          message: "Should not exist",
          retryable: false,
        },
      },
    },
    {
      label: "non-JSON result metadata",
      result: {
        status: "succeeded",
        references: { runtimeId: "runtime-1" },
        result: { invalid: undefined },
      },
    },
  ])("rejects malformed handler result: $label", async ({ result }) => {
    const dispatcher = new InjectedScheduleDispatcher({
      agent: async () => result as never,
    });

    await expect(dispatcher.dispatch(run(), schedule())).rejects.toMatchObject({
      code: "INVALID_RESULT",
      retryable: false,
    });
  });

  it("normalizes a failed terminal result with bounded error metadata", async () => {
    const dispatcher = new InjectedScheduleDispatcher({
      agent: async () => ({
        status: "failed",
        references: {},
        error: {
          code: " MODEL_REJECTED ",
          message: " Request rejected ",
          retryable: false,
          metadata: { policy: "strict" },
        },
      }),
    });

    await expect(dispatcher.dispatch(run(), schedule())).resolves.toEqual({
      status: "failed",
      references: {},
      error: {
        code: "MODEL_REJECTED",
        message: "Request rejected",
        retryable: false,
        metadata: { policy: "strict" },
      },
    });
  });

  it("does not swallow errors thrown by a surface adapter", async () => {
    const providerError = new Error("Provider unavailable");
    const dispatcher = new InjectedScheduleDispatcher({
      webhook: async () => {
        throw providerError;
      },
    });

    await expect(dispatcher.dispatch(
      run(),
      schedule({ surface: "webhook", webhookId: "webhook-1" }),
    )).rejects.toBe(providerError);
  });

  it("does not invoke a handler when dispatch is already aborted", async () => {
    const agent = vi.fn();
    const dispatcher = new InjectedScheduleDispatcher({ agent });
    const controller = new AbortController();
    controller.abort("lease lost");

    await expect(dispatcher.dispatch(run(), schedule(), {
      signal: controller.signal,
    })).rejects.toMatchObject({
      code: "ABORTED",
      retryable: true,
    });
    expect(agent).not.toHaveBeenCalled();
  });

  it("exposes stable error fields", () => {
    const error = new ScheduleDispatchError(
      "INVALID_RESULT",
      "Invalid result",
      false,
    );
    expect(error).toMatchObject({
      name: "ScheduleDispatchError",
      code: "INVALID_RESULT",
      message: "Invalid result",
      retryable: false,
    });
  });
});
