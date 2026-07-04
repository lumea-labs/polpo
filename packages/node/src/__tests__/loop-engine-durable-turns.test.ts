/**
 * Durable turns — per-turn checkpointing and resume on the task loop engine.
 *
 * Contract under test (Phase A):
 * 1. Every completed turn emits exactly one checkpoint through
 *    ctx.onTurnCheckpoint, carrying the serialized conversation history
 *    (ModelMessage[] incl. tool-call/tool-result parts) and the turn index.
 * 2. A run interrupted mid-task leaves the last checkpoint behind; a new
 *    spawn with ctx.resumeState continues at turn + 1: recorded history is
 *    replayed to the model, completed tools are NEVER re-executed
 *    (Temporal semantics — side-effects ride in as recorded results).
 * 3. Checkpoints are post-compaction: after the compactor rewrites history,
 *    the next checkpoint carries the compacted messages, never the
 *    pre-compaction transcript.
 * 4. Oversized histories (> MAX_CHECKPOINT_BYTES) are not persisted — the
 *    previous checkpoint is kept and the run itself is unaffected.
 *
 * Mock strategy: same as engine-behavior.test.ts (vi.mock @polpo-ai/llm so
 * resolveModel returns a MockLanguageModelV3); tool layer and filesystem
 * run for real against a temp dir.
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

// ── Mock pi-client BEFORE any imports that pull it in ──

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

import { spawnLoopEngine, MAX_CHECKPOINT_BYTES } from "../adapters/loop-engine.js";
import type { AgentConfig, Task } from "@polpo-ai/core/types";
import type { LoopResumeState } from "@polpo-ai/core/loop-run-store";

// ── Helpers ─────────────────────────────────────────────

function setMockModel(model: MockLanguageModelV3, overrides: Partial<ResolvedModel> = {}) {
  activeResolvedModel = { ...mockResolvedModel(model), ...overrides };
}

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { name: "durable-agent", role: "developer", ...overrides };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-durable-1",
    title: "Durable task",
    description: "Do the scripted thing.",
    state: "in_progress",
    expectations: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    assignedTo: "durable-agent",
    ...overrides,
  } as Task;
}

/** Sequence model that also captures every doStream prompt (the messages
 *  the engine actually sent to the LLM) — used to prove history seeding. */
function capturingSequenceModel(responses: MockResponse[], prompts: unknown[][]): MockLanguageModelV3 {
  const inner = mockTurnSequenceModel(responses);
  return new MockLanguageModelV3({
    doGenerate: (opts) => inner.doGenerate(opts),
    doStream: (opts) => {
      prompts.push(opts.prompt as unknown[]);
      return inner.doStream(opts);
    },
  });
}

/** Sequence model that plays `responses` then throws — simulates a runner
 *  crash mid-task (the run fails, whatever checkpoint exists survives). */
function crashingAfterModel(responses: MockResponse[]): MockLanguageModelV3 {
  const inner = mockTurnSequenceModel(responses);
  let calls = 0;
  return new MockLanguageModelV3({
    doStream: (opts) => {
      if (calls++ >= responses.length) throw new Error("simulated crash");
      return inner.doStream(opts);
    },
  });
}

/** JSON round-trip — a checkpoint always crosses a store boundary. */
function throughStore(state: LoopResumeState): LoopResumeState {
  return JSON.parse(JSON.stringify(state)) as LoopResumeState;
}

let tmpRoot: string;
let cwd: string;
let polpoDir: string;

beforeAll(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "polpo-durable-turns-"));
  cwd = join(tmpRoot, "work");
  polpoDir = join(tmpRoot, ".polpo");
  await mkdir(cwd, { recursive: true });
  await mkdir(polpoDir, { recursive: true });
});

afterAll(async () => {
  if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
});

interface RunOptions {
  agent?: AgentConfig;
  resumeState?: LoopResumeState;
  taskOverrides?: Partial<Task>;
}

async function runEngine(
  model: MockLanguageModelV3,
  modelOverrides: Partial<ResolvedModel> = {},
  options: RunOptions = {},
) {
  setMockModel(model, modelOverrides);
  const checkpoints: LoopResumeState[] = [];
  const handle = spawnLoopEngine(
    options.agent ?? makeAgent(),
    makeTask(options.taskOverrides),
    cwd,
    {
      polpoDir,
      resumeState: options.resumeState,
      onTurnCheckpoint: (state) => {
        checkpoints.push(throughStore(state));
      },
    },
  );
  const result = await handle.done;
  return { handle, result, checkpoints };
}

// ── Tests ───────────────────────────────────────────────

