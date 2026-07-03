/**
 * Characterization tests for the task execution engine (spawnEngine).
 *
 * These pin the OBSERVABLE contract of the task path before the migration to
 * the core loop runtime (LoopRunner/PipelineExecutor): transcript event
 * sequence, activity tracking, outcome registration, maxTurns, abort, and
 * TaskResult shape. The loop-engine replacement must keep every assertion
 * here green (parity), so this file is intentionally engine-agnostic in what
 * it asserts — it describes behavior, not implementation.
 *
 * Mock strategy: same as completions.test.ts — vi.mock the pi-client module
 * so resolveModel returns a MockLanguageModelV3 wrapped in a ResolvedModel.
 * Everything else (tool layer, filesystem, prompt building) runs for real
 * against a temp directory.
 *
 * Known non-injectable seams of the current engine (documented, not tested):
 * - activity.toolUsage harvesting (needs image/video tools with gateway
 *   metadata — the engine builds its own tools, so a fake tool cannot be
 *   injected). Covered from Phase 1 where the tool set is injectable.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedModel } from "../llm/pi-client.js";
import {
  type MockLanguageModelV3,
  mockTextModel,
  mockTurnSequenceModel,
  mockResolvedModel,
  type MockResponse,
} from "./helpers/mock-llm.js";

// ── Mock pi-client BEFORE any imports that pull it in ──

let activeResolvedModel: ResolvedModel = mockResolvedModel(mockTextModel("default"));

vi.mock("../llm/pi-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../llm/pi-client.js")>();
  return {
    ...actual,
    resolveModel: () => activeResolvedModel,
    enforceModelAllowlist: () => {},
    mapReasoningToProviderOptions: () => undefined,
  };
});

import { spawnEngine } from "../adapters/engine.js";
import { spawnLoopEngine } from "../adapters/loop-engine.js";
import type { AgentConfig, Task } from "../core/types.js";

// Both engines must satisfy the same observable contract: the legacy
// manual loop and its loop-runtime replacement. This IS the parity gate
// for the migration.
const ENGINES = [
  ["spawnEngine (legacy)", spawnEngine],
  ["spawnLoopEngine (loop runtime)", spawnLoopEngine],
] as const;

// ── Helpers ─────────────────────────────────────────────

function setMockModel(model: MockLanguageModelV3, overrides: Partial<ResolvedModel> = {}) {
  activeResolvedModel = { ...mockResolvedModel(model), ...overrides };
}

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { name: "char-agent", role: "developer", ...overrides };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-char-1",
    title: "Characterization task",
    description: "Do the scripted thing.",
    state: "in_progress",
    expectations: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    assignedTo: "char-agent",
    ...overrides,
  } as Task;
}

interface TranscriptEntry {
  type: string;
  [key: string]: unknown;
}

let tmpRoot: string;
let cwd: string;
let polpoDir: string;
let outputDir: string;

beforeAll(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "polpo-engine-char-"));
  cwd = join(tmpRoot, "work");
  polpoDir = join(tmpRoot, ".polpo");
  outputDir = join(tmpRoot, "output");
  await mkdir(cwd, { recursive: true });
  await mkdir(polpoDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });
});

afterAll(async () => {
  if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
});

// ── Tests ───────────────────────────────────────────────

describe.each(ENGINES)("%s — characterization", (_label, spawn) => {
  /** Spawn the engine and collect every transcript entry until done. */
  async function runEngine(
    agent: AgentConfig,
    responses: MockResponse[] | MockLanguageModelV3,
    modelOverrides: Partial<ResolvedModel> = {},
    taskOverrides: Partial<Task> = {},
  ) {
    const model = Array.isArray(responses) ? mockTurnSequenceModel(responses) : responses;
    setMockModel(model, modelOverrides);
    const transcript: TranscriptEntry[] = [];
    // outputDir is required for register_outcome to exist: the tool is
    // task-only by design — createSystemTools injects it only when the
    // caller provides an output directory (chat completions never do).
    const handle = spawn(agent, makeTask(taskOverrides), cwd, { polpoDir, outputDir });
    handle.onTranscript = (entry) => transcript.push(entry as TranscriptEntry);
    const result = await handle.done;
    return { handle, result, transcript };
  }
  test("text-only run: TaskResult shape, transcript, handle lifecycle", async () => {
    const { handle, result, transcript } = await runEngine(makeAgent(), [
      { type: "text", text: "All done here." },
    ]);

    // TaskResult contract
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("All done here.");
    expect(result.stderr).toBe("");
    expect(result.duration).toBeGreaterThanOrEqual(0);

    // Handle lifecycle
    expect(handle.isAlive()).toBe(false);
    expect(handle.agentName).toBe("char-agent");
    expect(handle.taskId).toBe("task-char-1");
    expect(handle.pid).toBe(0); // in-process: no OS pid

    // Transcript: exactly one assistant entry with the final text
    const assistant = transcript.filter((t) => t.type === "assistant");
    expect(assistant).toHaveLength(1);
    expect(assistant[0].text).toBe("All done here.");

    // Activity summary mirrors last assistant text (truncated to 200)
    expect(handle.activity.summary).toBe("All done here.");
    expect(handle.activity.totalTokens).toBeGreaterThan(0);
  });

  test("tool loop: transcript order, activity tracking, real file effects", async () => {
    const { handle, result, transcript } = await runEngine(makeAgent(), [
      { type: "tool-call", toolName: "write", args: { path: "out.txt", content: "hello" } },
      { type: "tool-call", toolName: "bash", args: { command: "echo ciao" } },
      { type: "text", text: "done" },
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("done");

    // The write tool really wrote the file in cwd
    const written = await readFile(join(cwd, "out.txt"), "utf-8");
    expect(written).toBe("hello");

    // Transcript order: per turn, tool_use precedes its tool_result;
    // final assistant text comes last.
    const types = transcript.map((t) => `${t.type}${t.tool ? `:${t.tool}` : ""}`);
    expect(types).toEqual([
      "tool_use:write",
      "tool_result:write",
      "tool_use:bash",
      "tool_result:bash",
      "assistant",
    ]);

    // tool_use carries input, tool_result carries content and isError=false
    const bashUse = transcript.find((t) => t.type === "tool_use" && t.tool === "bash");
    expect(bashUse?.input).toEqual({ command: "echo ciao" });
    const bashResult = transcript.find((t) => t.type === "tool_result" && t.tool === "bash");
    expect(bashResult?.isError).toBe(false);
    expect(String(bashResult?.content)).toContain("ciao");

    // Activity tracking
    expect(handle.activity.toolCalls).toBe(2);
    expect(handle.activity.lastTool).toBe("bash");
    expect(handle.activity.filesCreated).toHaveLength(1);
    expect(handle.activity.filesCreated[0].endsWith("out.txt")).toBe(true);
    expect(handle.activity.filesEdited).toHaveLength(0);
    expect(handle.activity.totalTokens).toBeGreaterThan(0);
  });

  test("register_outcome: outcomes are collected on the handle with full shape", async () => {
    const { handle, result } = await runEngine(makeAgent(), [
      {
        type: "tool-call",
        toolName: "register_outcome",
        args: { type: "text", label: "Summary", text: "Revenue up 23%" },
      },
      { type: "text", text: "registered" },
    ]);

    expect(result.exitCode).toBe(0);
    expect(handle.outcomes).toBeDefined();
    expect(handle.outcomes).toHaveLength(1);
    const outcome = handle.outcomes![0];
    expect(outcome.type).toBe("text");
    expect(outcome.label).toBe("Summary");
    expect(outcome.text).toBe("Revenue up 23%");
    expect(outcome.producedBy).toBe("register_outcome");
    expect(typeof outcome.id).toBe("string");
    expect(outcome.id.length).toBeGreaterThan(0);
    expect(typeof outcome.producedAt).toBe("string");
  });

  test("maxTurns: a model that never stops is capped, run still succeeds", async () => {
    // A fresh tool-call response per turn (a static mockToolCallModel reuses
    // one consumed stream) — the model would loop forever without the cap.
    const alwaysToolCall: MockResponse[] = Array.from({ length: 6 }, () => ({
      type: "tool-call" as const,
      toolName: "bash",
      args: { command: "true" },
    }));
    const { handle, result } = await runEngine(makeAgent({ maxTurns: 3 }), alwaysToolCall);

    expect(result.exitCode).toBe(0);
    // One tool call per turn, capped at maxTurns
    expect(handle.activity.toolCalls).toBe(3);
    expect(handle.isAlive()).toBe(false);
  });

  test("failing tool command: isError stays false (bash reports, not throws), loop continues", async () => {
    const { handle, result, transcript } = await runEngine(makeAgent(), [
      { type: "tool-call", toolName: "bash", args: { command: "exit 3" } },
      { type: "text", text: "recovered" },
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("recovered");
    expect(handle.activity.toolCalls).toBe(1);
    const bashResult = transcript.find((t) => t.type === "tool_result" && t.tool === "bash");
    expect(bashResult).toBeDefined();
    // Characterization: non-zero exit codes are reported as content, not
    // thrown — the engine's isError flag is reserved for tool exceptions.
    expect(bashResult?.isError).toBe(false);
  });

  test("kill(): run terminates, no model turns are consumed after abort", async () => {
    setMockModel(mockTextModel("should not matter"));
    const handle = spawn(makeAgent(), makeTask(), cwd, { polpoDir });
    handle.kill();
    const result = await handle.done;

    expect(handle.isAlive()).toBe(false);
    // Aborted before the first turn: clean exit, no output, no tool calls.
    expect(handle.activity.toolCalls).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(0);
  });

  test("model error: exitCode 1, stderr message, error transcript entry", async () => {
    const boom = new (await import("ai/test")).MockLanguageModelV3({
      doStream: async () => {
        throw new Error("provider exploded");
      },
    });
    const { handle, result, transcript } = await runEngine(makeAgent(), boom);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    // Characterization: the stream error surfaces as an "error" part in
    // fullStream (with the real message), while awaiting stream.text then
    // throws the generic AI SDK error — which is what lands in stderr.
    expect(result.stderr).toContain("No output generated");
    expect(handle.isAlive()).toBe(false);
    const errors = transcript.filter((t) => t.type === "error");
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.some((e) => String(e.message).includes("provider exploded"))).toBe(true);
  });

  test("compaction: fires once multi-turn history exists over the window", async () => {
    // Characterization of the CURRENT trigger, with two known quirks pinned
    // on purpose (they are findings, not features — the loop-engine must
    // change them deliberately, not silently):
    // 1. A single over-threshold user message never emits an event
    //    (splitIndex <= 0 short-circuit in compactIfNeeded).
    // 2. estimateMessageTokens only counts "text" and legacy "toolCall"
    //    blocks — AI SDK v6 "tool-call"/"tool-result" parts are NOT counted,
    //    so tool outputs never contribute to the estimate and compaction on
    //    tool-heavy tasks effectively never triggers. The only reliably
    //    counted mass is the system prompt + string user messages.
    // Therefore: an over-threshold task DESCRIPTION + one tool turn makes
    // the summarize phase observable at turn 1.
    const { result, transcript } = await runEngine(
      makeAgent(),
      [
        { type: "tool-call", toolName: "bash", args: { command: "true" } },
        { type: "text", text: "compacted and finished" },
      ],
      { contextWindow: 3000, maxTokens: 256 },
      { description: "analyze this dataset. ".repeat(600) },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("compacted and finished");
    const compactions = transcript.filter((t) => t.type === "compaction");
    expect(compactions.length).toBeGreaterThanOrEqual(1);
    expect(compactions[0].phase).toBe("summarize");
    expect(compactions[0].tokensBefore).toBeGreaterThan(0);
  });
});
