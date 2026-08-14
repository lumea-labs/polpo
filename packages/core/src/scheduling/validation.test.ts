import { describe, expect, it } from "vitest";
import {
  SCHEDULE_LIMITS,
  normalizeCreateScheduleInput,
  normalizeCronExpression,
  normalizeScheduleInvocation,
  normalizeScheduleTiming,
  normalizeUpdateScheduleInput,
  translateLegacyMissionSchedule,
} from "./index.js";

const NOW = new Date("2026-07-28T10:00:00.000Z");

describe("schedule timing validation", () => {
  it("normalizes safe five-field cron expressions and IANA timezones", () => {
    expect(normalizeScheduleTiming({
      kind: "cron",
      expression: "  */15   9-17  * * 1-5 ",
      timezone: " Europe/Rome ",
    }, { now: NOW })).toEqual({
      kind: "cron",
      expression: "*/15 9-17 * * 1-5",
      timezone: "Europe/Rome",
    });
  });

  it.each([
    ["too few fields", "* * * *"],
    ["too many fields", "* * * * * *"],
    ["zero step", "*/0 * * * *"],
    ["negative step", "*/-1 * * * *"],
    ["out-of-range minute", "60 * * * *"],
    ["out-of-range hour", "0 24 * * *"],
    ["reversed range", "10-2 * * * *"],
    ["empty list item", "1,,2 * * * *"],
    ["unsupported shortcut", "@daily"],
    ["unsupported modifier", "0 9 L * *"],
    ["non-numeric token", "zero 9 * * *"],
  ])("rejects %s", (_name, expression) => {
    expect(() => normalizeCronExpression(expression)).toThrow(/cron/i);
  });

  it("normalizes Sunday 7 without changing the accepted expression", () => {
    expect(normalizeCronExpression("0 9 * * 7")).toBe("0 9 * * 7");
  });

  it("rejects invalid and unknown timing fields", () => {
    expect(() => normalizeScheduleTiming({
      kind: "cron",
      expression: "0 9 * * *",
      timezone: "Mars/Olympus",
    }, { now: NOW })).toThrow(/timezone/i);

    expect(() => normalizeScheduleTiming({
      kind: "calendar",
      expression: "daily",
      timezone: "UTC",
    }, { now: NOW })).toThrow(/kind/i);

    expect(() => normalizeScheduleTiming({
      kind: "cron",
      expression: "0 9 * * *",
      timezone: "UTC",
      futureOption: true,
    }, { now: NOW })).toThrow(/futureOption/);
  });

  it("normalizes a future one-time occurrence to UTC", () => {
    expect(normalizeScheduleTiming({
      kind: "once",
      at: "2026-07-28T14:30:00+02:00",
      timezone: "Europe/Rome",
    }, { now: NOW })).toEqual({
      kind: "once",
      at: "2026-07-28T12:30:00.000Z",
      timezone: "Europe/Rome",
    });
  });

  it.each([
    "2026-07-28T09:59:59.999Z",
    "2026-07-28T10:00:00.000Z",
  ])("rejects a one-time occurrence that is not in the future: %s", (at) => {
    expect(() => normalizeScheduleTiming({
      kind: "once",
      at,
      timezone: "UTC",
    }, { now: NOW })).toThrow(/future/i);
  });

  it("requires an unambiguous absolute timestamp for one-time schedules", () => {
    expect(() => normalizeScheduleTiming({
      kind: "once",
      at: "2026-10-25T02:30:00",
      timezone: "Europe/Rome",
    }, { now: NOW })).toThrow(/offset/i);
  });
});

