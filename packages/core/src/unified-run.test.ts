import { describe, it, expect } from "vitest";
import {
  isTerminalRunStatus,
  UNIFIED_RUN_TERMINAL_STATUSES,
  type UnifiedRunStatus,
  type UnifiedRunRecord,
} from "./unified-run.js";
import type { RunStatus, RunRecord } from "./run-store.js";
import type { ProjectLoopRunStatus, LoopRunRecord } from "./loop/run-store.js";

describe("unified run vocabulary (F0)", () => {
  it("UnifiedRunStatus is a superset of both run-status vocabularies", () => {
    // Compile-time proof: a value of either source type is assignable to the
    // unified type without a cast. If it stopped being a superset, this file
    // would not typecheck.
    const fromTask: UnifiedRunStatus = "killed" satisfies RunStatus;
    const fromLoop: UnifiedRunStatus = "awaiting_approval" satisfies ProjectLoopRunStatus;
    expect([fromTask, fromLoop]).toEqual(["killed", "awaiting_approval"]);
  });

  it("terminal check covers terminal states from BOTH paths", () => {
    expect(isTerminalRunStatus("completed")).toBe(true);
    expect(isTerminalRunStatus("failed")).toBe(true);
    expect(isTerminalRunStatus("killed")).toBe(true); // task-only terminal
    expect(isTerminalRunStatus("cancelled")).toBe(true); // loop-only terminal
    expect(isTerminalRunStatus("approval_rejected")).toBe(true);
    // non-terminal
    expect(isTerminalRunStatus("running")).toBe(false);
    expect(isTerminalRunStatus("awaiting_approval")).toBe(false);
    expect(isTerminalRunStatus("resuming")).toBe(false);
    expect(isTerminalRunStatus("approval_approved")).toBe(false);
  });

  it("every declared terminal status is a valid unified status", () => {
    expect(UNIFIED_RUN_TERMINAL_STATUSES.every((s) => isTerminalRunStatus(s))).toBe(true);
  });

  it("a task RunRecord's fields fit UnifiedRunRecord (engine=agent, delivery=background) with no loss", () => {
    const task = {
      id: "r1",
      taskId: "t1",
      pid: 123,
      agentName: "coder",
      status: "running",
      startedAt: "2026-07-08T00:00:00Z",
      updatedAt: "2026-07-08T00:00:00Z",
      configPath: "db://r1",
    } satisfies Partial<RunRecord>;

    const unified: UnifiedRunRecord = { ...task, engine: "agent", delivery: "background" };
    expect(unified.taskId).toBe("t1");
    expect(unified.pid).toBe(123);
    expect(unified.delivery).toBe("background");
  });

  it("a loop LoopRunRecord's fields fit UnifiedRunRecord (engine=graph, delivery=stream) with no loss", () => {
    const loop = {
      id: "lr1",
      loopName: "default",
      agentName: "chat",
      status: "awaiting_approval",
      context: {},
      trace: [],
      startedAt: "2026-07-08T00:00:00Z",
      updatedAt: "2026-07-08T00:00:00Z",
    } satisfies Partial<LoopRunRecord>;

    const unified: UnifiedRunRecord = { ...loop, engine: "graph", delivery: "stream" };
    expect(unified.loopName).toBe("default");
    expect(unified.status).toBe("awaiting_approval");
    expect(unified.engine).toBe("graph");
  });
});
