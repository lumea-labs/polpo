import { describe, expect, it } from "vitest";
import {
  SCHEDULE_RUN_STATUS_TRANSITIONS,
  SCHEDULE_STATUS_TRANSITIONS,
  assertScheduleRunStatusTransition,
  assertScheduleStatusTransition,
  isScheduleRunStatusTransitionAllowed,
  isScheduleStatusTransitionAllowed,
  isTerminalScheduleRunStatus,
  type ScheduleRunStatus,
  type ScheduleStatus,
} from "./index.js";

describe("schedule lifecycle state machine", () => {
  it.each([
    ["active", "paused"],
    ["active", "completed"],
    ["active", "deleted"],
    ["paused", "active"],
    ["paused", "completed"],
    ["paused", "deleted"],
    ["completed", "deleted"],
  ] as const)("allows %s -> %s", (from, to) => {
    expect(isScheduleStatusTransitionAllowed(from, to)).toBe(true);
    expect(() => assertScheduleStatusTransition(from, to)).not.toThrow();
  });

  it.each([
    ["completed", "active"],
    ["completed", "paused"],
    ["deleted", "active"],
    ["deleted", "paused"],
    ["deleted", "completed"],
  ] as const)("rejects %s -> %s", (from, to) => {
    expect(isScheduleStatusTransitionAllowed(from, to)).toBe(false);
    expect(() => assertScheduleStatusTransition(from, to)).toThrow(
      `${from} -> ${to}`,
    );
  });

  it("allows idempotent same-state checks without adding transition edges", () => {
    const states: ScheduleStatus[] = ["active", "paused", "completed", "deleted"];
    for (const state of states) {
      expect(isScheduleStatusTransitionAllowed(state, state)).toBe(true);
      expect(SCHEDULE_STATUS_TRANSITIONS[state]).not.toContain(state);
    }
  });
});

describe("schedule run lifecycle state machine", () => {
  it.each([
    ["pending", "claimed"],
    ["pending", "skipped"],
    ["pending", "cancelled"],
    ["claimed", "pending"],
    ["claimed", "running"],
    ["claimed", "failed"],
    ["running", "pending"],
    ["running", "claimed"],
    ["running", "succeeded"],
    ["running", "failed"],
    ["running", "cancelled"],
  ] as const)("allows %s -> %s", (from, to) => {
    expect(isScheduleRunStatusTransitionAllowed(from, to)).toBe(true);
    expect(() => assertScheduleRunStatusTransition(from, to)).not.toThrow();
  });

  it.each([
    ["pending", "succeeded"],
    ["succeeded", "running"],
    ["failed", "claimed"],
    ["skipped", "pending"],
    ["cancelled", "claimed"],
  ] as const)("rejects %s -> %s", (from, to) => {
    expect(isScheduleRunStatusTransitionAllowed(from, to)).toBe(false);
    expect(() => assertScheduleRunStatusTransition(from, to)).toThrow(
      `${from} -> ${to}`,
    );
  });

  it("keeps every terminal state terminal", () => {
    const terminal: ScheduleRunStatus[] = [
      "succeeded",
      "failed",
      "skipped",
      "cancelled",
    ];
    for (const state of terminal) {
      expect(isTerminalScheduleRunStatus(state)).toBe(true);
      expect(SCHEDULE_RUN_STATUS_TRANSITIONS[state]).toEqual([]);
    }
    expect(isTerminalScheduleRunStatus("pending")).toBe(false);
    expect(isTerminalScheduleRunStatus("claimed")).toBe(false);
    expect(isTerminalScheduleRunStatus("running")).toBe(false);
  });
});