describe("schedule invocation validation", () => {
  it("normalizes an agent invocation with explicit runtime options", () => {
    expect(normalizeScheduleInvocation({
      surface: "agent",
      agentName: " assistant ",
      input: { prompt: " Run the report " },
      session: {
        mode: "reuse",
        sessionId: " session-1 ",
        userId: " external-user-1 ",
      },
      execution: {
        loop: " review ",
        model: " openai/gpt-5 ",
        sandbox: {
          isolation: "fresh",
          lifecycle: { onRelease: "pool", idleTtlMinutes: 30 },
        },
        guardrails: { mode: " strict " },
        metadata: { source: "nightly" },
      },
    })).toEqual({
      surface: "agent",
      agentName: "assistant",
      input: { prompt: "Run the report" },
      session: {
        mode: "reuse",
        sessionId: "session-1",
        userId: "external-user-1",
      },
      execution: {
        loop: "review",
        model: "openai/gpt-5",
        sandbox: {
          isolation: "fresh",
          lifecycle: { onRelease: "pool", idleTtlMinutes: 30 },
        },
        guardrails: { mode: "strict" },
        metadata: { source: "nightly" },
      },
    });
  });

  it("accepts a bounded message input and clones it", () => {
    const invocation = {
      surface: "agent",
      agentName: "assistant",
      input: {
        messages: [
          { role: "system", content: "Be concise" },
          { role: "user", content: "Create the report" },
        ],
      },
      session: { mode: "new", userId: "user-1" },
    } as const;

    const normalized = normalizeScheduleInvocation(invocation);
    expect(normalized).toEqual(invocation);
    expect(normalized).not.toBe(invocation);
    expect(normalized.surface).toBe("agent");
    if (normalized.surface !== "agent") {
      throw new Error("Expected an agent invocation");
    }
    expect(normalized.input).not.toBe(invocation.input);
  });

  it.each([
    {
      name: "agent without input",
      value: { surface: "agent", agentName: "assistant", input: {} },
      error: /prompt or messages/i,
    },
    {
      name: "agent with ambiguous input",
      value: {
        surface: "agent",
        agentName: "assistant",
        input: {
          prompt: "hello",
          messages: [{ role: "user", content: "hello" }],
        },
      },
      error: /not both/i,
    },
    {
      name: "new session carrying an id",
      value: {
        surface: "agent",
        agentName: "assistant",
        input: { prompt: "hello" },
        session: { mode: "new", sessionId: "existing" },
      },
      error: /new session/i,
    },
    {
      name: "reused session without an id",
      value: {
        surface: "agent",
        agentName: "assistant",
        input: { prompt: "hello" },
        session: { mode: "reuse" },
      },
      error: /sessionId/i,
    },
    {
      name: "unknown message role",
      value: {
        surface: "agent",
        agentName: "assistant",
        input: { messages: [{ role: "developer", content: "hidden" }] },
      },
      error: /role/i,
    },
  ])("rejects $name", ({ value, error }) => {
    expect(() => normalizeScheduleInvocation(value)).toThrow(error);
  });

  it("normalizes a durable task invocation", () => {
    expect(normalizeScheduleInvocation({
      surface: "task",
      agentName: "researcher",
      title: " Daily research ",
      prompt: " Find relevant updates ",
      userId: " user-1 ",
      metadata: { team: "product" },
      execution: { sandbox: { isolation: "reuse" } },
    })).toEqual({
      surface: "task",
      agentName: "researcher",
      title: "Daily research",
      prompt: "Find relevant updates",
      userId: "user-1",
      metadata: { team: "product" },
      execution: { sandbox: { isolation: "reuse" } },
    });
  });

  it("preserves shared sandbox isolation in schedule execution", () => {
    expect(normalizeScheduleInvocation({
      surface: "agent",
      agentName: "collaborator",
      input: { messages: [{ role: "user", content: "continue" }] },
      execution: {
        sandbox: {
          isolation: "shared",
          lifecycle: { onRelease: "pool", idleTtlMinutes: 45 },
        },
      },
    })).toMatchObject({
      execution: {
        sandbox: {
          isolation: "shared",
          lifecycle: { onRelease: "pool", idleTtlMinutes: 45 },
        },
      },
    });
  });

  it("preserves strict sandbox volume selections in schedule execution", () => {
    expect(normalizeScheduleInvocation({
      surface: "agent",
      agentName: "builder",
      input: { messages: [{ role: "user", content: "continue" }] },
      execution: {
        sandbox: {
          volumes: [
            { name: "workspace", access: "read-write", writeBack: "manual" },
            { name: "reference", access: "read-only" },
          ],
        },
      },
    })).toMatchObject({
      execution: {
        sandbox: {
          volumes: [
            { name: "workspace", access: "read-write", writeBack: "manual" },
            { name: "reference", access: "read-only" },
          ],
        },
      },
    });
  });

  it.each([
    { volumes: [{ name: "workspace" }, { name: "workspace" }] },
    { volumes: [{ name: "Workspace" }] },
    { volumes: [{ name: "workspace", access: "read-only", writeBack: "auto" }] },
    { volumes: [{ name: "workspace", unknown: true }] },
  ])("rejects unsafe schedule sandbox volumes %#", ({ volumes }) => {
    expect(() => normalizeScheduleInvocation({
      surface: "agent",
      agentName: "builder",
      input: { messages: [{ role: "user", content: "continue" }] },
      execution: { sandbox: { volumes } as any },
    })).toThrow(/volume/i);
  });

  it("preserves explicit sandbox stop and delete controls", () => {
    expect(normalizeScheduleInvocation({
      surface: "agent",
      agentName: "builder",
      input: { prompt: "build" },
      execution: {
        sandbox: {
          isolation: "fresh",
          lifecycle: {
            onRelease: "pool",
            stopAfterIdleMinutes: 30,
            deleteAfterStopMinutes: 60,
          },
        },
      },
    })).toMatchObject({
      execution: {
        sandbox: {
          lifecycle: {
            onRelease: "pool",
            stopAfterIdleMinutes: 30,
            deleteAfterStopMinutes: 60,
          },
        },
      },
    });
  });

  it("rejects mixed legacy and explicit schedule lifecycle controls", () => {
    expect(() => normalizeScheduleInvocation({
      surface: "agent",
      agentName: "builder",
      input: { prompt: "build" },
      execution: {
        sandbox: {
          lifecycle: {
            onRelease: "pool",
            idleTtlMinutes: 30,
            deleteAfterStopMinutes: 30,
          },
        },
      },
    })).toThrow(/cannot be mixed/i);
  });

  it("enforces distinct channel send and agent-reply contracts", () => {
    expect(normalizeScheduleInvocation({
      surface: "channel",
      channelId: " telegram-primary ",
      routeId: " route-1 ",
      externalThreadId: " thread-1 ",
      mode: "send",
      text: " Scheduled update ",
      metadata: { campaign: "launch" },
    })).toEqual({
      surface: "channel",
      channelId: "telegram-primary",
      routeId: "route-1",
      externalThreadId: "thread-1",
      mode: "send",
      text: "Scheduled update",
      metadata: { campaign: "launch" },
    });

    expect(normalizeScheduleInvocation({
      surface: "channel",
      channelId: "telegram-primary",
      mode: "agent_reply",
      agentName: "assistant",
      prompt: "Summarize the day",
      execution: { model: "openai/gpt-5" },
    })).toMatchObject({
      mode: "agent_reply",
      agentName: "assistant",
      prompt: "Summarize the day",
    });
  });

  it.each([
    {
      value: {
        surface: "channel",
        channelId: "telegram",
        mode: "send",
        prompt: "wrong",
      },
      error: /prompt|text/i,
    },
    {
      value: {
        surface: "channel",
        channelId: "telegram",
        mode: "send",
        text: "hello",
        execution: { model: "openai/gpt-5" },
      },
      error: /execution/i,
    },
    {
      value: {
        surface: "channel",
        channelId: "telegram",
        mode: "agent_reply",
        agentName: "assistant",
        prompt: "hello",
        text: "ambiguous",
      },
      error: /text/i,
    },
    {
      value: {
        surface: "channel",
        channelId: "telegram",
        mode: "agent_reply",
        prompt: "missing agent",
      },
      error: /agentName/i,
    },
  ])("rejects invalid channel mode payloads", ({ value, error }) => {
    expect(() => normalizeScheduleInvocation(value)).toThrow(error);
  });

  it("normalizes webhook and legacy mission invocations", () => {
    expect(normalizeScheduleInvocation({
      surface: "webhook",
      webhookId: " release-hook ",
      payload: { deployment: 42 },
    })).toEqual({
      surface: "webhook",
      webhookId: "release-hook",
      payload: { deployment: 42 },
    });

    expect(normalizeScheduleInvocation({
      surface: "legacy_mission",
      missionId: " mission-1 ",
    })).toEqual({
      surface: "legacy_mission",
      missionId: "mission-1",
    });
  });

  it("rejects unsupported surfaces, fields, and execution options", () => {
    expect(() => normalizeScheduleInvocation({
      surface: "loop",
      loop: "review",
    })).toThrow(/surface/i);

    expect(() => normalizeScheduleInvocation({
      surface: "webhook",
      webhookId: "hook",
      execution: { model: "openai/gpt-5" },
    })).toThrow(/execution/);

    expect(() => normalizeScheduleInvocation({
      surface: "task",
      agentName: "assistant",
      title: "task",
      prompt: "run",
      priority: "future",
    })).toThrow(/priority/);

    expect(() => normalizeScheduleInvocation({
      surface: "agent",
      agentName: "assistant",
      input: { prompt: "run" },
      execution: { temperature: 0.2 },
    })).toThrow(/temperature/);
  });
});

