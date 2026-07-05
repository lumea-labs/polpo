/**
 * Durable turns on PIPELINES — Phase B (task #23).
 *
 * Contract under test:
 * 1. Step boundaries: after every completed pipeline step the engine emits a
 *    composed checkpoint (pipelineName + remaining steps + context bag). A
 *    crash between step N and N+1 resumes without EVER re-executing steps
 *    <= N — their outputs replay from the restored context bag, and the
 *    result is identical to a run that never crashed.
 * 2. In-flight agent steps: the Phase A per-turn checkpoints are wrapped
 *    with the pipeline position — a crash at turn K inside step S resumes
 *    the SAME step at turn K+1 with the recorded session history.
 * 3. while: a crash at iteration I resumes from iteration I (continuation
 *    step carries completedIterations — absolute budget, never restarts
 *    at 0). switch: the chosen branch is inlined at selection time and is
 *    replayed WITHOUT re-evaluating the condition (the choice is history).
 * 4. parallel, deliberate v1 cut: no checkpoints inside the block. A crash
 *    mid-parallel resumes from before the block and re-executes EVERY
 *    branch (also the ones that had completed) — pinned here, not hidden.
 * 5. Compat: pre-existing LoopResumeState formats (human-gate pipeline
 *    resume, Phase A single-session checkpoints) are never misread by the
 *    pipeline path, and pipeline checkpoints never leak into single-session
 *    runs.
 *
 * Mock strategy: same as loop-engine-durable-turns.test.ts (vi.mock
 * @polpo-ai/llm → MockLanguageModelV3); tools and filesystem run for real
 * against a temp dir.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, mkdir, rm, readFile, unlink, writeFile } from "node:fs/promises";
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

import { spawnLoopEngine } from "../adapters/loop-engine.js";
import type { AgentConfig, Task } from "@polpo-ai/core/types";
import type { LoopResumeState } from "@polpo-ai/core/loop-run-store";
import type { Step } from "@polpo-ai/core";

// ── Helpers ─────────────────────────────────────────────

function makeAgent(loopName: string): AgentConfig {
  return {
    name: "pipeline-agent",
    role: "developer",
    assignedLoops: [loopName],
    defaultLoop: loopName,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-pipeline-durable-1",
    title: "Durable pipeline task",
    description: "Do the scripted flow.",
    state: "in_progress",
    expectations: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    assignedTo: "pipeline-agent",
    ...overrides,
  } as Task;
}

/** Sequence model that also captures every doStream prompt — proves which
 *  sessions actually hit the LLM and what history they saw. */
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

