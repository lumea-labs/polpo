import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedModel } from "@polpo-ai/llm";
import { mockResolvedModel, mockTextModel, mockTurnSequenceModel } from "./helpers/mock-llm.js";

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

import { InMemorySteeringController } from "@polpo-ai/core/steering";
import { RuntimeHookEngine } from "@polpo-ai/core/runtime-hooks";
import type { AgentConfig, Task } from "@polpo-ai/core/types";
import { spawnLoopEngine } from "../adapters/loop-engine.js";

let root: string;
let cwd: string;
let polpoDir: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "polpo-runtime-hooks-"));
  cwd = join(root, "work");
  polpoDir = join(root, ".polpo");
  await mkdir(cwd, { recursive: true });
  await mkdir(polpoDir, { recursive: true });
});

afterAll(async () => { await rm(root, { recursive: true, force: true }); });

function agent(): AgentConfig { return { name: "hooked", role: "assistant", maxTurns: 4 }; }
function task(): Task {
  const now = new Date().toISOString();
  return {
    id: "hooks-task", title: "Original task", description: "Start here", state: "in_progress",
    expectations: [], createdAt: now, updatedAt: now, assignedTo: "hooked",
  } as Task;
}

describe("loop-engine runtime hooks", () => {
  test("a termination gate continues the same durable agent before sealing steering", async () => {
    activeResolvedModel = mockResolvedModel(mockTurnSequenceModel([
      { type: "text", text: "unvalidated draft" },
      { type: "text", text: "corrected final" },
    ]));
    let attempts = 0;
    const hooks = new RuntimeHookEngine({
      definitions: [{ id: "validate", event: "turn:stop", terminationGate: { maxCycles: 2, maxDurationMs: 30_000, maxTokens: 10_000 }, handler: { type: "tool", tool: "validate" } }],
      host: { execute: async () => ({ decision: attempts++ === 0
        ? { action: "continue" as const, feedback: { errors: ["missing import"] } }
        : { action: "allow" as const } }) },
    });
    const transcript: any[] = [];
    const checkpoints: any[] = [];
    const result = await spawnLoopEngine(agent(), task(), cwd, { polpoDir, runtimeHooks: hooks,
      onTranscript: entry => transcript.push(entry), onTurnCheckpoint: async state => { checkpoints.push(structuredClone(state)); },
    }).done;
    expect(result.exitCode, JSON.stringify(result)).toBe(0);
    expect(attempts).toBe(2);
    expect(transcript.filter(entry => entry.type === "assistant").map(entry => entry.text)).toEqual(["corrected final"]);
    expect(checkpoints.some(state => state.terminationGate?.cycles === 1 && JSON.stringify(state.history).includes("missing import"))).toBe(true);
    expect(checkpoints.at(-1).terminationPhase).toBe("accepted");
  });

  test("run-backed chat honors one bounded turn:stop feedback recovery", async () => {
    activeResolvedModel = mockResolvedModel(mockTurnSequenceModel([
      { type: "text", text: "draft" },
      { type: "text", text: "corrected" },
    ]));
    let stopCalls = 0;
    const hooks = new RuntimeHookEngine({
      definitions: [{ id: "review-stop", event: "turn:stop", handler: { type: "prompt", prompt: "review" } }],
      host: {
        execute: async () => ({
          decision: stopCalls++ === 0
            ? { action: "stop" as const, feedback: "Correct the final answer" }
            : { action: "allow" as const },
        }),
      },
    });
    const transcript: any[] = [];
    const handle = spawnLoopEngine(agent(), task(), cwd, {
      polpoDir,
      runtimeHooks: hooks,
      onTranscript: (entry) => transcript.push(entry),
    });

    const result = await handle.done;

    expect(result.exitCode).toBe(0);
    expect(transcript.filter((entry) => entry.type === "assistant").map((entry) => entry.text)).toEqual(["draft", "corrected"]);
    expect(stopCalls).toBe(2);
  });

  test("emits one tool:batch:after event after each completed Run-backed batch", async () => {
    activeResolvedModel = mockResolvedModel(mockTurnSequenceModel([
      { type: "tool-call", toolName: "missing_tool", args: { value: 1 } },
      { type: "text", text: "done" },
    ]));
    const batches: Array<Record<string, unknown>> = [];
    const hooks = new RuntimeHookEngine({
      definitions: [{
        id: "observe-batch",
        event: "tool:batch:after",
        mode: "observe",
        handler: { type: "tool", tool: "audit" },
      }],
      host: {
        execute: async ({ envelope }) => {
          batches.push(envelope.data);
        },
      },
    });
    const handle = spawnLoopEngine(agent(), task(), cwd, {
      polpoDir,
      runtimeHooks: hooks,
    });

    const result = await handle.done;

    expect(result.exitCode).toBe(0);
    expect(batches).toEqual([expect.objectContaining({ count: 1, failed: 1 })]);
  });
});