describe("schedule definition validation", () => {
  it("normalizes defaults without retaining unknown input", () => {
    const normalized = normalizeCreateScheduleInput({
      id: " schedule-1 ",
      name: " Daily summary ",
      description: " Summarize activity ",
      timing: {
        kind: "cron",
        expression: "0 9 * * 1-5",
        timezone: "Europe/Rome",
      },
      invocation: {
        surface: "agent",
        agentName: "assistant",
        input: { prompt: "Summarize yesterday" },
      },
    }, { now: NOW });

    expect(normalized).toEqual({
      id: "schedule-1",
      name: "Daily summary",
      description: "Summarize activity",
      timing: {
        kind: "cron",
        expression: "0 9 * * 1-5",
        timezone: "Europe/Rome",
      },
      invocation: {
        surface: "agent",
        agentName: "assistant",
        input: { prompt: "Summarize yesterday" },
      },
      status: "active",
      policy: {
        catchUp: "skip",
        misfireGraceSeconds: 300,
        maxConcurrency: 1,
      },
      metadata: {},
    });
  });

  it("normalizes explicit policy and paused creation", () => {
    expect(normalizeCreateScheduleInput({
      name: "One time",
      timing: {
        kind: "once",
        at: "2026-07-29T10:00:00Z",
        timezone: "UTC",
      },
      invocation: {
        surface: "webhook",
        webhookId: "hook-1",
      },
      status: "paused",
      policy: {
        catchUp: "latest",
        misfireGraceSeconds: 0,
        maxConcurrency: 12,
      },
      metadata: { owner: "ops" },
    }, { now: NOW })).toMatchObject({
      status: "paused",
      policy: {
        catchUp: "latest",
        misfireGraceSeconds: 0,
        maxConcurrency: 12,
      },
    });
  });

  it.each([
    [{ catchUp: "all" }, /catchUp/i],
    [{ misfireGraceSeconds: -1 }, /misfireGraceSeconds/i],
    [{ misfireGraceSeconds: 1.5 }, /misfireGraceSeconds/i],
    [{ maxConcurrency: 0 }, /maxConcurrency/i],
    [{ maxConcurrency: SCHEDULE_LIMITS.maxConcurrency + 1 }, /maxConcurrency/i],
    [{ futurePolicy: true }, /futurePolicy/i],
  ])("rejects an invalid policy", (policy, error) => {
    expect(() => normalizeCreateScheduleInput({
      timing: {
        kind: "cron",
        expression: "0 9 * * *",
        timezone: "UTC",
      },
      invocation: {
        surface: "legacy_mission",
        missionId: "mission-1",
      },
      policy,
    }, { now: NOW })).toThrow(error);
  });

  it("rejects terminal creation states and unknown definition fields", () => {
    const base = {
      timing: {
        kind: "cron",
        expression: "0 9 * * *",
        timezone: "UTC",
      },
      invocation: {
        surface: "legacy_mission",
        missionId: "mission-1",
      },
    };

    expect(() => normalizeCreateScheduleInput({
      ...base,
      status: "deleted",
    }, { now: NOW })).toThrow(/status/i);

    expect(() => normalizeCreateScheduleInput({
      ...base,
      credentials: { token: "secret" },
    }, { now: NOW })).toThrow(/credentials/);
  });

  it("rejects cyclic, polluted, non-finite, and oversized metadata", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const polluted = JSON.parse('{"__proto__":{"admin":true}}');
    const base = {
      timing: {
        kind: "cron",
        expression: "0 9 * * *",
        timezone: "UTC",
      },
      invocation: {
        surface: "legacy_mission",
        missionId: "mission-1",
      },
    };

    for (const metadata of [
      cyclic,
      polluted,
      { invalid: Number.POSITIVE_INFINITY },
      { invalid: () => "unsafe" },
      { text: "x".repeat(SCHEDULE_LIMITS.metadataBytes + 1) },
    ]) {
      expect(() => normalizeCreateScheduleInput({
        ...base,
        metadata,
      }, { now: NOW })).toThrow(/metadata/i);
    }
  });

  it("normalizes update patches and rejects empty or immutable changes", () => {
    expect(normalizeUpdateScheduleInput({
      description: null,
      status: "paused",
      policy: { maxConcurrency: 2 },
      metadata: { owner: "ops" },
    }, { now: NOW })).toEqual({
      description: null,
      status: "paused",
      policy: { maxConcurrency: 2 },
      metadata: { owner: "ops" },
    });

    expect(() => normalizeUpdateScheduleInput({}, { now: NOW })).toThrow(/at least one/i);
    expect(() => normalizeUpdateScheduleInput({
      id: "new-id",
    }, { now: NOW })).toThrow(/id/);
    expect(() => normalizeUpdateScheduleInput({
      status: "deleted",
    }, { now: NOW })).toThrow(/status/i);
  });
});

