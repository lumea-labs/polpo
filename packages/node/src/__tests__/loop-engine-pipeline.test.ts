/**
 * Loop-engine pipeline tests — the Phase 3 feature surface.
 *
 * What tasks gain from the loop runtime once the agent HAS loop config:
 * - project loop graphs (.polpo/loops/<name>.json) driven by the
 *   PipelineExecutor: agent steps as independent LLM sessions over a
 *   shared context bag, deterministic tool steps without LLM turns
 * - single-loop overlays (task.loop names an inline loop): tools subset,
 *   maxTurns, systemPrompt merge — same semantics as chat completions
 *
 * Agents WITHOUT loop config are covered by the parity suite in
 * engine-behavior.test.ts (identical behavior to the legacy engine).
 */

import { describe, test, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedModel } from "@polpo-ai/llm";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import {
  mockTurnSequenceModel,
  mockResolvedModel,
  type MockResponse,
} from "./helpers/mock-llm.js";

let activeResolvedModel: ResolvedModel = mockResolvedModel(mockTurnSequenceModel([{ type: "text", text: "default" }]));

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

// ── Setup ───────────────────────────────────────────────

let tmpRoot: string;
let cwd: string;
let polpoDir: string;
let outputDir: string;

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-loop-1",
    title: "Pipeline task",
    description: "Run the configured flow.",
    state: "in_progress",
    expectations: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    assignedTo: "loop-agent",
    ...overrides,
  } as Task;
}

interface TranscriptEntry {
  type: string;
  [key: string]: unknown;
}

async function runAgent(agent: AgentConfig, responses: MockResponse[]) {
  activeResolvedModel = mockResolvedModel(mockTurnSequenceModel(responses));
  const transcript: TranscriptEntry[] = [];
  // Loops now run only when the task explicitly requests one. Request the
  // agent's assigned project loop, or its inline loop, by name.
  const loop = agent.assignedLoops?.[0] ?? Object.keys(agent.loops ?? {})[0];
  const handle = spawnLoopEngine(agent, makeTask({ loop }), cwd, { polpoDir, outputDir });
  handle.onTranscript = (entry) => transcript.push(entry as TranscriptEntry);
  const result = await handle.done;
  return { handle, result, transcript };
}

async function writeProjectLoop(name: string, loop: Record<string, unknown>) {
  await writeFile(join(polpoDir, "loops", `${name}.json`), JSON.stringify(loop, null, 2));
}

beforeAll(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "polpo-loop-pipeline-"));
  cwd = join(tmpRoot, "work");
  polpoDir = join(tmpRoot, ".polpo");
  outputDir = join(tmpRoot, "output");
  await mkdir(cwd, { recursive: true });
  await mkdir(join(polpoDir, "loops"), { recursive: true });
  await mkdir(outputDir, { recursive: true });
});

afterAll(async () => {
  if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
});

// ── Tests ───────────────────────────────────────────────

