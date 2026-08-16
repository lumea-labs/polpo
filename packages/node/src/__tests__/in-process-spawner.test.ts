/**
 * InProcessSpawner — the task lifecycle running INSIDE the orchestrator
 * process (ProxyTool P0, Phase B).
 *
 * Contract under test:
 *
 * 1. E2E: spawn(config) → the same lifecycle as the subprocess runner
 *    (both call executeRun): task run goes running → completed against the
 *    INJECTED stores (no second store/DB), result + transcript persisted.
 * 2. Lifecycle: isAlive(pid) is true while the run is in flight and false
 *    after; kill(pid) aborts the run → run record "killed" (exitCode 1),
 *    matching the subprocess SIGTERM semantics.
 * 3. Reactive tick: SpawnResult.onExit fires when the run settles — through
 *    the real orchestrator, task completion is collected via the run:exited
 *    wake event without waiting out the poll interval.
 * 4. Durable turns in-process: per-turn checkpoints land on the run record;
 *    a respawn with config.resumeState resumes at turn + 1 without
 *    re-executing recorded tools — identical to the subprocess path.
 * 5. Parity: the same task executed through subprocess-style deps (own
 *    stores built from polpoDir, exactly what core/runner.ts main() wires)
 *    and through the InProcessSpawner yields the same observable outcome:
 *    status, result shape, transcript event sequence.
 * 6. A run that throws NEVER crashes the orchestrator: spawn() resolves,
 *    onExit still fires, and the failure is persisted best-effort.
 *
 * Mock strategy: same as engine-behavior/run-lifecycle — vi.mock
 * @polpo-ai/llm so resolveModel returns a MockLanguageModelV3. Everything
 * else (spawner, executeRun, stores, tools, filesystem) runs for real.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedModel } from "@polpo-ai/llm";
import {
  MockLanguageModelV3,
  mockTextModel,
  mockTurnSequenceModel,
  mockResolvedModel,
} from "./helpers/mock-llm.js";

// ── Mock the LLM module BEFORE any imports that pull it in ──

let activeResolvedModel: ResolvedModel = mockResolvedModel(mockTextModel("default"));
let capturedResolveOpts: unknown;

vi.mock("@polpo-ai/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@polpo-ai/llm")>();
  return {
    ...actual,
    resolveModel: (_model: unknown, opts?: unknown) => { capturedResolveOpts = opts; return activeResolvedModel; },
    enforceModelAllowlist: () => {},
    mapReasoningToProviderOptions: () => undefined,
  };
});

import { CompositeSpawner } from "../adapters/composite-spawner.js";
import { InProcessSpawner } from "../adapters/in-process-spawner.js";
import { NodeSpawner } from "../adapters/node-spawner.js";
import { executeRun } from "../core/run-lifecycle.js";
import { Orchestrator } from "../core/orchestrator.js";
import { InMemoryRunStore, InMemoryTaskStore, createTestAgent } from "./fixtures.js";
import { FileRunStore } from "@polpo-ai/file-stores";
import type { AgentConfig, Task, RunnerConfig } from "@polpo-ai/core/types";
import type { LoopResumeState } from "@polpo-ai/core/loop-run-store";

// ── Helpers ─────────────────────────────────────────────

function setMockModel(model: MockLanguageModelV3, overrides: Partial<ResolvedModel> = {}) {
  activeResolvedModel = { ...mockResolvedModel(model), ...overrides };
}

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { name: "inproc-agent", role: "developer", ...overrides };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-inproc-1",
    title: "In-process task",
    description: "Do the scripted thing.",
    state: "in_progress",
    expectations: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    assignedTo: "inproc-agent",
    ...overrides,
  } as Task;
}

let tmpRoot: string;
let cwd: string;
let polpoDir: string;
let runSeq = 0;

function makeConfig(overrides: Partial<RunnerConfig> = {}): RunnerConfig {
  const runId = `run-ip-${++runSeq}`;
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

/** Await a SpawnResult.onExit callback as a promise. */
function onExitPromise(spawnResult: { onExit?: (cb: () => void) => void }): Promise<void> {
  return new Promise((resolve) => spawnResult.onExit!(resolve));
}

