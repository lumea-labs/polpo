import { describe, expect, it } from "vitest";
import {
  ToolProgressTracker,
  ToolProgressStallError,
} from "./tool-progress.js";

const stableRead = {
  readOnlyHint: true,
  idempotentHint: true,
  resultStability: "stable",
} as const;

describe("ToolProgressTracker", () => {
  it("reuses a stable read and stops a repeated-call livelock", () => {
    const tracker = new ToolProgressTracker({ maxIdenticalObservations: 4 });
    const call = { name: "skill_read", args: { name: "frontend-design" }, annotations: stableRead };

    expect(tracker.inspect(call)).toEqual({ action: "execute" });
    tracker.record({ ...call, result: "skill contents", isError: false });

    expect(tracker.inspect(call)).toMatchObject({
      action: "reuse",
      result: "skill contents",
      observation: 2,
    });
    expect(tracker.inspect(call)).toMatchObject({ action: "reuse", observation: 3 });
    expect(tracker.inspect(call)).toMatchObject({
      action: "stall",
      code: "tool_loop_stalled",
      observation: 4,
    });
  });

  it("never reuses a write, volatile read, or unannotated tool", () => {
    const tracker = new ToolProgressTracker({ maxIdenticalObservations: 2 });
    const cases = [
      { name: "publish", args: {}, annotations: { readOnlyHint: false, idempotentHint: true, resultStability: "stable" } },
      { name: "query", args: {}, annotations: { readOnlyHint: true, idempotentHint: true, resultStability: "volatile" } },
      { name: "unknown", args: {} },
    ] as const;

    for (const call of cases) {
      expect(tracker.inspect(call)).toEqual({ action: "execute" });
      tracker.record({ ...call, result: "same", isError: false });
      expect(tracker.inspect(call)).toEqual({ action: "execute" });
    }
  });

  it("treats object key order as the same canonical arguments", () => {
    const tracker = new ToolProgressTracker({ maxIdenticalObservations: 3 });
    tracker.record({
      name: "read",
      args: { query: "polpo", filters: { a: 1, b: 2 } },
      annotations: stableRead,
      result: "same",
      isError: false,
    });

    expect(tracker.inspect({
      name: "read",
      args: { filters: { b: 2, a: 1 }, query: "polpo" },
      annotations: stableRead,
    })).toMatchObject({ action: "reuse", observation: 2 });
  });

  it("exposes a typed terminal error", () => {
    const error = new ToolProgressStallError("skill_read", "fingerprint", 4);
    expect(error).toMatchObject({
      name: "ToolProgressStallError",
      code: "tool_loop_stalled",
      toolName: "skill_read",
      observation: 4,
    });
  });
});