describe("legacy mission schedule translation", () => {
  it("translates a recurring mission cron request with compatibility metadata", () => {
    expect(translateLegacyMissionSchedule({
      missionId: " mission-1 ",
      expression: " 0 9 * * 1-5 ",
      recurring: true,
      endDate: "2026-08-30T12:00:00+02:00",
    }, { now: NOW, timezone: "Europe/Rome" })).toEqual({
      name: "Mission mission-1 schedule",
      timing: {
        kind: "cron",
        expression: "0 9 * * 1-5",
        timezone: "Europe/Rome",
      },
      invocation: {
        surface: "legacy_mission",
        missionId: "mission-1",
      },
      status: "active",
      policy: {
        catchUp: "skip",
        misfireGraceSeconds: 300,
        maxConcurrency: 1,
      },
      metadata: {
        compatibility: {
          source: "mission-v1",
          recurring: true,
          endDate: "2026-08-30T10:00:00.000Z",
          deprecated: true,
        },
      },
    });
  });

  it("translates an ISO one-time mission request", () => {
    expect(translateLegacyMissionSchedule({
      missionId: "mission-1",
      expression: "2026-07-29T10:00:00Z",
      recurring: false,
    }, { now: NOW })).toMatchObject({
      timing: {
        kind: "once",
        at: "2026-07-29T10:00:00.000Z",
        timezone: "UTC",
      },
      invocation: {
        surface: "legacy_mission",
        missionId: "mission-1",
      },
      metadata: {
        compatibility: {
          source: "mission-v1",
          recurring: false,
          deprecated: true,
        },
      },
    });
  });

  it("preserves legacy one-shot cron intent explicitly", () => {
    expect(translateLegacyMissionSchedule({
      missionId: "mission-1",
      expression: "0 9 * * *",
      recurring: false,
    }, { now: NOW })).toMatchObject({
      timing: {
        kind: "cron",
        expression: "0 9 * * *",
      },
      metadata: {
        compatibility: {
          source: "mission-v1",
          recurring: false,
          maxOccurrences: 1,
          deprecated: true,
        },
      },
    });
  });

  it("rejects invalid legacy requests instead of guessing", () => {
    expect(() => translateLegacyMissionSchedule({
      missionId: "",
      expression: "tomorrow",
    }, { now: NOW })).toThrow(/missionId/i);

    expect(() => translateLegacyMissionSchedule({
      missionId: "mission-1",
      expression: "tomorrow",
    }, { now: NOW })).toThrow(/expression/i);

    expect(() => translateLegacyMissionSchedule({
      missionId: "mission-1",
      expression: "2026-07-27T10:00:00Z",
    }, { now: NOW })).toThrow(/future/i);
  });
});
