import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import { MemoryLoopRunStore } from "@polpo-ai/core";
import { runProjectLoopCompletion } from "./project-loop-runner.js";
import { createScriptedHookRuntime } from "@polpo-ai/core/runtime-hooks";
import { normalizeChatInteractionSettings } from "@polpo-ai/core/chat-interactions";
import { executeStreamingChatCompletion, runNonStreamingChatCompletion, type ChatCompletionExecution } from "./chat-handler.js";
import { modelOutputForResponseFormat } from "./structured-output.js";
import { runAgentStepCompletion } from "./agent-step-runner.js";
import type { CompletionRouteDeps } from "../completions.js";

function fixture(structured = false) {
  let repaired = false;
  const calls: any[] = [];
  // A copied Claude Code Stop hook: exit 2 with diagnostics until the repair lands.
  const validate = vi.fn(async (_input: Record<string, any>) => repaired
    ? { exitCode: 0 }
    : { exitCode: 2, stderr: JSON.stringify({ valid: false, failures: [{ phase: "build", code: "missing_import", diagnostics: "Add the missing import to src/app.ts" }] }) });
  const ledger = new Map<string, any>();
  const hooks = createScriptedHookRuntime({
    hooks: { Stop: [{ hooks: [{ type: "command", command: "./scripts/site-validate.sh" }] }] },
    respond: (input) => validate(input),
    ledger,
  });
  const model = new MockLanguageModelV3({ doStream: async (options) => {
    calls.push(options);
    const fixing = JSON.stringify(options.prompt).includes("missing_import") && !repaired;
    const text = structured && options.responseFormat?.type === "json" ? JSON.stringify({ ready: true }) : "Work is complete";
    return { stream: convertArrayToReadableStream([
      { type: "stream-start", warnings: [] },
      ...(fixing ? [{ type: "tool-call", toolCallId: "repair-1", toolName: "edit_file", input: '{"path":"src/app.ts"}' }]
        : [{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: text }, { type: "text-end", id: "t" }]),
      { type: "finish", finishReason: { unified: fixing ? "tool-calls" : "stop", raw: undefined }, usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } } },
    ] as any[]) };
  } });
  const executor = vi.fn(async () => { repaired = true; return "Import fixed"; });
  const cleanup = vi.fn(async () => {});
  const resolveAgentTools = vi.fn(async () => ({ tools: [{ name: "edit_file", description: "Edit the project", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }], executor, cleanup }));
  const deps = {
    getConfig: () => ({ settings: {} }), getMemoryStore: () => undefined, emit: vi.fn(),
    resolveRuntimeHooks: vi.fn(async () => hooks),
    resolveAgentModel: vi.fn(async () => ({ model: { id: "mock/model", aiModel: model, provider: "mock", contextWindow: 128_000, maxTokens: 1000 } })),
    resolveAgentTools, buildRuntimePrompt: vi.fn(async () => "Build the site"),
  } as unknown as CompletionRouteDeps;
  const options = {
    deps, agentConfig: { name: "leo", model: "mock/model", maxTurns: 6 },
    aiMessages: [{ role: "user", content: "Fix my site" }], extraSystemParts: [], context: {}, stepName: "implement", runId: "same-run", sessionId: "same-session",
    ...(structured ? { outputSchema: { type: "object", properties: { ready: { type: "boolean" } }, required: ["ready"], additionalProperties: false } } : {}),
  };
  return { options, calls, validate, executor, cleanup, resolveAgentTools, hooks, model };
}