/** Read the transcript event-type sequence from the JSONL activity log. */
async function transcriptShape(dir: string, runId: string): Promise<string[]> {
  const raw = await readFile(join(dir, "logs", `run-${runId}.jsonl`), "utf-8");
  return raw.trim().split("\n")
    .map((l) => JSON.parse(l))
    .map((e) => (e.event ?? e.type ?? "?") as string)
    .filter((t) => t !== "activity"); // poll-timing dependent
}

beforeAll(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "polpo-inproc-spawner-"));
  cwd = join(tmpRoot, "work");
  polpoDir = join(tmpRoot, ".polpo");
  await mkdir(cwd, { recursive: true });
  await mkdir(polpoDir, { recursive: true });
});

afterAll(async () => {
  if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
});

// ── Tests ───────────────────────────────────────────────

describe("InProcessSpawner", () => {
  test("finalizes exactly once when persistence fails before the engine starts", async () => {
    const store = new InMemoryRunStore();
    vi.spyOn(store, "upsertRun").mockRejectedValue(new Error("database unavailable"));
    const finalize = vi.fn(async () => undefined);
    const spawner = new InProcessSpawner(() => ({ runStore: store, finalize }));

    const spawnResult = await spawner.spawn(makeConfig());
    await onExitPromise(spawnResult);

    expect(finalize).toHaveBeenCalledTimes(1);
    expect(spawner.isAlive(spawnResult.pid)).toBe(false);
  });

  test("E2E: task runs in-process against the injected stores, result + transcript persisted", async () => {
    setMockModel(mockTurnSequenceModel([
      { type: "tool-call", toolName: "write", args: { path: "ip-a.txt", content: "in-process" } },
      { type: "text", text: "in-process done" },
    ]));
    const store = new InMemoryRunStore();
    const spawner = new InProcessSpawner(() => ({ runStore: store }));
    const config = makeConfig();

    const spawnResult = await spawner.spawn(config);
    // Synthetic negative pid — never a real OS pid, never 0 (0 = untracked).
    expect(spawnResult.pid).toBeLessThan(0);
    expect(spawnResult.configPath).toBe(`memory://run-${config.runId}`);

    await onExitPromise(spawnResult);

    // The run completed against the INJECTED store.
    const run = await store.getRun(config.runId);
    expect(run?.status).toBe("completed");
    expect(run?.result?.exitCode).toBe(0);
    expect(run?.result?.stdout).toBe("in-process done");
    expect(run?.pid).toBe(spawnResult.pid);

    // Tool side-effect + transcript log on disk, like the subprocess.
    expect(await readFile(join(cwd, "ip-a.txt"), "utf-8")).toBe("in-process");
    const shape = await transcriptShape(polpoDir, config.runId);
    expect(shape).toContain("tool_use");
    expect(shape).toContain("assistant");
    // Output dir was created (NodeSpawner parity).
    expect(existsSync(config.outputDir)).toBe(true);
  });

  test("per-tenant gatewayConfig from deps reaches the loop's model resolution", async () => {
    setMockModel(mockTurnSequenceModel([{ type: "text", text: "gw ok" }]));
    capturedResolveOpts = undefined;
    const gatewayConfig = { url: "https://tenant-gw.example/v1", apiKey: "tenant-key" };
    const store = new InMemoryRunStore();
    const spawner = new InProcessSpawner(() => ({ runStore: store, gatewayConfig }));

    const spawnResult = await spawner.spawn(makeConfig());
    await onExitPromise(spawnResult);

    // resolveModel(model, { gateway }) — the in-process host must thread the
    // per-tenant gateway through, since the shared server process has no
    // per-tenant env (unlike the sandbox).
    expect((capturedResolveOpts as { gateway?: unknown })?.gateway).toEqual(gatewayConfig);
  });

  test("does not touch a remote outputDir through node:fs", async () => {
    setMockModel(mockTurnSequenceModel([{ type: "text", text: "remote fs ok" }]));
    const store = new InMemoryRunStore();
    const remoteFs = {
      readFile: vi.fn(), writeFile: vi.fn(), exists: vi.fn(), readdir: vi.fn(),
      mkdir: vi.fn(), remove: vi.fn(), stat: vi.fn(), rename: vi.fn(),
    };
    const spawner = new InProcessSpawner(() => ({ runStore: store, fs: remoteFs as any }));
    const config = makeConfig({ outputDir: "/home/remote/project/.polpo/output/task" });

    const spawnResult = await spawner.spawn(config);
    await onExitPromise(spawnResult);

    expect((await store.getRun(config.runId))?.status).toBe("completed");
    expect(remoteFs.mkdir).not.toHaveBeenCalled();
  });

  test("lifecycle: isAlive during the run, false after; kill() → run killed", async () => {
    // Model blocks until aborted.
    setMockModel(new MockLanguageModelV3({
      doStream: (opts) => new Promise((_resolve, reject) => {
        const fail = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        if (opts.abortSignal?.aborted) return fail();
        opts.abortSignal?.addEventListener("abort", fail, { once: true });
      }),
    }));

    const store = new InMemoryRunStore();
    const spawner = new InProcessSpawner(() => ({ runStore: store }));
    const config = makeConfig();

    const spawnResult = await spawner.spawn(config);
    expect(spawner.isAlive(spawnResult.pid)).toBe(true);

    // Kill mid-turn — the AbortController reaches the engine.
    spawner.kill(spawnResult.pid);
    await onExitPromise(spawnResult);

    expect(spawner.isAlive(spawnResult.pid)).toBe(false);
    const run = await store.getRun(config.runId);
    expect(run?.status).toBe("killed");
    expect(run?.result?.exitCode).toBe(1);
    expect(run?.result?.stderr).toContain("Killed by SIGTERM (timeout or shutdown)");
  });

  test("kill of an unknown pid is a safe no-op", () => {
    const spawner = new InProcessSpawner(() => ({ runStore: new InMemoryRunStore() }));
    expect(() => spawner.kill(-999)).not.toThrow();
    expect(spawner.isAlive(-999)).toBe(false);
    expect(spawner.isAlive(0)).toBe(false);
  });

  test("durable turns in-process: checkpoint persisted, resume skips recorded tools", async () => {
    // ── Run 1: turn 0 writes a file, then the model crashes ──
    let calls = 0;
    const inner = mockTurnSequenceModel([
      { type: "tool-call", toolName: "write", args: { path: "ip-resume.txt", content: "turn zero" } },
    ]);
    setMockModel(new MockLanguageModelV3({
      doStream: (opts) => {
        if (calls++ >= 1) throw new Error("simulated crash");
        return inner.doStream(opts);
      },
    }));

    const store = new InMemoryRunStore();
    const spawner = new InProcessSpawner(() => ({ runStore: store }));
    const config = makeConfig();

    const first = await spawner.spawn(config);
    await onExitPromise(first);

    const crashed = await store.getRun(config.runId);
    expect(crashed?.status).toBe("failed");
    const checkpoint = crashed?.resumeState as LoopResumeState;
    expect(checkpoint?.turn).toBe(0);
    expect(JSON.stringify(checkpoint.history)).toContain("ip-resume.txt");

    // Wipe the side-effect so re-execution would be visible.
    await rm(join(cwd, "ip-resume.txt"));

    // ── Run 2: respawn with the harvested checkpoint (what orphan recovery does) ──
    setMockModel(mockTurnSequenceModel([{ type: "text", text: "resumed in-process" }]));
    const config2 = makeConfig({ resumeState: checkpoint });
    const second = await spawner.spawn(config2);
    await onExitPromise(second);

    const resumed = await store.getRun(config2.runId);
    expect(resumed?.status).toBe("completed");
    expect(resumed?.result?.stdout).toBe("resumed in-process");
    // Temporal semantics: the recorded tool did NOT re-execute.
    expect(existsSync(join(cwd, "ip-resume.txt"))).toBe(false);
    // Turn numbering continued past the checkpoint.
    expect((resumed?.resumeState as LoopResumeState)?.turn).toBe(1);
  });

  test("a run whose lifecycle throws never crashes the host: onExit fires, failure persisted", async () => {
    setMockModel(mockTextModel("irrelevant"));
    const store = new InMemoryRunStore();
    // Sabotage the very first store write — the one failure executeRun
    // cannot persist by itself (its own entry point).
    const upsert = store.upsertRun.bind(store);
    let failFirst = true;
    store.upsertRun = async (run) => {
      if (failFirst) { failFirst = false; throw new Error("store down"); }
      return upsert(run);
    };
    const spawner = new InProcessSpawner(() => ({ runStore: store }));
    const config = makeConfig();

    const spawnResult = await spawner.spawn(config);
    await onExitPromise(spawnResult); // resolves — no crash, no unhandled rejection
    expect(spawner.isAlive(spawnResult.pid)).toBe(false);
  });
});

