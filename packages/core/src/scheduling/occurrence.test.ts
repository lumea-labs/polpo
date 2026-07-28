import { describe, expect, it } from "vitest";
import type { Schedule } from "./types.js";
import {
  listScheduleOccurrences,
  nextScheduleOccurrence,
  scheduleOccurrenceIdentity,
} from "./occurrence.js";

function schedule(
  overrides: Partial<Schedule> = {},
): Schedule {
  return {
    id: "schedule-1",
    timing: {
      kind: "cron",
      expression: "0 9 * * *",
      timezone: "UTC",
    },
    invocation: {
      surface: "agent",
      agentName: "assistant",
      input: { prompt: "Run" },
    },
    status: "active",
    policy: {
      catchUp: "skip",
      misfireGraceSeconds: 300,
      maxConcurrency: 1,
    },
    metadata: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    revision: 1,
    ...overrides,
  };
}

describe("schedule occurrence calculation", () => {
  it("returns the next UTC minute exclusively and normalizes seconds", () => {
    const result = nextScheduleOccurrence(
      schedule({
        timing: {
          kind: "cron",
          expression: "*/5 * * * *",
          timezone: "UTC",
        },
      }),
      "2026-07-28T10:00:45.000Z",
    );

    expect(result).toEqual({
      occurrenceAt: "2026-07-28T10:05:00.000Z",
      localKey: "2026-07-28T10:05[UTC]",
      triggerId: "local:schedule-1:2026-07-28T10:05[UTC]",
      idempotencyKey: "schedule:schedule-1:2026-07-28T10:05[UTC]",
    });
  });

  it("evaluates cron in its IANA timezone", () => {
    const result = nextScheduleOccurrence(
      schedule({
        timing: {
          kind: "cron",
          expression: "0 9 * * *",
          timezone: "Europe/Rome",
        },
      }),
      "2026-07-28T06:00:00.000Z",
    );

    expect(result?.occurrenceAt).toBe("2026-07-28T07:00:00.000Z");
    expect(result?.localKey).toBe("2026-07-28T09:00[Europe/Rome]");
  });

  it("uses standard cron OR semantics for day-of-month and day-of-week", () => {
    const result = nextScheduleOccurrence(
      schedule({
        timing: {
          kind: "cron",
          expression: "0 9 1 * 1",
          timezone: "UTC",
        },
      }),
      "2026-09-01T09:00:00.000Z",
    );

    expect(result?.occurrenceAt).toBe("2026-09-07T09:00:00.000Z");
  });

  it("skips nonexistent local time during the spring DST transition", () => {
    const result = nextScheduleOccurrence(
      schedule({
        timing: {
          kind: "cron",
          expression: "30 2 * * *",
          timezone: "Europe/Rome",
        },
      }),
      "2026-03-28T02:31:00.000Z",
    );

    expect(result).toMatchObject({
      occurrenceAt: "2026-03-30T00:30:00.000Z",
      localKey: "2026-03-30T02:30[Europe/Rome]",
    });
  });

  it("deduplicates the repeated local minute during the fall DST transition", () => {
    const results = listScheduleOccurrences(
      schedule({
        timing: {
          kind: "cron",
          expression: "30 2 * * *",
          timezone: "Europe/Rome",
        },
      }),
      {
        after: "2026-10-24T23:00:00.000Z",
        limit: 2,
      },
    );

    expect(results.map((result) => result.localKey)).toEqual([
      "2026-10-25T02:30[Europe/Rome]",
      "2026-10-26T02:30[Europe/Rome]",
    ]);
    expect(new Set(results.map((result) => result.idempotencyKey)).size).toBe(2);
  });

  it("returns a one-time occurrence once and only once", () => {
    const once = schedule({
      timing: {
        kind: "once",
        at: "2026-07-28T10:30:00.000Z",
        timezone: "Europe/Rome",
      },
    });

    expect(
      nextScheduleOccurrence(once, "2026-07-28T10:29:59.999Z"),
    ).toMatchObject({
      occurrenceAt: "2026-07-28T10:30:00.000Z",
      localKey: "2026-07-28T10:30:00.000Z",
    });
    expect(
      nextScheduleOccurrence(once, "2026-07-28T10:30:00.000Z"),
    ).toBeNull();
  });

  it("respects inclusive through bounds and hard list limits", () => {
    const everyMinute = schedule({
      timing: {
        kind: "cron",
        expression: "* * * * *",
        timezone: "UTC",
      },
    });
    expect(listScheduleOccurrences(everyMinute, {
      after: "2026-07-28T10:00:00.000Z",
      through: "2026-07-28T10:02:00.000Z",
      limit: 10,
    }).map((item) => item.occurrenceAt)).toEqual([
      "2026-07-28T10:01:00.000Z",
      "2026-07-28T10:02:00.000Z",
    ]);
    expect(listScheduleOccurrences(everyMinute, {
      after: "2026-07-28T10:00:00.000Z",
      limit: 1,
    })).toHaveLength(1);
    expect(() => listScheduleOccurrences(everyMinute, {
      after: "2026-07-28T10:00:00.000Z",
      limit: 0,
    })).toThrow(/limit/i);
  });

  it("fails closed for invalid dates and mismatched occurrence identities", () => {
    const valid = schedule();
    expect(() => nextScheduleOccurrence(valid, "not-a-date")).toThrow(/after/i);
    expect(() =>
      scheduleOccurrenceIdentity(valid, "2026-07-28T10:00:00.000Z")
    ).toThrow(/does not match/i);
  });

  it("scopes occurrence identities by schedule", () => {
    const at = "2026-07-28T09:00:00.000Z";
    const first = scheduleOccurrenceIdentity(schedule(), at);
    const second = scheduleOccurrenceIdentity(
      schedule({ id: "schedule-2" }),
      at,
    );

    expect(first.localKey).toBe(second.localKey);
    expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
  });
});
