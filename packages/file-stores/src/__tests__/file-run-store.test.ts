/**
 * FileRunStore — durable-turns checkpoint persistence.
 *
 * The runner subprocess writes one checkpoint per completed turn via
 * updateResumeState; orphan recovery reads it back from the active run.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunRecord } from "@polpo-ai/core/run-store";
import { FileRunStore } from "../file-run-store.js";

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  const now = new Date().toISOString();
  return {
    id: "run-1",
    taskId: "task-1",
    pid: 1234,
    agentName: "agent-1",
    status: "running",
    startedAt: now,
    updatedAt: now,
    activity: { filesCreated: [], filesEdited: [], toolCalls: 0, totalTokens: 0, lastUpdate: now },
    configPath: "/tmp/run.json",
    ...overrides,
  };
}

describe("FileRunStore durable turns", () => {
  let dir: string;
  let store: FileRunStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "polpo-file-run-store-"));
    store = new FileRunStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("updateResumeState round-trips the checkpoint", async () => {
    await store.upsertRun(makeRun());

    await store.updateResumeState!("run-1", {
      context: {},
      steps: [],
      loopName: "default",
      turn: 3,
      history: [
        { role: "user", content: "task prompt" },
        { role: "assistant", content: [{ type: "text", text: "on it" }] },
      ],
      accumText: "on it",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const fetched = await store.getRun("run-1");
    expect(fetched!.resumeState).toMatchObject({ loopName: "default", turn: 3 });
    expect(fetched!.resumeState!.history).toHaveLength(2);

    // Recovery path reads active runs.
    const active = await store.getActiveRuns();
    expect(active[0].resumeState!.turn).toBe(3);
  });

  it("persists concurrent trace events and correlates runs by session", async () => {
    await store.upsertRun(makeRun({
      id: "run-a",
      taskId: "chat-a",
      sessionId: "session-a",
      delivery: "stream",
      trace: [],
    }));
    await store.upsertRun(makeRun({
      id: "run-b",
      taskId: "chat-b",
      sessionId: "session-a",
      delivery: "stream",
      startedAt: "2099-01-01T00:00:00Z",
      trace: [],
    }));

    await Promise.all([
      store.appendTrace!("run-a", {
        id: "event-a",
        type: "sandbox.acquire.started",
        ts: "2025-01-01T00:00:01Z",
        operation: "acquire",
      }),
      store.appendTrace!("run-a", {
        id: "event-b",
        type: "sandbox.acquired",
        ts: "2025-01-01T00:00:02Z",
        operation: "acquire",
        sandboxId: "sandbox-a",
      }),
    ]);
    await store.appendTrace!("run-a", {
      id: "event-a",
      type: "sandbox.acquire.started",
      ts: "2025-01-01T00:00:01Z",
      operation: "acquire",
    });

    const trace = (await store.getRun("run-a"))?.trace ?? [];
    expect(trace).toHaveLength(2);
    expect(new Set(trace.map((event) => event.id))).toEqual(new Set(["event-a", "event-b"]));
    expect((await store.getRunsBySessionId!("session-a")).map((run) => run.id)).toEqual([
      "run-b",
      "run-a",
    ]);
  });

  it("updateResumeState on a missing run is a no-op", async () => {
    await expect(
      store.updateResumeState!("nope", {
        context: {}, steps: [], turn: 0, history: [], createdAt: new Date().toISOString(),
      }),
    ).resolves.toBeUndefined();
  });

  it("updateActivity preserves an existing checkpoint", async () => {
    await store.upsertRun(makeRun());
    await store.updateResumeState!("run-1", {
      context: {}, steps: [], loopName: "default", turn: 1,
      history: [{ role: "user", content: "hi" }],
      createdAt: new Date().toISOString(),
    });

    await store.updateActivity("run-1", {
      filesCreated: [], filesEdited: [], toolCalls: 5, totalTokens: 100, lastUpdate: new Date().toISOString(),
    });

    const fetched = await store.getRun("run-1");
    expect(fetched!.activity.toolCalls).toBe(5);
    expect(fetched!.resumeState!.turn).toBe(1);
  });

  it("acknowledges terminal runs without deleting their history", async () => {
    await store.upsertRun(makeRun({ delivery: "background" }));
    await store.completeRun("run-1", "failed", {
      exitCode: 1, stdout: "", stderr: "spawn failed", duration: 2,
    });
    expect(await store.getTerminalRuns()).toHaveLength(1);

    await store.markRunCollected!("run-1");

    expect(await store.getTerminalRuns()).toEqual([]);
    expect((await store.getRun("run-1"))?.result?.stderr).toBe("spawn failed");
    expect((await store.getRun("run-1"))?.collectedAt).toBeTruthy();
  });

  it("spawn metadata updates cannot resurrect a completed run", async () => {
    await store.upsertRun(makeRun());
    await store.completeRun("run-1", "completed", {
      exitCode: 0, stdout: "done", stderr: "", duration: 1,
    });

    await store.updateSpawnInfo!("run-1", 9876, "memory://run-1");

    const fetched = await store.getRun("run-1");
    expect(fetched?.status).toBe("completed");
    expect(fetched?.pid).toBe(9876);
    expect(fetched?.result?.stdout).toBe("done");
  });
});