// ── Parity: subprocess-style deps vs InProcessSpawner ───

describe("parity: subprocess lifecycle vs InProcessSpawner", () => {
  /** The scripted task both hosts execute. */
  const script = () => mockTurnSequenceModel([
    { type: "tool-call", toolName: "write", args: { path: "parity.txt", content: "same task" } },
    { type: "text", text: "parity done" },
  ]);

  test("same task → same status, result and transcript shape", async () => {
    // ── Host A: subprocess-style — exactly what core/runner.ts main() wires:
    //    its own FileRunStore over polpoDir, own fs/shell, process pid.
    const subDir = join(tmpRoot, "sub");
    await mkdir(join(subDir, "work"), { recursive: true });
    await mkdir(join(subDir, ".polpo"), { recursive: true });
    setMockModel(script());
    const subStore = new FileRunStore(join(subDir, ".polpo"));
    const subConfig = makeConfig({
      polpoDir: join(subDir, ".polpo"),
      cwd: join(subDir, "work"),
      outputDir: join(subDir, ".polpo", "output", "t"),
    });
    const subOutcome = await executeRun(subConfig, {
      runStore: subStore,
      pid: process.pid,
      configPath: join(subDir, ".polpo", "tmp", `run-${subConfig.runId}.json`),
    });
    const subRun = await subStore.getRun(subConfig.runId);

    // ── Host B: InProcessSpawner over injected stores.
    const inDir = join(tmpRoot, "inp");
    await mkdir(join(inDir, "work"), { recursive: true });
    await mkdir(join(inDir, ".polpo"), { recursive: true });
    setMockModel(script());
    const inStore = new InMemoryRunStore();
    const spawner = new InProcessSpawner(() => ({ runStore: inStore }));
    const inConfig = makeConfig({
      polpoDir: join(inDir, ".polpo"),
      cwd: join(inDir, "work"),
      outputDir: join(inDir, ".polpo", "output", "t"),
    });
    const spawnResult = await spawner.spawn(inConfig);
    await onExitPromise(spawnResult);
    const inRun = await inStore.getRun(inConfig.runId);

    // Observable outcome is identical.
    expect(inRun?.status).toBe(subRun?.status);
    expect(inRun?.status).toBe("completed");
    expect(inRun?.result?.exitCode).toBe(subRun?.result?.exitCode);
    expect(inRun?.result?.stdout).toBe(subRun?.result?.stdout);
    expect(inRun?.result?.stderr).toBe(subRun?.result?.stderr);
    expect(inRun?.activity.toolCalls).toBe(subRun?.activity.toolCalls);
    // Same files created (paths differ only by each host's temp workdir).
    const basename = (p: string) => p.split("/").pop();
    expect(inRun?.activity.filesCreated.map(basename)).toEqual(subRun?.activity.filesCreated.map(basename));

    // Same side-effects on disk…
    expect(await readFile(join(subDir, "work", "parity.txt"), "utf-8")).toBe("same task");
    expect(await readFile(join(inDir, "work", "parity.txt"), "utf-8")).toBe("same task");

    // …and the same transcript event sequence.
    const subShape = await transcriptShape(join(subDir, ".polpo"), subConfig.runId);
    const inShape = await transcriptShape(join(inDir, ".polpo"), inConfig.runId);
    expect(inShape).toEqual(subShape);
  });
});