describe("Project Loop Stop hook continuation", () => {
  it.each([false, true])("repairs in the same agent conversation with authorized tools (structured=%s)", async structured => {
    const f = fixture(structured);
    const result = await runAgentStepCompletion(f.options);
    expect(f.executor).toHaveBeenCalledTimes(1);
    expect(f.resolveAgentTools).toHaveBeenCalledTimes(1);
    expect(f.cleanup).toHaveBeenCalledTimes(1);
    expect(f.validate).toHaveBeenCalledTimes(2);
    expect(f.validate.mock.calls[0]![0]).toMatchObject({ hook_event_name: "Stop", stop_hook_active: false });
    expect(f.validate.mock.calls[1]![0]).toMatchObject({ hook_event_name: "Stop", stop_hook_active: true });
    const repair = f.calls.find(call => JSON.stringify(call.prompt).includes("missing_import"));
    expect(repair.tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: "edit_file" })]));
    expect(JSON.stringify(repair.prompt)).toContain("Work is complete");
    expect(result.toolCalls).toEqual(expect.arrayContaining([expect.objectContaining({ id: "repair-1", state: "completed" })]));
    if (structured) expect(result.output).toEqual({ ready: true });
    expect(result.usage.totalTokens).toBe(f.calls.length * 15);
  });
  it("fails closed when validation asks for a repair after maxTurns", async () => {
    const f = fixture();
    f.options.agentConfig.maxTurns = 1;
    await expect(runAgentStepCompletion(f.options)).rejects.toMatchObject({ code: "termination_gate_turns_exhausted" });
    expect(f.executor).not.toHaveBeenCalled();
    expect(f.cleanup).toHaveBeenCalledTimes(1);
  });
});


describe("direct chat Stop hook continuation", () => {
  it.each([[false, false], [false, true], [true, false], [true, true]])("retains tools and history (stream=%s, structured=%s)", async (stream, structured) => {
    const f = fixture(structured);
    const resolved = await f.options.deps.resolveAgentModel(f.options.agentConfig);
    const responseFormat = structured ? { type: "json_schema" as const, json_schema: { name: "result", schema: f.options.outputSchema! } } : undefined;
    const execution: ChatCompletionExecution = {
      deps: f.options.deps, body: { agent: "leo", response_format: responseFormat as any },
      completionId: "same-run", agentConfig: f.options.agentConfig, agentMode: true,
      fullSystemPrompt: "Build the site", m: resolved.model,
      modelOutput: modelOutputForResponseFormat(responseFormat as any),
      effectiveTools: (await f.resolveAgentTools()).tools, effectiveToolExecutor: f.executor,
      clientSideTools: {}, interactionSettings: normalizeChatInteractionSettings({}),
      aiMessages: f.options.aiMessages, sessionStore: null, sessionId: null,
      runtimeHooks: { runtime: f.hooks, surface: "chat" },
    };
    const signal = new AbortController().signal;
    const chunks: any[] = [];
    if (stream) await executeStreamingChatCompletion({ write: async () => {}, writeSSE: async chunk => { chunks.push(chunk); } }, execution, signal);
    else {
      const response = await runNonStreamingChatCompletion({ req: { raw: { signal } }, json: (value: any, status = 200) => ({ value, status }) }, execution);
      expect(response.status, JSON.stringify(response)).toBe(200);
    }
    expect(f.executor).toHaveBeenCalledTimes(1);
    expect(f.validate).toHaveBeenCalledTimes(2);
    expect(f.calls.find(call => JSON.stringify(call.prompt).includes("missing_import")).tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: "edit_file" })]));
    if (stream) {
      const text = chunks.flatMap(chunk => { try { return JSON.parse(chunk.data).choices?.[0]?.delta?.content ?? []; } catch { return []; } }).join("");
      expect(text).toBe(structured ? '{"ready":true}' : "Work is complete");
      expect(chunks.at(-1).data).toBe("[DONE]");
    }
  });
});


