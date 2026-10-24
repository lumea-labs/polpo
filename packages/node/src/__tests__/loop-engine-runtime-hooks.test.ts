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
import { HookEngine, HookRuntime, createScriptedHookRuntime } from "@polpo-ai/core/runtime-hooks";
import type { AgentConfig, Task } from "@polpo-ai/core/types";
import { spawnLoopEngine } from "../adapters/loop-engine.js";
import { createNodeHookHost } from "../hooks-host.js";

const stopHook = (respond: Parameters<typeof createScriptedHookRuntime>[0]["respond"]) =>
  createScriptedHookRuntime({ hooks: { Stop: [{ hooks: [{ type: "command", command: "validate" }] }] }, respond });

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
  test("injected chat commands use the host sandbox, never the engine's local fallback shell", async () => {
    const hostShell = { execute: vi.fn(async (_command: string, _options?: unknown) => ({ stdout: "", stderr: "", exitCode: 0 })) };
    const localShell = { execute: vi.fn(async () => { throw new Error("Must not execute a managed hook on the server host"); }) };
    const hooks = new HookRuntime(new HookEngine({
      projectDir: "/sandbox/workspace",
      host: createNodeHookHost({ shell: hostShell }),
      sources: [{ source: "agent", name: "p", hooks: { Stop: [{ hooks: [{ type: "command", command: "validate" }] }] } }],
    }), { sessionId: "s", cwd: "/sandbox/workspace", projectDir: "/sandbox/workspace" });
    const result = await spawnLoopEngine(agent(), task(), cwd, { polpoDir, shell: localShell, inject: {
      agent: agent(), runtimeHooks: hooks, model: mockResolvedModel(mockTextModel("done")), systemPrompt: "Test", maxTurns: 2,
      seedMessages: [{ role: "user", content: "Finish" }], toolSet: {}, executor: vi.fn(), clientSideToolNames: new Set(), providerToolNames: new Set(), compactionTools: [], compactionMode: "chat",
    } }).done;
    expect(result.exitCode, JSON.stringify(result)).toBe(0);
    expect(localShell.execute).not.toHaveBeenCalled();
    expect(hostShell.execute).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("| base64 -d | sh -c 'validate'"), expect.objectContaining({ cwd: "/sandbox/workspace" }));
  });

  test("a Stop hook continues the same durable agent before sealing steering", async () => {
    activeResolvedModel = mockResolvedModel(mockTurnSequenceModel([
      { type: "text", text: "unvalidated draft" },
      { type: "text", text: "corrected final" },
    ]));
    let attempts = 0;
    const hooks = stopHook(() => (attempts++ === 0 ? { exitCode: 2, stderr: "missing import" } : { exitCode: 0 }));
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

  test("run-backed chat replaces the candidate after Stop hook feedback", async () => {
    activeResolvedModel = mockResolvedModel(mockTurnSequenceModel([
      { type: "text", text: "draft" },
      { type: "text", text: "corrected" },
    ]));
    let stopCalls = 0;
    const hooks = stopHook(() => (stopCalls++ === 0 ? { exitCode: 2, stderr: "Correct the final answer" } : { exitCode: 0 }));
    const transcript: any[] = [];
    const handle = spawnLoopEngine(agent(), task(), cwd, {
      polpoDir,
      runtimeHooks: hooks,
      onTranscript: (entry) => transcript.push(entry),
    });

    const result = await handle.done;

    expect(result.exitCode).toBe(0);
    expect(transcript.filter((entry) => entry.type === "assistant").map((entry) => entry.text)).toEqual(["corrected"]);
    expect(stopCalls).toBe(2);
  });

  test("fires one PostToolBatch after each completed batch", async () => {
    activeResolvedModel = mockResolvedModel(mockTurnSequenceModel([
      { type: "tool-call", toolName: "missing_tool", args: { value: 1 } },
      { type: "text", text: "done" },
    ]));
    const batches: Array<Record<string, unknown>> = [];
    const hooks = createScriptedHookRuntime({
      hooks: { PostToolBatch: [{ hooks: [{ type: "command", command: "audit" }] }] },
      respond: (input) => { batches.push(input); return {}; },
    });
    const handle = spawnLoopEngine(agent(), task(), cwd, {
      polpoDir,
      runtimeHooks: hooks,
    });

    const result = await handle.done;

    expect(result.exitCode).toBe(0);
    expect(batches).toEqual([expect.objectContaining({ hook_event_name: "PostToolBatch", tool_calls: [expect.objectContaining({ tool_name: "missing_tool" })] })]);
  });
});


describe("durable Stop hook repair", () => {
  test("repairs a real file with tools, then accepted resume runs no model or tools", async () => {
    activeResolvedModel = mockResolvedModel(mockTurnSequenceModel([
      { type: "text", text: "premature completion" },
      { type: "tool-call", toolName: "write", args: { path: "gate-repair.txt", content: "fixed" } },
      { type: "text", text: "validated completion" },
    ]));
    let validations = 0;
    const hooks = stopHook(async () => {
      validations++;
      const fixed = await readFile(join(cwd, "gate-repair.txt"), "utf8").catch(() => "");
      return fixed === "fixed" ? { exitCode: 0 } : { exitCode: 2, stderr: "Write gate-repair.txt with fixed" };
    });
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
    const hooks = stopHook(() => ({ exitCode: 2, stderr: "repair" }));
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
  const hooks = stopHook(() => {
    if (++attempts === 1) steering.enqueue({ id: "during-validation", mode: "steer", content: { text: "Also make it green" } });
    return { exitCode: 0 };
  });
  const checkpoints: any[] = [];
  const result = await spawnLoopEngine(agent(), task(), cwd, { polpoDir, runtimeHooks: hooks, steering, onTurnCheckpoint: state => { checkpoints.push(structuredClone(state)); } }).done;
  expect(result.exitCode, JSON.stringify(result)).toBe(0);
  expect(result.stdout).toBe("answer with steering");
  expect(attempts).toBe(2);
  expect(JSON.stringify(checkpoints.at(-1).history)).toContain("Also make it green");
  expect(checkpoints.at(-1).terminationGate).toMatchObject({ attempts: 2, cycles: 0, accepted: true });
});
