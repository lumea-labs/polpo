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
});