// ── Reactive tick through the real orchestrator ─────────

describe("orchestrator + InProcessSpawner (reactive tick)", () => {
  test("task → running → done, collected via run:exited without waiting the poll", async () => {
    setMockModel(mockTurnSequenceModel([{ type: "text", text: "orchestrated" }]));

    const orchDir = join(tmpRoot, "orch");
    await mkdir(orchDir, { recursive: true });
    const store = new InMemoryTaskStore();
    const runStore = new InMemoryRunStore();
    // The spawner reuses the orchestrator's run store — the very stores the
    // tick reads. Deps are lazy, exactly how the orchestrator wires them.
    const spawner = new InProcessSpawner(() => ({ runStore }));

    const orchestrator = new Orchestrator({
      workDir: orchDir,
      store,
      runStore,
      spawner,
      assessFn: async () => ({
        passed: true, checks: [], metrics: [], timestamp: new Date().toISOString(),
      }),
    });
    await orchestrator.initInteractive("inproc-tick-test", {
      name: "team",
      agents: [createTestAgent({ name: "worker" })],
    });

    const exited = new Promise<void>((resolve) => {
      orchestrator.on("run:exited", () => resolve());
    });

    await orchestrator.engine.createTask({
      title: "In-process tick task",
      description: "Say something",
      assignTo: "worker",
    });

    // Tick 1: spawns the in-process run.
    await orchestrator.tick();
    const task = (await store.listTasks())[0];
    expect(task.status).toBe("in_progress");

    // The reactive wake: run:exited fires when the run settles — no
    // simulated runner, no poll-interval wait.
    await exited;

    // Tick 2: collect the REAL in-process result.
    await orchestrator.tick();
    await vi.waitFor(async () => {
      expect((await store.getTask(task.id))!.status).toBe("done");
    });
    expect((await store.getTask(task.id))!.result?.stdout).toBe("orchestrated");
    const retainedRun = await runStore.getRunByTaskId(task.id);
    expect(retainedRun?.status).toBe("completed");
    expect(retainedRun?.collectedAt).toBeTruthy();
    expect(retainedRun?.pid).toBeLessThan(0);
  });

  test("timeout health check reaches the in-process engine (negative pid kill)", async () => {
    // Model blocks until aborted — only a real kill can settle the run.
    setMockModel(new MockLanguageModelV3({
      doStream: (opts) => new Promise((_resolve, reject) => {
        const fail = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        if (opts.abortSignal?.aborted) return fail();
        opts.abortSignal?.addEventListener("abort", fail, { once: true });
      }),
    }));

    const orchDir = join(tmpRoot, "orch-timeout");
    await mkdir(orchDir, { recursive: true });
    const store = new InMemoryTaskStore();
    const runStore = new InMemoryRunStore();
    const spawner = new InProcessSpawner(() => ({ runStore }));

    const orchestrator = new Orchestrator({
      workDir: orchDir,
      store,
      runStore,
      spawner,
      assessFn: async () => ({
        passed: true, checks: [], metrics: [], timestamp: new Date().toISOString(),
      }),
    });
    await orchestrator.initInteractive("inproc-timeout-test", {
      name: "team",
      agents: [createTestAgent({ name: "worker" })],
    });

    await orchestrator.engine.createTask({
      title: "Hung in-process task",
      description: "Never finishes on its own",
      assignTo: "worker",
    });

    // Tick 1: spawn the (hung) in-process run.
    await orchestrator.tick();
    const task = (await store.listTasks())[0];
    const run = (await runStore.getRunByTaskId(task.id))!;
    expect(run.pid).toBeLessThan(0);
    expect(spawner.isAlive(run.pid)).toBe(true);

    // Rewind the clock: the run is now far beyond the default task timeout.
    await runStore.upsertRun({
      ...run,
      startedAt: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
    });

    // Tick 2: enforceHealthChecks must kill THROUGH the spawner — a
    // negative (in-process) pid is killable, only pid 0 means untracked.
    await orchestrator.tick();
    await vi.waitFor(() => {
      expect(spawner.isAlive(run.pid)).toBe(false);
    });
    expect((await runStore.getRun(run.id))?.status).toBe("killed");
  });
});