describe("spawnLoopEngine — project loop graphs", () => {
  test("runs a two-step agent graph: independent sessions, shared trace, last step wins stdout", async () => {
    await writeProjectLoop("ship-flow", {
      name: "ship-flow",
      start: "plan",
      steps: {
        plan: { systemPrompt: "Produce a plan.", next: "build" },
        build: { next: "end" },
      },
    });

    const { result, transcript } = await runAgent(
      {
        name: "loop-agent",
        role: "developer",
        assignedLoops: ["ship-flow"],
      },
      [
        { type: "text", text: "PLAN: do the thing" },
        { type: "text", text: "BUILT" },
      ],
    );

    expect(result.exitCode).toBe(0);
    // stdout is the last agent step's final text
    expect(result.stdout).toBe("BUILT");

    // Both steps produced assistant turns (independent sessions)
    const assistant = transcript.filter((t) => t.type === "assistant");
    expect(assistant.map((a) => a.text)).toEqual(["PLAN: do the thing", "BUILT"]);

    // The pipeline emitted trace events for both steps
    const traces = transcript.filter((t) => t.type === "loop_trace");
    expect(traces.length).toBeGreaterThan(0);
    const traceTypes = traces.map((t) => (t.trace as { type: string }).type);
    expect(traceTypes).toContain("step.start");
    expect(traceTypes).toContain("step.end");
  });

  test("tool steps execute deterministically without an LLM turn", async () => {
    await writeProjectLoop("fetch-flow", {
      name: "fetch-flow",
      start: "greet",
      steps: {
        greet: {
          type: "tool",
          tool: "bash",
          input: { command: "echo pipeline-hi" },
          saveAs: "greeting",
          next: "summarize",
        },
        summarize: { next: "end" },
      },
    });

    const { handle, result, transcript } = await runAgent(
      {
        name: "loop-agent",
        role: "developer",
        assignedLoops: ["fetch-flow"],
      },
      [
        // Only ONE model response: the summarize step. The greet tool step
        // must not consume a model turn.
        { type: "text", text: "SUMMARY" },
      ],
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("SUMMARY");

    // The tool step really ran bash
    expect(handle.activity.toolCalls).toBe(1);
    const bashResult = transcript.find((t) => t.type === "tool_result" && t.tool === "bash");
    expect(bashResult).toBeDefined();
    expect(String(bashResult?.content)).toContain("pipeline-hi");
  });

  test("projected agent input excludes the task prompt and unrelated shared context", async () => {
    await writeProjectLoop("repair-flow", {
      name: "repair-flow",
      start: "validate",
      steps: {
        validate: {
          type: "tool",
          tool: "bash",
          input: {
            command: "printf '%s' '{\"failures\":[{\"message\":\"fix-this-exactly\"}]}'",
          },
          saveAs: "validation",
          next: "unrelated",
        },
        unrelated: {
          type: "tool",
          tool: "bash",
          input: { command: "printf '%s' 'do-not-pass'" },
          saveAs: "creative",
          next: "repair",
        },
        repair: {
          type: "agent",
          systemPrompt: "Repair only the supplied failures.",
          input: {
            diagnostic: { $context: "validation" },
            attempt: 1,
          },
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["diagnostic", "attempt"],
            properties: {
              diagnostic: { type: "string", minLength: 1 },
              attempt: { type: "integer", minimum: 1 },
            },
          },
          next: "end",
        },
      },
    });

    const prompts: unknown[] = [];
    activeResolvedModel = mockResolvedModel(new MockLanguageModelV3({
      doStream: async (options) => {
        prompts.push(options.prompt);
        return {
          stream: convertArrayToReadableStream([
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "text" },
            { type: "text-delta", id: "text", delta: "REPAIRED" },
            { type: "text-end", id: "text" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: undefined },
              usage: {
                inputTokens: { total: 1 },
                outputTokens: { total: 1 },
              },
            },
          ] as any[]),
        };
      },
    }));
    const handle = spawnLoopEngine(
      {
        name: "loop-agent",
        role: "developer",
        assignedLoops: ["repair-flow"],
      },
      makeTask({
        loop: "repair-flow",
        description: "redesign the whole site creatively",
      }),
      cwd,
      { polpoDir, outputDir },
    );
    const result = await handle.done;

    expect(result.exitCode, result.stderr).toBe(0);
    const prompt = JSON.stringify(prompts[0]);
    expect(prompt).toContain("fix-this-exactly");
    expect(prompt).toContain('\\"attempt\\":1');
    expect(prompt).not.toContain("redesign the whole site creatively");
    expect(prompt).not.toContain("do-not-pass");
  });

  test("missing assigned loop file fails the task loudly", async () => {
    const { result } = await runAgent(
      {
        name: "loop-agent",
        role: "developer",
        assignedLoops: ["ghost-flow"],
      },
      [{ type: "text", text: "never used" }],
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('ghost-flow');
    expect(result.stderr).toContain("not found");
  });

  test("human steps are rejected in task runs (v1)", async () => {
    await writeProjectLoop("human-flow", {
      name: "human-flow",
      start: "review",
      steps: {
        review: { type: "human", next: "end" },
      },
    });

    const { result } = await runAgent(
      {
        name: "loop-agent",
        role: "developer",
        assignedLoops: ["human-flow"],
      },
      [{ type: "text", text: "never used" }],
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("human");
  });
});

describe("spawnLoopEngine — single-loop overlays", () => {
  test("inline loops.default applies maxTurns overlay", async () => {
    // Model never stops calling tools — the LOOP's maxTurns (2) must cap
    // it, not the agent default (150).
    const alwaysToolCall: MockResponse[] = Array.from({ length: 5 }, () => ({
      type: "tool-call" as const,
      toolName: "bash",
      args: { command: "true" },
    }));

    const { handle, result } = await runAgent(
      {
        name: "loop-agent",
        role: "developer",
        loops: { default: { maxTurns: 2 } },
      },
      alwaysToolCall,
    );

    expect(result.exitCode).toBe(0);
    expect(handle.activity.toolCalls).toBe(2);
  });
});
