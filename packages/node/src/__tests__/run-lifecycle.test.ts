/**
 * executeRun — the shared run lifecycle (run-lifecycle.ts).
 *
 * This is the exact code path the subprocess runner (core/runner.ts) has
 * always executed, now extracted so the InProcessSpawner can share it.
 * Contract under test:
 *
 * 1. Happy path: initial "running" record → engine → terminal "completed"
 *    record with the TaskResult, plus the JSONL activity log with the
 *    spawning/spawned/done lifecycle events and the transcript entries.
 * 2. Engine failure → run "failed" with the error in stderr (exitCode 1);
 *    executeRun resolves — it never throws for run-level failures.
 * 3. Abort (the SIGTERM path) → engine killed, run "killed", exitCode
 *    forced to 1 with the historical "Killed by SIGTERM" stderr marker.
 * 4. Durable turns: per-turn checkpoints land on the run record via
 *    RunStore.updateResumeState; config.resumeState resumes at turn + 1
 *    without re-executing recorded tools.
 * 5. Spawn failure (engine cannot even start) → run "failed" and
 *    spawnError: true (the subprocess entry exits 1 on this — the one
 *    non-zero-exit lifecycle path).
 *
 * Mock strategy: same as engine-behavior/loop-engine-durable-turns —
 * vi.mock @polpo-ai/llm so resolveModel returns a MockLanguageModelV3;
 * stores and filesystem run for real against a temp dir.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, mkdir, rm, readFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedModel } from "@polpo-ai/llm";
import {
  MockLanguageModelV3,
  mockTextModel,
  mockTurnSequenceModel,
  mockResolvedModel,
  type MockResponse,
} from "./helpers/mock-llm.js";

// ── Mock the LLM module BEFORE any imports that pull it in ──

let activeResolvedModel: ResolvedModel = mockResolvedModel(mockTextModel("default"));

vi.mock("@polpo-ai/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@polpo-ai/llm")>();
  return {
    ...actual,
    resolveModel: () => activeResolvedModel,
    enforceModelAllowlist: () => {},
    mapReasoningToProviderOptions: () => undefined,
  };
});

// Switchable engine-spawn failure (for the spawnError path).
let throwOnSpawn: Error | undefined;
vi.mock("../adapters/loop-engine.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../adapters/loop-engine.js")>();
  return {
    ...actual,
    spawnLoopEngine: (...args: Parameters<typeof actual.spawnLoopEngine>) => {
      if (throwOnSpawn) throw throwOnSpawn;
      return actual.spawnLoopEngine(...args);
    },
  };
});

import { executeRun } from "../core/run-lifecycle.js";
import { InMemoryRunStore } from "./fixtures.js";
import type { AgentConfig, Task, RunnerConfig } from "@polpo-ai/core/types";
import type { LoopResumeState } from "@polpo-ai/core/loop-run-store";

// ── Helpers ─────────────────────────────────────────────

function setMockModel(model: MockLanguageModelV3, overrides: Partial<ResolvedModel> = {}) {
  activeResolvedModel = { ...mockResolvedModel(model), ...overrides };
}

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { name: "lifecycle-agent", role: "developer", ...overrides };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-lifecycle-1",
    title: "Lifecycle task",
    description: "Do the scripted thing.",
    state: "in_progress",
    expectations: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    assignedTo: "lifecycle-agent",
    ...overrides,
  } as Task;
}

let tmpRoot: string;
let cwd: string;
let polpoDir: string;
let runSeq = 0;

function makeConfig(overrides: Partial<RunnerConfig> = {}): RunnerConfig {
  const runId = `run-lc-${++runSeq}`;
  return {
    runId,
    taskId: makeTask().id,
    agent: makeAgent(),
    task: makeTask(),
    polpoDir,
    cwd,
    outputDir: join(polpoDir, "output", runId),
    ...overrides,
  };
}

/** Read the JSONL activity log for a run. */
async function readActivityLog(runId: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(join(polpoDir, "logs", `run-${runId}.jsonl`), "utf-8");
  return raw.trim().split("\n").map((l) => JSON.parse(l));
}

beforeAll(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "polpo-run-lifecycle-"));
  cwd = join(tmpRoot, "work");
  polpoDir = join(tmpRoot, ".polpo");
  await mkdir(cwd, { recursive: true });
  await mkdir(polpoDir, { recursive: true });
});

afterAll(async () => {
  if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
});

// ── Tests ───────────────────────────────────────────────