describe("loop-engine durable turns", () => {
  test("emits one checkpoint per completed turn with history and position", async () => {
    const { result, checkpoints } = await runEngine(
      mockTurnSequenceModel([
        { type: "tool-call", toolName: "write", args: { path: "cp-a.txt", content: "alpha" } },
        { type: "text", text: "all done" },
      ]),
    );

    expect(result.exitCode).toBe(0);
    expect(checkpoints).toHaveLength(2);

    // Turn 0: assistant tool-call + tool result are already in history.
    const cp0 = checkpoints[0];
    expect(cp0.loopName).toBe("default");
    expect(cp0.turn).toBe(0);
    expect(cp0.createdAt).toBeTruthy();
    expect(cp0.updatedAt).toBeTruthy();
    const cp0Json = JSON.stringify(cp0.history);
    expect(cp0Json).toContain("tool-call");
    expect(cp0Json).toContain("tool-result");
    expect(cp0Json).toContain("cp-a.txt");
    // First message is the task prompt.
    expect(JSON.stringify(cp0.history![0])).toContain("Durable task");

    // Turn 1: history grew, position advanced, same logical run.
    const cp1 = checkpoints[1];
    expect(cp1.turn).toBe(1);
    expect(cp1.history!.length).toBeGreaterThan(cp0.history!.length);
    expect(cp1.createdAt).toBe(cp0.createdAt);
    expect(cp1.accumText).toContain("all done");
  });

  test("crash mid-task, then resume: history replayed, no tool re-executed", async () => {
    // ── Run 1: turn 0 writes a file, turn 1 crashes ──
    const crash = await runEngine(
      crashingAfterModel([
        { type: "tool-call", toolName: "write", args: { path: "resume-a.txt", content: "first turn" } },
      ]),
    );

    expect(crash.result.exitCode).toBe(1);
    // The turn-0 checkpoint survived the crash.
    expect(crash.checkpoints).toHaveLength(1);
    const checkpoint = crash.checkpoints[0];
    expect(checkpoint.turn).toBe(0);
    expect(await readFile(join(cwd, "resume-a.txt"), "utf-8")).toBe("first turn");

    // Wipe the side-effect so any re-execution would be visible.
    await unlink(join(cwd, "resume-a.txt"));

    // ── Run 2: resume from the checkpoint ──
    const prompts: unknown[][] = [];
    const resumed = await runEngine(
      capturingSequenceModel(
        [
          { type: "tool-call", toolName: "write", args: { path: "resume-b.txt", content: "second turn" } },
          { type: "text", text: "resumed done" },
        ],
        prompts,
      ),
      {},
      { resumeState: checkpoint },
    );

    expect(resumed.result.exitCode).toBe(0);
    expect(resumed.result.stdout).toBe("resumed done");

    // Temporal semantics: the completed turn's tool did NOT re-execute…
    expect(existsSync(join(cwd, "resume-a.txt"))).toBe(false);
    // …while the resumed run's new tool did.
    expect(await readFile(join(cwd, "resume-b.txt"), "utf-8")).toBe("second turn");

    // The model saw the recorded turn-0 history (tool-call + result),
    // not a fresh conversation.
    const firstPrompt = JSON.stringify(prompts[0]);
    expect(firstPrompt).toContain("resume-a.txt");
    expect(firstPrompt).toContain("tool-result");

    // Turn numbering continues: the first new checkpoint is turn 1.
    expect(resumed.checkpoints[0].turn).toBe(1);
    expect(resumed.checkpoints.map((c) => c.turn)).toEqual([1, 2]);
  });

  test("resume state for a different loop is ignored — fresh start, no crash", async () => {
    const prompts: unknown[][] = [];
    const stale: LoopResumeState = {
      context: {},
      steps: [],
      loopName: "some-other-loop",
      turn: 5,
      history: [
        { role: "user", content: "old prompt" },
        { role: "assistant", content: [{ type: "text", text: "old answer" }] },
      ],
      createdAt: new Date().toISOString(),
    };

    const { result, checkpoints } = await runEngine(
      capturingSequenceModel([{ type: "text", text: "fresh" }], prompts),
      {},
      { resumeState: stale },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("fresh");
    // History was NOT seeded from the mismatched checkpoint…
    expect(JSON.stringify(prompts[0])).not.toContain("old prompt");
    // …and checkpointing restarted from turn 0.
    expect(checkpoints[0].turn).toBe(0);
  });

  test("checkpoints are post-compaction: compacted history is what gets persisted", async () => {
    // Same trigger recipe as the engine-behavior compaction test: an
    // over-threshold task description plus one tool turn makes the
    // summarize phase fire at turn 1 — the turn-1 checkpoint must carry
    // the compacted history, strictly smaller than the turn-0 one.
    const { result, checkpoints } = await runEngine(
      mockTurnSequenceModel([
        { type: "tool-call", toolName: "bash", args: { command: "true" } },
        { type: "text", text: "compacted and finished" },
      ]),
      { contextWindow: 3000, maxTokens: 256 },
      { taskOverrides: { description: "analyze this dataset. ".repeat(600) } },
    );

    expect(result.exitCode).toBe(0);
    expect(checkpoints).toHaveLength(2);
    const size0 = JSON.stringify(checkpoints[0].history).length;
    const size1 = JSON.stringify(checkpoints[1].history).length;
    // Turn 1 ADDED messages (assistant text) yet its checkpoint is smaller:
    // only possible if the persisted history is the post-compaction one.
    expect(size1).toBeLessThan(size0);
    expect(JSON.stringify(checkpoints[1].history)).not.toContain("analyze this dataset. analyze this dataset.");
  });

  test("oversized history is not persisted (cap) and the run is unaffected", async () => {
    const bigContent = "x".repeat(MAX_CHECKPOINT_BYTES + 512 * 1024);
    const { result, checkpoints } = await runEngine(
      mockTurnSequenceModel([
        { type: "tool-call", toolName: "write", args: { path: "big.txt", content: bigContent } },
        { type: "text", text: "big done" },
      ]),
      // Huge context window: keep the compactor out of this test.
      { contextWindow: 100_000_000 },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("big done");
    // The 4MB+ tool-call args live in the history of every turn — no
    // checkpoint fits under the cap, so none is persisted.
    expect(checkpoints).toHaveLength(0);
  });

  test("a throwing checkpoint sink never fails the run", async () => {
    setMockModel(mockTurnSequenceModel([{ type: "text", text: "still fine" }]));
    const handle = spawnLoopEngine(makeAgent(), makeTask(), cwd, {
      polpoDir,
      onTurnCheckpoint: () => {
        throw new Error("store went away");
      },
    });
    const result = await handle.done;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("still fine");
  });
});
