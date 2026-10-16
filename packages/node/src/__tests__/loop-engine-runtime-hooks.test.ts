import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
