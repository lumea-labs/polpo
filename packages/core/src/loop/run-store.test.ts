import { describe, expect, it } from "vitest";
import { MemoryLoopRunStore } from "./run-store.js";

describe("MemoryLoopRunStore", () => {
  it("persists loop run status, context, and trace events", async () => {
    const store = new MemoryLoopRunStore();
    const run = await store.createRun({
      id: "run-1",
      loop: { name: "coding-flow" },
      agentName: "engineer",
      user: "user-1",
    });

    expect(run).toMatchObject({
      id: "run-1",
      loopName: "coding-flow",
      agentName: "engineer",
      status: "running",
    });

    await store.appendTrace("run-1", {
      id: "trace-1",
      type: "loop.start",
      ts: "2026-06-13T00:00:00.000Z",
      loop: "coding-flow",
      status: "started",
    });
    await store.updateRun("run-1", {
      status: "completed",
      context: { build: { passed: true } },
      completedAt: "2026-06-13T00:00:01.000Z",
    });

    const fetched = await store.getRun("run-1");
    expect(fetched?.trace).toHaveLength(1);
    expect(fetched?.context).toEqual({ build: { passed: true } });
    expect(await store.listRuns({ status: "completed" })).toHaveLength(1);
  });
});