/** Plays `responses` then throws — simulates a crash mid-pipeline. */
function crashingAfterModel(responses: MockResponse[], prompts?: unknown[][]): MockLanguageModelV3 {
  const inner = mockTurnSequenceModel(responses);
  let calls = 0;
  return new MockLanguageModelV3({
    doStream: (opts) => {
      if (prompts) prompts.push(opts.prompt as unknown[]);
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
  tmpRoot = await mkdtemp(join(tmpdir(), "polpo-pipeline-durable-"));
  cwd = join(tmpRoot, "work");
  polpoDir = join(tmpRoot, ".polpo");
  await mkdir(cwd, { recursive: true });
  await mkdir(join(polpoDir, "loops"), { recursive: true });
});

afterAll(async () => {
  if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
});

async function writeProjectLoop(name: string, loop: Record<string, unknown>) {
  await writeFile(join(polpoDir, "loops", `${name}.json`), JSON.stringify(loop, null, 2));
}

interface RunOptions {
  agent: AgentConfig;
  resumeState?: LoopResumeState;
}

async function runEngine(model: MockLanguageModelV3, options: RunOptions) {
  activeResolvedModel = mockResolvedModel(model);
  const checkpoints: LoopResumeState[] = [];
  const transcript: Array<Record<string, unknown>> = [];
  const handle = spawnLoopEngine(options.agent, makeTask(), cwd, {
    polpoDir,
    resumeState: options.resumeState,
    onTurnCheckpoint: (state) => {
      checkpoints.push(throughStore(state));
    },
  });
  handle.onTranscript = (entry) => transcript.push(entry);
  const result = await handle.done;
  return { handle, result, checkpoints, transcript };
}

// ── Tests ───────────────────────────────────────────────

describe("pipeline durable turns — step boundaries", () => {
  test("kill between step N and N+1: steps <= N never re-execute, result identical to a no-crash control", async () => {
    await writeProjectLoop("two-step", {
      name: "two-step",
      start: "plan",
      steps: {
        plan: { next: "build" },
        build: { next: "end" },
      },
    });
    const agent = makeAgent("two-step");
    const script: MockResponse[] = [
      { type: "tool-call", toolName: "write", args: { path: "boundary-a.txt", content: "plan output" } },
      { type: "text", text: '{"planned": true}' },
      { type: "text", text: "BUILT" },
    ];

    // ── Control: same script, no crash ──
    const control = await runEngine(mockTurnSequenceModel(script), { agent });
    expect(control.result.exitCode).toBe(0);
    expect(control.result.stdout).toBe("BUILT");
    await unlink(join(cwd, "boundary-a.txt"));

    // ── Run 1: plan completes, build's first model call crashes ──
    const crash = await runEngine(crashingAfterModel(script.slice(0, 2)), { agent });
    expect(crash.result.exitCode).toBe(1);

    // The last surviving checkpoint is the boundary after "plan": pipeline
    // position only (no session history), plan's output already in the bag.
    const checkpoint = crash.checkpoints[crash.checkpoints.length - 1]!;
    expect(checkpoint.pipelineName).toBe("two-step");
    expect(checkpoint.steps).toEqual([{ loop: "build" }]);
    expect(checkpoint.previousNode).toBe("plan");
    expect(checkpoint.context).toMatchObject({ plan: { planned: true } });
    expect(checkpoint.history).toBeUndefined();

    // Wipe plan's side-effect so any re-execution would be visible.
    expect(await readFile(join(cwd, "boundary-a.txt"), "utf-8")).toBe("plan output");
    await unlink(join(cwd, "boundary-a.txt"));

    // ── Run 2: resume from the boundary checkpoint ──
    const prompts: unknown[][] = [];
    const resumed = await runEngine(
      capturingSequenceModel([{ type: "text", text: "BUILT" }], prompts),
      { agent, resumeState: checkpoint },
    );

    expect(resumed.result.exitCode).toBe(0);
    // Identical to the no-crash control.
    expect(resumed.result.stdout).toBe(control.result.stdout);

    // Temporal semantics: plan's LLM turns and tool never re-executed…
    expect(prompts).toHaveLength(1);
    expect(existsSync(join(cwd, "boundary-a.txt"))).toBe(false);
    // …and build saw plan's output through the restored context bag.
    expect(JSON.stringify(prompts[0])).toContain("planned");
    expect(JSON.stringify(prompts[0])).toContain('Active loop step: build');
  });

  test("kill after the FINAL step: resume completes without re-executing anything", async () => {
    await writeProjectLoop("one-step", {
      name: "one-step",
      start: "solo",
      steps: { solo: { next: "end" } },
    });
    const agent = makeAgent("one-step");

    // Run 1 "crashes" right after the last boundary checkpoint (we simply
    // harvest the final checkpoint: steps is empty).
    const first = await runEngine(mockTurnSequenceModel([{ type: "text", text: '{"solo": "done"}' }]), { agent });
    expect(first.result.exitCode).toBe(0);
    const final = first.checkpoints[first.checkpoints.length - 1]!;
    expect(final.steps).toEqual([]);
    expect(final.pipelineName).toBe("one-step");

    // Resume: zero steps left — the run completes from the bag alone, the
    // LLM is never called (documented: stdout falls back to context JSON).
    const prompts: unknown[][] = [];
    const resumed = await runEngine(capturingSequenceModel([], prompts), { agent, resumeState: final });
    expect(resumed.result.exitCode).toBe(0);
    expect(prompts).toHaveLength(0);
    expect(resumed.result.stdout).toContain('"solo"');
  });
});

describe("pipeline durable turns — in-flight agent step (Phase A composition)", () => {
  test("kill at turn K inside step S: resume restarts S at turn K+1 with the recorded history", async () => {
    await writeProjectLoop("two-step-b", {
      name: "two-step-b",
      start: "plan",
      steps: {
        plan: { next: "build" },
        build: { next: "end" },
      },
    });
    const agent = makeAgent("two-step-b");

    // Run 1: plan completes in one turn; build does a tool turn (turn 0),
    // then crashes at turn 1.
    const crash = await runEngine(
      crashingAfterModel([
        { type: "text", text: '{"planned": true}' },
        { type: "tool-call", toolName: "write", args: { path: "inflight-b.txt", content: "build turn 0" } },
      ]),
      { agent },
    );
    expect(crash.result.exitCode).toBe(1);

    // Last checkpoint: build in flight — pipeline position AND session state.
    const checkpoint = crash.checkpoints[crash.checkpoints.length - 1]!;
    expect(checkpoint.pipelineName).toBe("two-step-b");
    expect(checkpoint.steps).toEqual([{ loop: "build" }]);
    expect(checkpoint.loopName).toBe("build");
    expect(checkpoint.turn).toBe(0);
    expect(Array.isArray(checkpoint.history)).toBe(true);
    expect(JSON.stringify(checkpoint.history)).toContain("inflight-b.txt");
    expect(checkpoint.context).toMatchObject({ plan: { planned: true } });

    // Wipe the side-effect so re-execution would be visible.
    expect(await readFile(join(cwd, "inflight-b.txt"), "utf-8")).toBe("build turn 0");
    await unlink(join(cwd, "inflight-b.txt"));

    // Run 2: resume — build continues at turn 1.
    const prompts: unknown[][] = [];
    const resumed = await runEngine(
      capturingSequenceModel([{ type: "text", text: "resumed BUILT" }], prompts),
      { agent, resumeState: checkpoint },
    );

    expect(resumed.result.exitCode).toBe(0);
    expect(resumed.result.stdout).toBe("resumed BUILT");

    // plan never re-ran, build's turn-0 tool never re-executed…
    expect(prompts).toHaveLength(1);
    expect(existsSync(join(cwd, "inflight-b.txt"))).toBe(false);
    // …the model saw build's recorded turn-0 history (tool-call + result).
    const firstPrompt = JSON.stringify(prompts[0]);
    expect(firstPrompt).toContain("inflight-b.txt");
    expect(firstPrompt).toContain("tool-result");
    expect(firstPrompt).toContain("Active loop step: build");

    // Turn numbering continues inside the resumed step.
    const inFlight = resumed.checkpoints.find((cp) => typeof cp.turn === "number");
    expect(inFlight?.turn).toBe(1);
  });
});

describe("pipeline durable turns — while and switch", () => {
  test("while: kill at iteration I resumes from iteration I, not from 0", async () => {
    await writeProjectLoop("retry-flow", {
      name: "retry-flow",
      start: "loop",
      steps: {
        loop: { type: "while", until: "worker.done == true", maxIterations: 5, body: "worker", next: "end" },
        worker: { next: "end" },
      },
    });
    const agent = makeAgent("retry-flow");

    // Run 1: iteration 1 completes (done=false), iteration 2 crashes at its
    // first model call.
    const crash = await runEngine(
      crashingAfterModel([{ type: "text", text: '{"done": false}' }]),
      { agent },
    );
    expect(crash.result.exitCode).toBe(1);

    // Last checkpoint = iteration-1 boundary: a while continuation that has
    // already done 1 iteration.
    const checkpoint = crash.checkpoints[crash.checkpoints.length - 1]!;
    expect(checkpoint.pipelineName).toBe("retry-flow");
    const continuation = checkpoint.steps[0] as Extract<Step, { while: unknown }>;
    expect((continuation as any).while.completedIterations).toBe(1);
    expect(checkpoint.context).toMatchObject({ worker: { done: false } });

    // Run 2: resume — exactly ONE more worker session runs (iteration 2).
    const prompts: unknown[][] = [];
    const resumed = await runEngine(
      capturingSequenceModel([{ type: "text", text: '{"done": true}' }], prompts),
      { agent, resumeState: checkpoint },
    );

    expect(resumed.result.exitCode).toBe(0);
    expect(prompts).toHaveLength(1);

    // The resumed trace runs iteration 2 — never iteration 1 again.
    const iterations = resumed.transcript
      .filter((t) => t.type === "loop_trace")
      .map((t) => (t.trace as { data?: { iteration?: number } }).data?.iteration)
      .filter((i): i is number => typeof i === "number");
    expect(iterations).toContain(2);
    expect(iterations).not.toContain(1);
  });

  test("switch: the chosen branch replays WITHOUT re-evaluating the condition", async () => {
    await writeProjectLoop("route-flow", {
      name: "route-flow",
      start: "router",
      steps: {
        router: { next: [{ when: "router.path == 'x'", to: "x" }, { to: "y" }] },
        x: { next: "end" },
        y: { next: "end" },
      },
    });
    const agent = makeAgent("route-flow");

    // Run 1: router picks branch x, then x's first model call crashes.
    const crash = await runEngine(
      crashingAfterModel([{ type: "text", text: '{"path": "x"}' }]),
      { agent },
    );
    expect(crash.result.exitCode).toBe(1);

    // The selection checkpoint pinned the choice: branch x inlined, the
    // switch step GONE — nothing left to re-evaluate.
    const checkpoint = crash.checkpoints[crash.checkpoints.length - 1]!;
    expect(checkpoint.steps).toEqual([{ loop: "x" }]);
    expect(checkpoint.steps.some((step) => "switch" in step)).toBe(false);

    // Tamper the restored bag so a re-evaluation WOULD choose y — the
    // resume must still run x, because the choice is a recorded fact.
    const tampered = throughStore(checkpoint);
    (tampered.context as any).router = { path: "y" };

    const prompts: unknown[][] = [];
    const resumed = await runEngine(
      capturingSequenceModel([{ type: "text", text: "X-DONE" }], prompts),
      { agent, resumeState: tampered },
    );

    expect(resumed.result.exitCode).toBe(0);
    expect(resumed.result.stdout).toBe("X-DONE");
    expect(prompts).toHaveLength(1);
    expect(JSON.stringify(prompts[0])).toContain("Active loop step: x");
    expect(JSON.stringify(prompts[0])).not.toContain("Active loop step: y");
  });
});

describe("pipeline durable turns — parallel (v1 cut, pinned)", () => {
  test("crash inside parallel resumes from BEFORE the block: completed branches re-execute, prior steps do not", async () => {
    await writeProjectLoop("par-flow", {
      name: "par-flow",
      start: "pre",
      steps: {
        pre: {
          type: "tool",
          tool: "bash",
          input: { command: "echo ran >> par-marker.txt" },
          saveAs: "pre",
          next: "fanout",
        },
        fanout: { type: "parallel", branches: ["p1", "p2"], join: "all", next: "post" },
        p1: { next: "end" },
        p2: { next: "end" },
        post: { next: "end" },
      },
    });
    const agent = makeAgent("par-flow");

    // Run 1: one parallel branch completes, the other crashes.
    const crash = await runEngine(
      crashingAfterModel([{ type: "text", text: '{"branch": "done"}' }]),
      { agent },
    );
    expect(crash.result.exitCode).toBe(1);
    expect(await readFile(join(cwd, "par-marker.txt"), "utf-8")).toBe("ran\n");

    // No checkpoint from inside the block: the last one is the boundary
    // after the "pre" tool step (previousNode records the TOOL name — the
    // pre-existing lastNode semantics), the whole parallel step pending.
    const checkpoint = crash.checkpoints[crash.checkpoints.length - 1]!;
    expect(checkpoint.previousNode).toBe("bash");
    expect(checkpoint.steps[0]).toHaveProperty("parallel");
    expect(checkpoint.history).toBeUndefined();

    // Run 2: resume. BOTH branches re-execute (v1 cut — also the branch
    // that had completed), then post runs. The pre tool step does NOT.
    const prompts: unknown[][] = [];
    const resumed = await runEngine(
      capturingSequenceModel(
        [
          { type: "text", text: '{"p": 1}' },
          { type: "text", text: '{"p": 2}' },
          { type: "text", text: "POST-DONE" },
        ],
        prompts,
      ),
      { agent, resumeState: checkpoint },
    );

    expect(resumed.result.exitCode).toBe(0);
    expect(resumed.result.stdout).toBe("POST-DONE");
    // Three sessions ran on resume: p1 + p2 (re-executed) + post.
    expect(prompts).toHaveLength(3);
    // The tool step before the block was NOT re-executed.
    expect(await readFile(join(cwd, "par-marker.txt"), "utf-8")).toBe("ran\n");
  });
});

describe("pipeline durable turns — format compat", () => {
  test("a pre-existing human-gate resume state (no pipelineName) is ignored: fresh start, no crash", async () => {
    await writeProjectLoop("compat-flow", {
      name: "compat-flow",
      start: "plan",
      steps: {
        plan: { next: "build" },
        build: { next: "end" },
      },
    });
    const agent = makeAgent("compat-flow");

    // The completions human-gate format: steps + context + previousNode +
    // approvedGates, NO pipelineName, NO turn fields.
    const gateFormat: LoopResumeState = {
      context: { plan: { planned: "stale" } },
      steps: [{ loop: "build" }],
      previousNode: "plan",
      approvedGates: [{ type: "policy", id: "approve-deploy", hook: "tool:before" }],
      attempts: 1,
      createdAt: new Date().toISOString(),
    };

    const prompts: unknown[][] = [];
    const { result } = await runEngine(
      capturingSequenceModel(
        [
          { type: "text", text: '{"planned": true}' },
          { type: "text", text: "FRESH-BUILT" },
        ],
        prompts,
      ),
      { agent, resumeState: gateFormat },
    );

    // Both steps ran — the gate-format state did not skip "plan".
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("FRESH-BUILT");
    expect(prompts).toHaveLength(2);
    expect(JSON.stringify(prompts[1])).not.toContain("stale");
  });

  test("a Phase A single-session checkpoint never seeds a pipeline run", async () => {
    await writeProjectLoop("compat-flow-b", {
      name: "compat-flow-b",
      start: "solo",
      steps: { solo: { next: "end" } },
    });
    const agent = makeAgent("compat-flow-b");

    const sessionCheckpoint: LoopResumeState = {
      context: {},
      steps: [],
      loopName: "default",
      turn: 2,
      history: [{ role: "user", content: "old single-session prompt" }],
      accumText: "old",
      createdAt: new Date().toISOString(),
    };

    const prompts: unknown[][] = [];
    const { result } = await runEngine(
      capturingSequenceModel([{ type: "text", text: "SOLO-FRESH" }], prompts),
      { agent, resumeState: sessionCheckpoint },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("SOLO-FRESH");
    expect(prompts).toHaveLength(1);
    expect(JSON.stringify(prompts[0])).not.toContain("old single-session prompt");
  });

  test("a pipeline checkpoint never seeds a single-session (non-pipeline) run", async () => {
    const singleAgent: AgentConfig = { name: "pipeline-agent", role: "developer" };

    const pipelineCheckpoint: LoopResumeState = {
      context: { plan: { planned: true } },
      steps: [{ loop: "default" }],
      pipelineName: "two-step",
      loopName: "default",
      turn: 0,
      history: [{ role: "user", content: "pipeline step history" }],
      createdAt: new Date().toISOString(),
    };

    const prompts: unknown[][] = [];
    const { result, checkpoints } = await runEngine(
      capturingSequenceModel([{ type: "text", text: "SINGLE-FRESH" }], prompts),
      { agent: singleAgent, resumeState: pipelineCheckpoint },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("SINGLE-FRESH");
    // History was NOT seeded from the pipeline checkpoint…
    expect(JSON.stringify(prompts[0])).not.toContain("pipeline step history");
    // …and single-session checkpointing restarted from turn 0.
    expect(checkpoints[0]?.turn).toBe(0);
    expect(checkpoints[0]?.pipelineName).toBeUndefined();
  });

  test("a throwing checkpoint sink never fails a pipeline run", async () => {
    await writeProjectLoop("sink-flow", {
      name: "sink-flow",
      start: "solo",
      steps: { solo: { next: "end" } },
    });
    activeResolvedModel = mockResolvedModel(mockTurnSequenceModel([{ type: "text", text: "still fine" }]));
    const handle = spawnLoopEngine(makeAgent("sink-flow"), makeTask(), cwd, {
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