describe("Stop continuation checkpoint recovery", () => {
  it("replays the persisted validation decision, preserving feedback and limits", async () => {
    const f = fixture(true);
    let saved: any;
    await expect(runAgentStepCompletion({ ...f.options, onCheckpoint: async state => {
      if (state.phase === "operational" && state.terminationGate.cycles === 1) throw new Error("checkpoint offline");
      saved = structuredClone(state);
    } })).rejects.toThrow("checkpoint offline");
    expect(saved.phase).toBe("validating");
    expect(f.executor).not.toHaveBeenCalled();
    const result = await runAgentStepCompletion({ ...f.options, resume: saved });
    expect(result.output).toEqual({ ready: true });
    expect(f.validate).toHaveBeenCalledTimes(2); // first rejection replayed from ledger
    expect(f.executor).toHaveBeenCalledTimes(1);
    expect(result.usage.totalTokens).toBe((f.calls.length * 15) - saved.usage.totalTokens);
  });
  it("does not replay completed tool effects or bill an accepted candidate again", async () => {
    const f = fixture();
    let saved: any;
    await runAgentStepCompletion({ ...f.options, onCheckpoint: async state => { saved = structuredClone(state); } });
    const count = f.calls.length;
    // Recovery reads an already accepted result; it does not spend a new execution budget.
    saved.terminationGate.startedAt = Date.now() - 60_000;
    const result = await runAgentStepCompletion({ ...f.options, resume: saved });
    expect(result.usage.totalTokens).toBe(0);
    expect(f.calls.length).toBe(count);
    expect(f.executor).toHaveBeenCalledTimes(1);
    expect(f.validate).toHaveBeenCalledTimes(2);
  });
  it("refuses uncertain effects and mismatched checkpoints before inference", async () => {
    const f = fixture();
    const states: any[] = [];
    await runAgentStepCompletion({ ...f.options, onCheckpoint: async state => { states.push(structuredClone(state)); } });
    const count = f.calls.length;
    for (const resume of [states.find(s => s.phase === "in_flight"), { ...states.at(-1), step: "another-node" }, { ...states.at(-1), phase: "operational" }]) {
      await expect(runAgentStepCompletion({ ...f.options, resume })).rejects.toMatchObject({ name: "TerminationGateError" });
    }
    expect(f.calls.length).toBe(count);
    expect(f.executor).toHaveBeenCalledTimes(1);
  });
  it("stops before any inference if the first durable write fails", async () => {
    const f = fixture();
    await expect(runAgentStepCompletion({ ...f.options, onCheckpoint: async () => { throw new Error("storage offline"); } })).rejects.toThrow("storage offline");
    expect(f.calls).toHaveLength(0);
    expect(f.executor).not.toHaveBeenCalled();
    expect(f.cleanup).toHaveBeenCalledTimes(1);
  });
  it("isolates concurrent conversations and validator receipts", async () => {
    const results = await Promise.all(Array.from({ length: 20 }, async (_, index) => {
      const f = fixture(index % 2 === 0);
      await runAgentStepCompletion({ ...f.options, runId: `concurrent-${index}` });
      expect(f.executor).toHaveBeenCalledTimes(1);
      expect(f.validate).toHaveBeenCalledTimes(2);
      return f.calls.length;
    }));
    expect(results).toHaveLength(20);
  });
});


describe("Managed Project Loop Stop hook adapter", () => {
  it("persists real graph checkpoints and reuses the same run tool scope during repairs", async () => {
    const f = fixture(true);
    const store = new MemoryLoopRunStore();
    const snapshots: any[] = [];
    const update = store.updateRun.bind(store);
    vi.spyOn(store, "updateRun").mockImplementation(async (id, input) => {
      if (input.resume) snapshots.push(structuredClone(input.resume));
      return update(id, input);
    });
    const scope = { id: "shared-sandbox-scope", cleanup: vi.fn(async () => {}) };
    const deps = { ...f.options.deps, getLoopRunStore: () => store, createToolRunScope: async () => scope } as CompletionRouteDeps;
    const result = await runProjectLoopCompletion({ deps, agentConfig: f.options.agentConfig,
      projectLoop: { name: "site", start: "implement", steps: { implement: { type: "agent", instructions: "Fix the site", allowedTools: ["edit_file"], output: { schema: f.options.outputSchema }, next: "end" } } } as any,
      aiMessages: f.options.aiMessages, extraSystemParts: [], sessionId: "same-session",
    });
    expect(f.executor).toHaveBeenCalledTimes(1);
    expect(f.validate).toHaveBeenCalledTimes(2);
    expect(snapshots.some(s => s.runtime?.agentStep?.phase === "validating")).toBe(true);
    expect(snapshots.some(s => s.runtime?.agentStep?.terminationGate?.cycles === 1)).toBe(true);
    for (const call of f.resolveAgentTools.mock.calls as any[]) expect(call[1]).toBe(scope);
    expect(scope.cleanup).toHaveBeenCalledTimes(1);
    const runs = await store.listRuns({});
    expect(runs[0].status).toBe("completed");
    expect(runs[0].resume).toBeUndefined();
    expect(result.text).toContain("true");
  });
});

