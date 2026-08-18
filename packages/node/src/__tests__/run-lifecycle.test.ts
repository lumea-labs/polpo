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
import { convertArrayToReadableStream } from "ai/test";
import { jsonSchema } from "ai";

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

import { executeRun, RunActivityLog } from "../core/run-lifecycle.js";
import { InMemoryRunStore } from "./fixtures.js";
import type { AgentConfig, Task, RunnerConfig } from "@polpo-ai/core/types";
import type { LoopResumeState } from "@polpo-ai/core/loop-run-store";
import { InMemorySteeringController } from "@polpo-ai/core/steering";
import {
  RuntimeGuardrailEngine,
  createRunToolMiddleware,
} from "@polpo-ai/core/guardrails";

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
  test("local activity logging is best-effort for a non-writable remote polpoDir", async () => {
    const notADirectory = join(tmpRoot, "not-a-directory");
    await import("node:fs/promises").then(({ writeFile }) => writeFile(notADirectory, "file"));

    expect(() => new RunActivityLog(notADirectory, "remote-run", "task", "agent", -1)).not.toThrow();
  });

  test("Brain persistence is loaded only when a Brain tool is explicitly allowed", async () => {
    const brainPath = join(polpoDir, "brain.json");
    await writeFile(brainPath, "{corrupt", "utf8");
    setMockModel(mockTextModel("no Brain requested"));

    try {
      const normalStore = new InMemoryRunStore();
      const normalConfig = makeConfig({
        agent: makeAgent({ allowedTools: ["read"] }),
      });
      const normal = await executeRun(normalConfig, {
        runStore: normalStore,
        pid: 1,
        configPath: "memory://without-brain",
      });
      expect(normal.status).toBe("completed");
      expect(normal.spawnError).toBeUndefined();

      const brainStore = new InMemoryRunStore();
      const brainConfig = makeConfig({
        agent: makeAgent({ allowedTools: ["brain_*"] }),
      });
      const withBrain = await executeRun(brainConfig, {
        runStore: brainStore,
        pid: 2,
        configPath: "memory://with-brain",
      });
      expect(withBrain.status).toBe("failed");
      expect(withBrain.spawnError).toBe(true);
      expect(withBrain.result.stderr).toContain("Durable Brain state is corrupted");
    } finally {
      await rm(brainPath, { force: true });
    }
  });

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

    expect(outcome.status, outcome.result.stderr).toBe("completed");
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

  test("task tools execute through the shared guardrail middleware with rewritten arguments", async () => {
    setMockModel(mockTurnSequenceModel([
      { type: "tool-call", toolName: "write", args: { path: "raw.txt", content: "hello" } },
      { type: "text", text: "guarded" },
    ]));
    const store = new InMemoryRunStore();
    const config = makeConfig();
    const engine = new RuntimeGuardrailEngine([{
      id: "rewrite-path",
      phases: ["tool.before"],
      evaluate: (input) => ({
        action: "rewrite",
        risk: "low",
        reason: "canonical output",
        value: { ...(input.value as Record<string, unknown>), path: "guarded.txt" },
      }),
    }]);

    const outcome = await executeRun(config, {
      runStore: store,
      pid: 4243,
      configPath: `memory://${config.runId}`,
      runToolMiddleware: createRunToolMiddleware(engine),
    });

    expect(outcome.status).toBe("completed");
    expect(existsSync(join(cwd, "raw.txt"))).toBe(false);
    expect(await readFile(join(cwd, "guarded.txt"), "utf-8")).toBe("hello");
  });

  test("a blocked task tool never executes and fails the run without retrying", async () => {
    setMockModel(mockTurnSequenceModel([
      { type: "tool-call", toolName: "write", args: { path: "blocked.txt", content: "no" } },
      { type: "text", text: "must not continue" },
    ]));
    const store = new InMemoryRunStore();
    const config = makeConfig();
    const events: Record<string, unknown>[] = [];
    const evaluated = vi.fn(() => ({
      action: "block" as const,
      risk: "critical" as const,
      reason: "blocked by policy",
    }));
    const engine = new RuntimeGuardrailEngine([{
      id: "block-write",
      phases: ["tool.before"],
      evaluate: evaluated,
    }]);

    const outcome = await executeRun(config, {
      runStore: store,
      pid: 4244,
      configPath: `memory://${config.runId}`,
      runToolMiddleware: createRunToolMiddleware(engine),
      onEvent: (event) => events.push(event),
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.result.stderr).toContain("blocked by policy");
    expect(evaluated).toHaveBeenCalledOnce();
    expect(existsSync(join(cwd, "blocked.txt"))).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      type: "error",
      error: expect.objectContaining({
        name: "GuardrailBlockedError",
        code: "guardrail_blocked",
        message: "blocked by policy",
      }),
    }));
  });

  test("a serialized policy pack protects task tools without an injected function", async () => {
    setMockModel(mockTurnSequenceModel([
      { type: "tool-call", toolName: "bash", args: { command: "rm -rf /" } },
      { type: "text", text: "must not continue" },
    ]));
    const store = new InMemoryRunStore();
    const config = makeConfig({
      guardrails: { toolPolicyPack: "default" },
    });
    const execute = vi.fn(async () => ({
      stdout: "must not execute",
      stderr: "",
      exitCode: 0,
    }));

    const outcome = await executeRun(config, {
      runStore: store,
      pid: 4245,
      configPath: `memory://${config.runId}`,
      shell: { execute },
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.result.stderr).toContain("Potentially destructive");
    expect(execute).not.toHaveBeenCalled();
  });

  test("serialized preflight policy blocks task input before model or tool execution", async () => {
    const doStream = vi.fn(async () => {
      throw new Error("model must not run");
    });
    setMockModel(new MockLanguageModelV3({ doStream }));
    const store = new InMemoryRunStore();
    const config = makeConfig({
      task: makeTask({
        description: "Handle the BLOCKED TOPIC now",
      }),
      guardrails: {
        policyPack: "custom",
        contentRules: [{
          id: "task.blocked-topic",
          phases: ["input"],
          action: "block",
          risk: "high",
          containsAny: ["blocked topic"],
        }],
      },
    });

    const outcome = await executeRun(config, {
      runStore: store,
      pid: 4250,
      configPath: `memory://${config.runId}`,
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.spawnError).toBe(true);
    expect(outcome.result.stderr).toContain('Matched content policy "task.blocked-topic"');
    expect(doStream).not.toHaveBeenCalled();
    expect((await store.getRun(config.runId))?.activity.guardrailDecisions)
      .toEqual([
        expect.objectContaining({
          decision: expect.objectContaining({
            phase: "input",
            action: "block",
          }),
        }),
      ]);
  });

  test("audit-mode preflight records a blocking decision but lets the task run", async () => {
    setMockModel(mockTextModel("continued after audit"));
    const store = new InMemoryRunStore();
    const config = makeConfig({
      task: makeTask({
        description: "Handle the BLOCKED TOPIC now",
      }),
      guardrailMode: "audit",
      guardrails: {
        policyPack: "custom",
        contentRules: [{
          id: "task.audit-topic",
          phases: ["input"],
          action: "block",
          risk: "high",
          containsAny: ["blocked topic"],
        }],
      },
    });

    const outcome = await executeRun(config, {
      runStore: store,
      pid: 4251,
      configPath: `memory://${config.runId}`,
    });

    expect(outcome.status, outcome.result.stderr).toBe("completed");
    expect(outcome.result.stdout).toBe("continued after audit");
    expect((await store.getRun(config.runId))?.activity.guardrailDecisions)
      .toEqual([
        expect.objectContaining({
          decision: expect.objectContaining({
            policyId: "task.audit-topic",
            phase: "input",
            action: "block",
          }),
        }),
      ]);
  });

  test("serialized task guardrails persist secret-free decisions in activity and transcript", async () => {
    setMockModel(mockTurnSequenceModel([
      {
        type: "tool-call",
        toolName: "bash",
        args: {
          command: "rm -rf /",
          token: "sk-this-value-must-never-enter-the-audit-event",
        },
      },
    ]));
    const store = new InMemoryRunStore();
    const config = makeConfig({
      guardrails: { toolPolicyPack: "default" },
    });
    const appended: Array<{ event: string; data: unknown }> = [];

    const outcome = await executeRun(config, {
      runStore: store,
      pid: 4246,
      configPath: `memory://${config.runId}`,
      createLogSession: async () => ({
        sessionId: "guardrail-session",
        append: async (entry) => {
          appended.push(entry as { event: string; data: unknown });
        },
      }),
    });

    expect(outcome.status).toBe("failed");
    const run = await store.getRun(config.runId);
    expect(run?.activity.guardrailDecisions).toEqual([
      expect.objectContaining({
        decision: expect.objectContaining({
          phase: "tool.before",
          action: "approval",
        }),
        context: expect.objectContaining({
          runId: config.runId,
          agent: "lifecycle-agent",
          surface: "task",
          source: "task",
        }),
        tool: expect.objectContaining({ name: "bash" }),
      }),
    ]);
    const persisted = appended.filter(
      (entry) => entry.event === "transcript:guardrail_decision",
    );
    expect(persisted).toHaveLength(1);
    expect(JSON.stringify(persisted)).not.toContain("rm -rf");
    expect(JSON.stringify(persisted)).not.toContain("sk-this-value");
  });

  test("serialized output guardrails redact background output before transcript and result persistence", async () => {
    const secret = "sk-abcdefghijklmnopqrstuvwxyzABCDEFGH123456";
    setMockModel(mockTurnSequenceModel([
      { type: "text", text: `token ${secret}` },
    ]));
    const store = new InMemoryRunStore();
    const config = makeConfig({
      guardrails: {
        outputPolicyPack: "default",
        streamingOutputMode: "buffer",
      },
    });
    const events: Record<string, unknown>[] = [];

    const outcome = await executeRun(config, {
      runStore: store,
      pid: 4247,
      configPath: `memory://${config.runId}`,
      onEvent: (event) => events.push(event),
    });

    expect(outcome.status).toBe("completed");
    expect(outcome.result.stdout).toBe("token [REDACTED]");
    expect(events).toContainEqual({
      type: "assistant",
      text: "token [REDACTED]",
    });
    expect(JSON.stringify(events)).not.toContain(secret);
    const run = await store.getRun(config.runId);
    expect(run?.activity.guardrailDecisions).toEqual([
      expect.objectContaining({
        decision: expect.objectContaining({
          phase: "output",
          action: "redact",
        }),
      }),
    ]);
    expect(JSON.stringify(run?.resumeState)).not.toContain(secret);
    expect(JSON.stringify(await readActivityLog(config.runId))).not.toContain(secret);
  });

  test("audit-mode output guardrails preserve delivered text and still record decisions", async () => {
    const secret = "sk-abcdefghijklmnopqrstuvwxyzABCDEFGH123456";
    setMockModel(mockTurnSequenceModel([
      { type: "text", text: `token ${secret}` },
    ]));
    const store = new InMemoryRunStore();
    const config = makeConfig({
      guardrailMode: "audit",
      guardrails: { outputPolicyPack: "default" },
    });

    const outcome = await executeRun(config, {
      runStore: store,
      pid: 4249,
      configPath: `memory://${config.runId}`,
    });

    expect(outcome.status, outcome.result.stderr).toBe("completed");
    expect(outcome.result.stdout).toBe(`token ${secret}`);
    expect((await store.getRun(config.runId))?.activity.guardrailDecisions)
      .toEqual([
        expect.objectContaining({
          decision: expect.objectContaining({
            action: "redact",
            phase: "output",
          }),
        }),
      ]);
  });

  test("audit-mode task guardrails report decisions without blocking tool execution", async () => {
    setMockModel(mockTurnSequenceModel([
      { type: "tool-call", toolName: "bash", args: { command: "rm -rf /" } },
      { type: "text", text: "continued in audit mode" },
    ]));
    const store = new InMemoryRunStore();
    const config = makeConfig({
      guardrailMode: "audit",
      guardrails: { toolPolicyPack: "default" },
    });
    const execute = vi.fn(async () => ({
      stdout: "observed",
      stderr: "",
      exitCode: 0,
    }));

    const outcome = await executeRun(config, {
      runStore: store,
      pid: 4248,
      configPath: `memory://${config.runId}`,
      shell: { execute },
    });

    expect(outcome.status, outcome.result.stderr).toBe("completed");
    expect(execute).toHaveBeenCalledOnce();
    expect((await store.getRun(config.runId))?.activity.guardrailDecisions)
      .toEqual([
        expect.objectContaining({
          decision: expect.objectContaining({ action: "approval" }),
        }),
      ]);
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

  test("onDelta (F1b): token deltas reach onEvent as text-delta events, separate from turn transcript & persistence", async () => {
    setMockModel(mockTurnSequenceModel([{ type: "text", text: "hello world" }]));
    const store = new InMemoryRunStore();
    const config = makeConfig();
    const events: Record<string, unknown>[] = [];

    await executeRun(config, {
      runStore: store,
      pid: 9,
      configPath: `memory://${config.runId}`,
      onEvent: (entry) => events.push(entry),
    });

    // Token deltas arrived on the same onEvent hook, tagged text-delta.
    const deltas = events.filter((e) => e.type === "text-delta");
    expect(deltas.length).toBeGreaterThan(1); // the mock splits text into chunks
    expect(deltas.map((d) => d.text).join("")).toBe("hello world");

    // The turn-granularity assistant entry is STILL emitted (unchanged path).
    expect(events.find((e) => e.type === "assistant")?.text).toBe("hello world");

    // Deltas did NOT pollute the persisted activity log — persistence stays
    // turn-granularity (deltas route via ctx.onDelta, not onTranscript).
    const log = await readActivityLog(config.runId);
    expect(log.filter((e) => (e.event ?? e.type) === "text-delta")).toHaveLength(0);
    expect(log.map((e) => e.event ?? e.type)).toContain("assistant");
  });

  test("chat injection records provider tools without dispatching them locally", async () => {
    let turn = 0;
    const usage = {
      inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 5, text: undefined, reasoning: undefined },
    };
    const providerModel = new MockLanguageModelV3({
      doStream: async () => {
        if (turn++ === 0) {
          return {
            stream: convertArrayToReadableStream([
              { type: "stream-start", warnings: [] },
              { type: "tool-input-start", id: "provider_1", toolName: "search_web", providerExecuted: true },
              { type: "tool-input-delta", id: "provider_1", delta: "{\"query\":\"Polpo\"}" },
              { type: "tool-input-end", id: "provider_1" },
              {
                type: "tool-call",
                toolCallId: "provider_1",
                toolName: "search_web",
                input: "{\"query\":\"Polpo\"}",
                providerExecuted: true,
              },
              {
                type: "tool-result",
                toolCallId: "provider_1",
                toolName: "search_web",
                output: { type: "json", value: { results: [] } },
                providerExecuted: true,
              },
              {
                type: "finish",
                finishReason: { unified: "tool-calls", raw: undefined },
                usage,
              },
            ] as any[]),
          };
        }
        return {
          stream: convertArrayToReadableStream([
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "text_1" },
            { type: "text-delta", id: "text_1", delta: "provider done" },
            { type: "text-end", id: "text_1" },
            { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
          ] as any[]),
        };
      },
    });
    const executor = vi.fn(async () => "must not execute");
    const events: Record<string, unknown>[] = [];
    const store = new InMemoryRunStore();
    const config = makeConfig();

    const outcome = await executeRun(config, {
      runStore: store,
      pid: 10,
      configPath: `memory://${config.runId}`,
      onEvent: (event) => events.push(event),
      inject: {
        agent: config.agent,
        model: { aiModel: providerModel, contextWindow: 200_000, maxTokens: 8192 },
        systemPrompt: "You are a test agent.",
        maxTurns: 3,
        seedMessages: [{ role: "user", content: "search" }],
        toolSet: {
          search_web: { type: "provider", id: "test.search", args: {} },
        },
        executor,
        clientSideToolNames: new Set(),
        providerToolNames: new Set(["search_web"]),
        compactionTools: [],
        compactionMode: "chat",
      },
    });

    expect(outcome.status).toBe("completed");
    expect(outcome.result.stdout).toBe("provider done");
    expect(executor).not.toHaveBeenCalled();
    expect(events.filter((event) => event.type === "tool_use")).toHaveLength(0);
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_result",
      toolId: "provider_1",
      tool: "search_web",
      input: { query: "Polpo" },
      providerExecuted: true,
      isError: false,
    }));
  });

  test("chat injection refreshes active tools after an explicit model-controlled load", async () => {
    let turn = 0;
    const visibleByTurn: string[][] = [];
    const usage = {
      inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 5, text: undefined, reasoning: undefined },
    };
    const model = new MockLanguageModelV3({
      doStream: async (options) => {
        visibleByTurn.push((options.tools ?? []).map((tool) => tool.name));
        turn += 1;
        if (turn === 1) {
          return { stream: convertArrayToReadableStream([
            { type: "stream-start", warnings: [] },
            { type: "tool-call", toolCallId: "load_run", toolName: "polpo_tool_load", input: JSON.stringify({ names: ["calculate"] }) },
            { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
          ] as any[]) };
        }
        if (turn === 2) {
          return { stream: convertArrayToReadableStream([
            { type: "stream-start", warnings: [] },
            { type: "tool-call", toolCallId: "calculate_run", toolName: "calculate", input: JSON.stringify({ value: 5 }) },
            { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
          ] as any[]) };
        }
        return { stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "run_text" },
          { type: "text-delta", id: "run_text", delta: "10" },
          { type: "text-end", id: "run_text" },
          { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
        ] as any[]) };
      },
    });
    const active = new Set(["polpo_tool_load"]);
    const executor = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === "polpo_tool_load") {
        active.add("calculate");
        return JSON.stringify({ loaded: ["calculate"] });
      }
      return String(Number(args.value) * 2);
    });
    const store = new InMemoryRunStore();
    const config = makeConfig();

    const outcome = await executeRun(config, {
      runStore: store,
      pid: 11,
      configPath: `memory://${config.runId}`,
      inject: {
        sessionId: "conversation-session-1",
        agent: config.agent,
        model: { aiModel: model, contextWindow: 200_000, maxTokens: 8192 },
        systemPrompt: "Use polpo_tool_load before calculate.",
        maxTurns: 3,
        seedMessages: [{ role: "user", content: "Double 5" }],
        toolSet: {
          polpo_tool_load: {
            description: "Load a tool",
            inputSchema: jsonSchema({
              type: "object",
              properties: { names: { type: "array", items: { type: "string" } } },
              required: ["names"],
            }),
          },
          calculate: {
            description: "Double a number",
            inputSchema: jsonSchema({
              type: "object",
              properties: { value: { type: "number" } },
              required: ["value"],
            }),
          },
        },
        activeToolNames: () => [...active],
        executor,
        clientSideToolNames: new Set(),
        providerToolNames: new Set(),
        compactionTools: [],
        compactionMode: "chat",
      },
    });

    expect(outcome.status).toBe("completed");
    expect(outcome.result.stdout).toBe("10");
    expect((await store.getRun(config.runId))?.sessionId).toBe("conversation-session-1");
    expect((await store.getRun(config.runId))?.activity.sessionId).toBe("conversation-session-1");
    expect(visibleByTurn).toEqual([
      ["polpo_tool_load"],
      ["polpo_tool_load", "calculate"],
      ["polpo_tool_load", "calculate"],
    ]);
    expect(executor).toHaveBeenNthCalledWith(
      1,
      "polpo_tool_load",
      { names: ["calculate"] },
      expect.objectContaining({ callId: "load_run" }),
    );
    expect(executor).toHaveBeenNthCalledWith(
      2,
      "calculate",
      { value: 5 },
      expect.objectContaining({ callId: "calculate_run" }),
    );
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
    // The shared model turn preserves the original provider diagnostic across
    // the run lifecycle instead of replacing it with a generic output error.
    expect(run?.result?.stderr).toContain("model exploded");
  });

  test("finalizes host resources once before persisting a successful terminal run", async () => {
    setMockModel(mockTextModel("done"));
    const store = new InMemoryRunStore();
    const complete = vi.spyOn(store, "completeRun");
    const finalize = vi.fn(async () => undefined);
    const config = makeConfig();

    const outcome = await executeRun(config, {
      runStore: store,
      pid: 1,
      configPath: "memory://finalize-success",
      finalize,
    });

    expect(outcome.status).toBe("completed");
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(finalize.mock.invocationCallOrder[0]).toBeLessThan(
      complete.mock.invocationCallOrder[0],
    );
  });

  test("fails the run when host resource finalization fails", async () => {
    setMockModel(mockTextModel("would have completed"));
    const store = new InMemoryRunStore();
    const finalize = vi.fn(async () => {
      throw new Error("hydrated volume is dirty");
    });
    const config = makeConfig();

    const outcome = await executeRun(config, {
      runStore: store,
      pid: 1,
      configPath: "memory://finalize-failure",
      finalize,
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.result.stderr).toContain("hydrated volume is dirty");
    expect(finalize).toHaveBeenCalledTimes(1);
    expect((await store.getRun(config.runId))?.status).toBe("failed");
  });

  test("host steering reaches the run and closes when the lifecycle settles", async () => {
    const controller = new InMemorySteeringController();
    controller.enqueue({
      id: "before-start",
      mode: "steer",
      content: { text: "Use the green version" },
    });
    let prompt = "";
    const inner = mockTextModel("green version ready");
    setMockModel(new MockLanguageModelV3({
      doStream: (options) => {
        prompt = JSON.stringify(options.prompt);
        return inner.doStream(options);
      },
    }));
    const store = new InMemoryRunStore();
    const config = makeConfig();

    const outcome = await executeRun(config, {
      runStore: store,
      pid: 1,
      configPath: "memory://steering",
      steering: controller,
    });

    expect(outcome.status).toBe("completed");
    expect(prompt).toContain("Use the green version");
    expect(() => controller.enqueue({
      id: "after-finish",
      mode: "steer",
      content: { text: "too late" },
    })).toThrow(/closed/i);
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
    expect(log.filter((e) => e.event === "sigterm")).toHaveLength(1);
  });

  test("steering abort cancels an in-flight model and marks the run killed once", async () => {
    let started!: () => void;
    const modelStarted = new Promise<void>((resolve) => { started = resolve; });
    setMockModel(new MockLanguageModelV3({
      doStream: async (options) => {
        started();
        await new Promise<void>((_resolve, reject) => {
          const signal = options.abortSignal;
          if (signal?.aborted) {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            return;
          }
          signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          }, { once: true });
        });
        return { stream: new ReadableStream() };
      },
    }));
    const controller = new InMemorySteeringController();
    const store = new InMemoryRunStore();
    const config = makeConfig();

    const running = executeRun(config, {
      runStore: store,
      pid: 8,
      configPath: "memory://steering-abort",
      steering: controller,
    });
    await modelStarted;
    controller.abort("cancelled by caller");
    const outcome = await running;

    expect(outcome.status).toBe("killed");
    expect(outcome.result.exitCode).toBe(1);
    const log = await readActivityLog(config.runId);
    expect(log.filter((entry) => entry.event === "sigterm")).toHaveLength(1);
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

  test("malformed persisted context fails closed only when enforcement is active", async () => {
    const store = new InMemoryRunStore();
    const enforced = makeConfig({
      contextTrust: "enforce",
      promptContextSegments: [{
        kind: "memory.agent",
        trust: "trusted",
        content: "ambiguous",
      } as any],
    });
    const failed = await executeRun(enforced, {
      runStore: store,
      pid: 1,
      configPath: "memory://invalid-context",
    });

    expect(failed.status).toBe("failed");
    expect(failed.spawnError).toBe(true);
    expect(failed.result.stderr).toContain("runtime context trust is invalid");

    setMockModel(mockTextModel("legacy still runs"));
    const disabled = makeConfig({
      contextTrust: "off",
      promptContextSegments: enforced.promptContextSegments,
    });
    const legacy = await executeRun(disabled, {
      runStore: store,
      pid: 2,
      configPath: "memory://disabled-context",
    });
    expect(legacy.status).toBe("completed");
    expect(legacy.result.stdout).toBe("legacy still runs");
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
