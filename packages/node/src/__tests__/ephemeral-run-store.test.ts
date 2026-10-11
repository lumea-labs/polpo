import { describe, expect, it } from "vitest";
import type { RunRecord } from "@polpo-ai/core/run-store";
import { EphemeralRunStore } from "../server/ephemeral-run-store.js";

describe("ephemeral terminal Run persistence", () => {
  it.each(["completed", "failed", "killed"] as const)("preserves %s through late registration and completion", async status => {
    const store = new EphemeralRunStore();
    const run: RunRecord = { id: "run", taskId: "task", agentName: "support", pid: -1, status: "running",
      startedAt: "now", updatedAt: "now", configPath: "memory://run",
      activity: { filesCreated: [], filesEdited: [], toolCalls: 0, totalTokens: 0, lastUpdate: "now" } };
    await store.upsertRun(run);
    await store.completeRun(run.id, status, { exitCode: 143, stdout: "", stderr: "terminal result", duration: 1 });
    await store.markRunCollected(run.id);
    const terminal = structuredClone(await store.getRun(run.id));
    await store.upsertRun({ ...run, pid: -2 });
    await store.completeRun(run.id, "completed", { exitCode: 0, stdout: "late", stderr: "", duration: 2 });
    expect(await store.getRun(run.id)).toEqual(terminal);
  });
});