describe("executeRun — shared run lifecycle", () => {
  test("happy path: running → completed, result + transcript persisted", async () => {
    setMockModel(mockTurnSequenceModel([
      { type: "tool-call", toolName: "write", args: { path: "lc-a.txt", content: "hello" } },
      { type: "text", text: "lifecycle done" },
    ]));
    const store = new InMemoryRunStore();
    const config = makeConfig();

    const outcome = await executeRun(config, {
      runStore: store,
      pid: 4242,
      configPath: `memory://${config.runId}`,
    });

    expect(outcome.status).toBe("completed");
    expect(outcome.spawnError).toBeUndefined();
    expect(outcome.result.exitCode).toBe(0);
    expect(outcome.result.stdout).toBe("lifecycle done");

    // Terminal run record with the result and the injected pid.
    const run = await store.getRun(config.runId);
    expect(run?.status).toBe("completed");
    expect(run?.pid).toBe(4242);
    expect(run?.result?.stdout).toBe("lifecycle done");
    expect(run?.configPath).toBe(`memory://${config.runId}`);

    // Tool side-effect ran for real.
    expect(await readFile(join(cwd, "lc-a.txt"), "utf-8")).toBe("hello");

    // JSONL activity log: lifecycle events + transcript entries.
    const log = await readActivityLog(config.runId);
    const events = log.map((e) => e.event ?? e.type);
    expect(events).toContain("spawning");
    expect(events).toContain("spawned");
    expect(events).toContain("done");
    expect(events).toContain("tool_use");
    expect(events).toContain("tool_result");
    expect(events).toContain("assistant");
    expect(log[0].pid).toBe(4242);
  });

  test("onEvent (F1a): a streaming host receives each transcript entry live, teed alongside persistence", async () => {
    setMockModel(mockTurnSequenceModel([
      { type: "tool-call", toolName: "write", args: { path: "ev-a.txt", content: "hi" } },
      { type: "text", text: "streamed" },
    ]));
    const store = new InMemoryRunStore();
    const config = makeConfig();
    const events: Record<string, unknown>[] = [];

    const outcome = await executeRun(config, {
      runStore: store,
      pid: 7,
      configPath: `memory://${config.runId}`,
      onEvent: (entry) => events.push(entry),
    });

    expect(outcome.status).toBe("completed");
    // onEvent saw the same entry types the activity log persisted — teed, not replaced.
    const types = events.map((e) => e.type);
    expect(types).toContain("tool_use");
    expect(types).toContain("tool_result");
    expect(types).toContain("assistant");
    expect(events.find((e) => e.type === "assistant")?.text).toBe("streamed");
    // Persistence still happened (tee, not replace).
    const log = await readActivityLog(config.runId);
    expect(log.map((e) => e.event ?? e.type)).toContain("assistant");
  });

  test("onEvent (F1a): a throwing subscriber never sinks the run", async () => {
    setMockModel(mockTurnSequenceModel([{ type: "text", text: "resilient" }]));
    const store = new InMemoryRunStore();
    const config = makeConfig();

    const outcome = await executeRun(config, {
      runStore: store,
      pid: 8,
      configPath: `memory://${config.runId}`,
      onEvent: () => { throw new Error("subscriber boom"); },
    });

    expect(outcome.status).toBe("completed");
    expect(outcome.result.stdout).toBe("resilient");
  });

  test("engine failure: run marked failed, executeRun resolves (never throws)", async () => {
    setMockModel(new MockLanguageModelV3({
      doStream: () => { throw new Error("model exploded"); },
    }));
    const store = new InMemoryRunStore();
    const config = makeConfig();

    const outcome = await executeRun(config, {
      runStore: store, pid: 1, configPath: "memory://x",
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.spawnError).toBeUndefined();
    expect(outcome.result.exitCode).toBe(1);
    const run = await store.getRun(config.runId);
    expect(run?.status).toBe("failed");
    // The AI SDK surfaces stream errors as its "No output generated" error
    // — the exact legacy path (see loop-engine.ts modelStep).
    expect(run?.result?.stderr).toContain("No output generated");
  });

  test("abort: engine killed, run 'killed', exitCode forced to 1", async () => {
    // A model that never finishes its stream until aborted.
    let releaseStream: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { releaseStream = resolve; });
    setMockModel(new MockLanguageModelV3({
      doStream: async (opts) => {
        // Block until the abort signal fires, then throw AbortError like a
        // real provider would.
        await new Promise<void>((resolve, reject) => {
          const signal = opts.abortSignal;
          if (signal?.aborted) return reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
          void blocked.then(resolve);
        });
        return { stream: new ReadableStream() };
      },
    }));

    const store = new InMemoryRunStore();
    const config = makeConfig();
    const abort = new AbortController();

    const running = executeRun(config, {
      runStore: store, pid: 7, configPath: "memory://x", signal: abort.signal,
    });

    // Wait for the run record to appear, then abort mid-turn.
    await vi.waitFor(async () => {
      expect((await store.getRun(config.runId))?.status).toBe("running");
    });
    abort.abort();

    const outcome = await running;
    releaseStream?.();

    expect(outcome.status).toBe("killed");
    expect(outcome.result.exitCode).toBe(1);
    expect(outcome.result.stderr).toContain("Killed by SIGTERM (timeout or shutdown)");
    expect((await store.getRun(config.runId))?.status).toBe("killed");
    const log = await readActivityLog(config.runId);
    expect(log.map((e) => e.event)).toContain("sigterm");
  });

  test("durable turns: checkpoints land on the run record, resume skips recorded tools", async () => {
    // ── Run 1: turn 0 writes a file, then the model crashes ──
    let calls = 0;
    const inner = mockTurnSequenceModel([
      { type: "tool-call", toolName: "write", args: { path: "lc-resume.txt", content: "turn zero" } },
    ]);
    setMockModel(new MockLanguageModelV3({
      doStream: (opts) => {
        if (calls++ >= 1) throw new Error("simulated crash");
        return inner.doStream(opts);
      },
    }));

    const store = new InMemoryRunStore();
    const config = makeConfig();
    const crash = await executeRun(config, { runStore: store, pid: 1, configPath: "memory://x" });
    expect(crash.status).toBe("failed");

    // The turn-0 checkpoint was persisted through RunStore.updateResumeState.
    const crashedRun = await store.getRun(config.runId);
    const checkpoint = crashedRun?.resumeState as LoopResumeState;
    expect(checkpoint?.turn).toBe(0);
    expect(checkpoint?.loopName).toBe("default");
    expect(JSON.stringify(checkpoint.history)).toContain("lc-resume.txt");

    // Wipe the side-effect so re-execution would be visible.
    await unlink(join(cwd, "lc-resume.txt"));

    // ── Run 2: resume from the harvested checkpoint ──
    setMockModel(mockTurnSequenceModel([{ type: "text", text: "resumed fine" }]));
    const config2 = makeConfig({ resumeState: checkpoint });
    const resumed = await executeRun(config2, { runStore: store, pid: 2, configPath: "memory://y" });

    expect(resumed.status).toBe("completed");
    expect(resumed.result.stdout).toBe("resumed fine");
    // Temporal semantics: the recorded turn-0 tool did NOT re-execute.
    expect(existsSync(join(cwd, "lc-resume.txt"))).toBe(false);
    // Turn numbering continued past the checkpoint.
    const resumedRun = await store.getRun(config2.runId);
    expect((resumedRun?.resumeState as LoopResumeState)?.turn).toBe(1);
    // The lifecycle logged the resume.
    const log = await readActivityLog(config2.runId);
    expect(log.map((e) => e.event)).toContain("resuming");
  });

  test("spawn failure: run failed + spawnError=true (subprocess exits 1 on this)", async () => {
    throwOnSpawn = new Error("engine could not start");
    try {
      const store = new InMemoryRunStore();
      const config = makeConfig();
      const outcome = await executeRun(config, { runStore: store, pid: 1, configPath: "memory://x" });

      expect(outcome.spawnError).toBe(true);
      expect(outcome.status).toBe("failed");
      expect(outcome.result.stderr).toContain("engine could not start");
      expect((await store.getRun(config.runId))?.status).toBe("failed");
    } finally {
      throwOnSpawn = undefined;
    }
  });

  test("transcript goes through the injected log session (DB-mode parity)", async () => {
    setMockModel(mockTurnSequenceModel([{ type: "text", text: "with session" }]));
    const store = new InMemoryRunStore();
    const config = makeConfig();
    const appended: Array<{ event: string }> = [];

    const outcome = await executeRun(config, {
      runStore: store,
      pid: 1,
      configPath: "memory://x",
      createLogSession: async () => ({
        sessionId: "sess-123",
        append: async (entry) => { appended.push(entry as { event: string }); },
      }),
    });

    expect(outcome.status).toBe("completed");
    // sessionId linked on the run record's activity from the very start.
    const run = await store.getRun(config.runId);
    expect(run?.activity.sessionId).toBe("sess-123");
    // Transcript entries flowed through the session.
    expect(appended.some((e) => e.event === "transcript:assistant")).toBe(true);
  });
});