// ── settings.taskExecution selection ────────────────────

describe("settings.taskExecution selection", () => {
  /** Prepare an isolated project dir, optionally with a polpo.json. */
  async function makeProject(name: string, settings?: Record<string, unknown>): Promise<string> {
    const dir = join(tmpRoot, name);
    await mkdir(join(dir, ".polpo"), { recursive: true });
    if (settings) {
      await writeFile(
        join(dir, ".polpo", "polpo.json"),
        JSON.stringify({ project: name, settings: { maxRetries: 2, workDir: ".", logLevel: "normal", ...settings } }),
      );
    }
    return dir;
  }

  function spawnerOf(orchestrator: Orchestrator): unknown {
    return (orchestrator as unknown as { spawner: unknown }).spawner;
  }

  test("default: no opt-in → composite routing a default config to the subprocess backend", async () => {
    const dir = await makeProject("sel-default", {});
    const orchestrator = new Orchestrator({ workDir: dir });
    await orchestrator.initInteractive("sel-default", {
      name: "team", agents: [createTestAgent({ name: "worker" })],
    });
    // Adaptive isolation: the orchestrator now always wires the composite;
    // zero-behavior-change lives in the routing default, pinned here.
    const composite = spawnerOf(orchestrator) as CompositeSpawner;
    expect(composite).toBeInstanceOf(CompositeSpawner);
    expect((composite as unknown as { subprocess: unknown }).subprocess).toBeInstanceOf(NodeSpawner);
    expect((composite as unknown as { inProcess: unknown }).inProcess).toBeInstanceOf(InProcessSpawner);
  });

  test("in-process opt-in: task completes end-to-end without a fork", async () => {
    setMockModel(mockTurnSequenceModel([{ type: "text", text: "selected in-process" }]));
    const dir = await makeProject("sel-inproc", { taskExecution: "in-process" });
    const orchestrator = new Orchestrator({
      workDir: dir,
      assessFn: async () => ({
        passed: true, checks: [], metrics: [], timestamp: new Date().toISOString(),
      }),
    });
    await orchestrator.initInteractive("sel-inproc", {
      name: "team", agents: [createTestAgent({ name: "worker" })],
    });
    expect(spawnerOf(orchestrator)).toBeInstanceOf(CompositeSpawner);

    // End-to-end through the orchestrator's OWN (file) stores — proving the
    // lazy deps wiring, not just the instance swap. A forked subprocess
    // could never complete here: the LLM mock only exists in this process.
    const exited = new Promise<void>((resolve) => orchestrator.on("run:exited", () => resolve()));
    await orchestrator.engine.createTask({
      title: "Selected task", description: "Say it", assignTo: "worker",
    });
    await orchestrator.tick();
    await exited;
    await orchestrator.tick();

    const store = orchestrator.getStore();
    await vi.waitFor(async () => {
      expect((await store.listTasks())[0].status).toBe("done");
    });
    expect((await store.listTasks())[0].result?.stdout).toBe("selected in-process");
  });

  test("an injected spawner always wins over the setting", async () => {
    const dir = await makeProject("sel-injected", { taskExecution: "in-process" });
    const injected = new InProcessSpawner(() => ({ runStore: new InMemoryRunStore() }));
    const orchestrator = new Orchestrator({ workDir: dir, spawner: injected });
    await orchestrator.initInteractive("sel-injected", {
      name: "team", agents: [createTestAgent({ name: "worker" })],
    });
    expect(spawnerOf(orchestrator)).toBe(injected);
  });
});