describe("durable termination repair", () => {
  test("repairs a real file with tools, then accepted resume runs no model or tools", async () => {
    activeResolvedModel = mockResolvedModel(mockTurnSequenceModel([
      { type: "text", text: "premature completion" },
      { type: "tool-call", toolName: "write", args: { path: "gate-repair.txt", content: "fixed" } },
      { type: "text", text: "validated completion" },
    ]));
    let validations = 0;
    const hooks = new RuntimeHookEngine({ definitions: [{ id: "validate", event: "turn:stop", terminationGate: { maxCycles: 2, maxDurationMs: 30000, maxTokens: 10000 }, handler: { type: "tool", tool: "validate" } }], host: { execute: async () => {
      validations++;
      const fixed = await readFile(join(cwd, "gate-repair.txt"), "utf8").catch(() => "");
      return { decision: fixed === "fixed" ? { action: "allow" } : { action: "continue", feedback: { failures: ["Write gate-repair.txt with fixed"] } } };
    } } });
    let saved: any;
    const run = await spawnLoopEngine(agent(), task(), cwd, { polpoDir, runtimeHooks: hooks, onTurnCheckpoint: state => { saved = structuredClone(state); } }).done;
    expect(run.exitCode, JSON.stringify(run)).toBe(0);
    expect(await readFile(join(cwd, "gate-repair.txt"), "utf8")).toBe("fixed");
    expect(validations).toBe(2);
    activeResolvedModel = mockResolvedModel(mockTurnSequenceModel([]));
    saved.terminationGate.startedAt = Date.now() - 60_000;
    const replay = await spawnLoopEngine(agent(), task(), cwd, { polpoDir, runtimeHooks: hooks, resumeState: saved }).done;
    expect(replay.exitCode, JSON.stringify(replay)).toBe(0);
    expect(validations).toBe(2);
    expect(replay.stdout).toBe("validated completion");
  });
  test("retains a pending validation on write failure and never restarts uncertain tools", async () => {
    activeResolvedModel = mockResolvedModel(mockTextModel("draft"));
    const hooks = new RuntimeHookEngine({ definitions: [{ id: "validate", event: "turn:stop", terminationGate: { maxCycles: 1, maxDurationMs: 30000, maxTokens: 10000 }, handler: { type: "tool", tool: "validate" } }], host: { execute: async () => ({ decision: { action: "continue", feedback: "repair" } }) } });
    let inFlight: any;
    const result = await spawnLoopEngine(agent(), task(), cwd, { polpoDir, runtimeHooks: hooks, onTurnCheckpoint: state => {
      if (state.terminationPhase === "in_flight") inFlight = structuredClone(state);
      else throw new Error("durable store offline");
    } }).done;
    expect(result.exitCode).toBe(1);
    activeResolvedModel = mockResolvedModel(mockTurnSequenceModel([]));
    const resumed = await spawnLoopEngine(agent(), task(), cwd, { polpoDir, runtimeHooks: hooks, resumeState: inFlight }).done;
    expect(resumed.exitCode).toBe(1);
    expect(JSON.stringify(resumed)).toMatch(/unconfirmed|may have committed effects/);
  });
});


test("steering arriving during validation invalidates the candidate and is validated again", async () => {
  activeResolvedModel = mockResolvedModel(mockTurnSequenceModel([{ type: "text", text: "old answer" }, { type: "text", text: "answer with steering" }]));
  const steering = new InMemorySteeringController();
  let attempts = 0;
  const hooks = new RuntimeHookEngine({ definitions: [{ id: "validate", event: "turn:stop", terminationGate: { maxCycles: 1, maxDurationMs: 30000, maxTokens: 10000 }, handler: { type: "tool", tool: "validate" } }], host: { execute: async () => {
    if (++attempts === 1) steering.enqueue({ id: "during-validation", mode: "steer", content: { text: "Also make it green" } });
    return { decision: { action: "allow" } };
  } } });
  const checkpoints: any[] = [];
  const result = await spawnLoopEngine(agent(), task(), cwd, { polpoDir, runtimeHooks: hooks, steering, onTurnCheckpoint: state => { checkpoints.push(structuredClone(state)); } }).done;
  expect(result.exitCode, JSON.stringify(result)).toBe(0);
  expect(result.stdout).toBe("answer with steering");
  expect(attempts).toBe(2);
  expect(JSON.stringify(checkpoints.at(-1).history)).toContain("Also make it green");
  expect(checkpoints.at(-1).terminationGate).toMatchObject({ attempts: 2, cycles: 0, accepted: true });
});
