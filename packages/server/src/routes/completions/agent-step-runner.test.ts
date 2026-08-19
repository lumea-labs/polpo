import { describe, expect, it, vi } from "vitest";
import { jsonSchema } from "ai";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import {
  RuntimeGuardrailEngine,
  createRunPreflightPolicy,
} from "@polpo-ai/core/guardrails";
import { createToolInvocationContext } from "@polpo-ai/core";
import type { CompletionRouteDeps } from "../completions.js";
import {
  agentConfigForModelPrimary,
  buildRuntimeAgentPrompt,
  modelSelectionForAgent,
  modelSelectionForResolvedModel,
  runAgentStepCompletion,
} from "./agent-step-runner.js";

describe("buildRuntimeAgentPrompt", () => {
  it("delegates loop prompt assembly to the host when available", async () => {
    const buildRuntimePrompt = vi.fn(async () => "host loop prompt");
    const deps = {
      buildRuntimePrompt,
      buildAgentPrompt: vi.fn(() => "legacy prompt"),
    } as unknown as CompletionRouteDeps;

    const prompt = await buildRuntimeAgentPrompt(
      deps,
      { name: "agent-1" },
      ["caller context"],
      "loop context",
    );

    expect(prompt).toBe("host loop prompt");
    expect(buildRuntimePrompt).toHaveBeenCalledWith(
      { name: "agent-1" },
      {
        mode: "loop-step",
        extraSystemParts: ["caller context"],
        loopContextPart: "loop context",
        includeAgentMemory: true,
        includeSharedMemory: true,
      },
    );
    expect(deps.buildAgentPrompt).not.toHaveBeenCalled();
  });

  it("passes explicitly activated skills to loop-step prompt assembly", async () => {
    const buildRuntimePrompt = vi.fn(async () => "host loop prompt");
    const deps = {
      buildRuntimePrompt,
      buildAgentPrompt: vi.fn(() => "legacy prompt"),
    } as unknown as CompletionRouteDeps;

    await buildRuntimeAgentPrompt(
      deps,
      { name: "agent-1", skills: ["frontend-design"] },
      [],
      undefined,
      "off",
      undefined,
      ["frontend-design"],
    );

    expect(buildRuntimePrompt).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        mode: "loop-step",
        activatedSkills: ["frontend-design"],
      }),
    );
  });

  it("does not ask the host to inject legacy agent Memory when typed Memory replaces it", async () => {
    const buildRuntimePrompt = vi.fn(async () => "host loop prompt");
    const deps = {
      buildRuntimePrompt,
      buildAgentPrompt: vi.fn(() => "legacy prompt"),
    } as unknown as CompletionRouteDeps;

    await buildRuntimeAgentPrompt(
      deps,
      { name: "agent-1" },
      [],
      undefined,
      "off",
      {
        segments: [],
        legacyMemory: { agent: "replace" },
        audit: {
          resolvedAt: "2026-07-31T10:00:00.000Z",
          tokenBudget: 1_000,
          estimatedTokens: 0,
          candidateEntries: 0,
          selectedEntries: 0,
          droppedEntries: 0,
        },
      },
    );

    expect(buildRuntimePrompt).toHaveBeenCalledWith(
      { name: "agent-1" },
      {
        mode: "loop-step",
        extraSystemParts: [],
        loopContextPart: undefined,
        includeAgentMemory: false,
        includeSharedMemory: true,
      },
    );
  });

  it("does not ask the host to inject shared Memory when Brain replaces it", async () => {
    const buildRuntimePrompt = vi.fn(async () => "host loop prompt");
    const deps = {
      buildRuntimePrompt,
      buildAgentPrompt: vi.fn(() => "legacy prompt"),
    } as unknown as CompletionRouteDeps;

    await buildRuntimeAgentPrompt(
      deps,
      { name: "agent-1" },
      [],
      undefined,
      "off",
      {
        segments: [],
        legacyMemory: { shared: "replace" },
        audit: {
          resolvedAt: "2026-07-31T10:00:00.000Z",
          tokenBudget: 1_000,
          estimatedTokens: 0,
          candidateEntries: 0,
          selectedEntries: 0,
          droppedEntries: 0,
        },
      },
    );

    expect(buildRuntimePrompt).toHaveBeenCalledWith(
      { name: "agent-1" },
      {
        mode: "loop-step",
        extraSystemParts: [],
        loopContextPart: undefined,
        includeAgentMemory: true,
        includeSharedMemory: false,
      },
    );
  });
});

describe("modelSelectionForResolvedModel", () => {
  it("keeps the provider prefix on model policy selections", () => {
    expect(modelSelectionForResolvedModel({
      id: "claude-sonnet-5",
      aiModel: {} as any,
      provider: "anthropic",
      contextWindow: 200_000,
      maxTokens: 8192,
    })).toBe("anthropic/claude-sonnet-5");
  });
});

describe("agent model profile resolution", () => {
  const settings = {
    modelProfiles: {
      fast: "openai/gpt-4o-mini",
      balanced: {
        primary: "anthropic/claude-sonnet-4",
        fallbacks: [{ profile: "fast" as const }],
      },
    },
  };

  it("resolves the same concrete policy for primary adaptation and fallback execution", () => {
    const agent = {
      name: "agent-1",
      model: { profile: "balanced" },
      allowedModelProfiles: ["balanced"],
    };

    expect(agentConfigForModelPrimary(agent, settings).model).toBe(
      "anthropic/claude-sonnet-4",
    );
    expect(modelSelectionForAgent(agent, "fallback/default", settings)).toEqual({
      primary: "anthropic/claude-sonnet-4",
      fallbacks: ["openai/gpt-4o-mini"],
    });
  });

  it("preserves legacy direct model ids when profile names collide", () => {
    const collisionSettings = {
      modelProfiles: { openai: "openai/gpt-4o-mini" },
    };

    expect(modelSelectionForAgent(
      { model: "openai" },
      "fallback/default",
      collisionSettings,
    )).toBe("openai");
  });

  it("fails before provider adaptation when an agent references a disallowed profile", () => {
    expect(() => agentConfigForModelPrimary({
      model: { profile: "balanced" },
      allowedModelProfiles: ["fast"],
    }, settings)).toThrowError(expect.objectContaining({
      code: "DISALLOWED_PROFILE",
      profile: "balanced",
    }));
  });
});

describe("runAgentStepCompletion tool validation", () => {
  it("rejects a forced client interaction tool before nested model execution", async () => {
    const deps = {
      getConfig: () => ({ settings: {} }),
      getMemoryStore: () => undefined,
      emit: vi.fn(),
      resolveAgentModel: vi.fn(async () => ({
        model: {
          id: "mock/model",
          aiModel: {},
          provider: "mock",
          contextWindow: 128_000,
          maxTokens: 8192,
        },
      })),
      resolveAgentTools: vi.fn(async () => ({
        tools: [],
        extraAiTools: {},
        executor: vi.fn(),
      })),
      buildRuntimePrompt: vi.fn(async () => "system"),
    } as unknown as CompletionRouteDeps;

    await expect(runAgentStepCompletion({
      deps,
      agentConfig: {
        name: "nested-agent",
        model: "mock/model",
        toolChoice: { mode: "required", tool: "ask_user_question" },
      },
      aiMessages: [{ role: "user", content: "Complete the step" }],
      extraSystemParts: [],
      context: {},
      stepName: "implement",
    })).rejects.toMatchObject({
      name: "LoopInteractiveToolUnsupportedError",
      code: "loop_interactive_tool_not_supported",
      tool: "ask_user_question",
      stepName: "implement",
    });
  });

  it("never exposes client interaction tools inside nested loop agent steps", async () => {
    const visibleTools: string[] = [];
    const model = new MockLanguageModelV3({
      doStream: async (options) => {
        visibleTools.push(...(options.tools ?? []).map((tool) => tool.name));
        return { stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "text" },
          { type: "text-delta", id: "text", delta: "done" },
          { type: "text-end", id: "text" },
          {
            type: "finish",
            finishReason: { unified: "stop", raw: undefined },
            usage: {
              inputTokens: { total: 1 },
              outputTokens: { total: 1 },
            },
          },
        ] as any[]) };
      },
    });
    const deps = {
      getConfig: () => ({ settings: {} }),
      getMemoryStore: () => undefined,
      emit: vi.fn(),
      resolveAgentModel: vi.fn(async () => ({
        model: {
          id: "mock/model",
          aiModel: model,
          provider: "mock",
          contextWindow: 128_000,
          maxTokens: 8192,
        },
      })),
      resolveAgentTools: vi.fn(async () => ({
        tools: [
          {
            name: "ask_user_question",
            parameters: { type: "object", properties: {} },
          },
          {
            name: "read",
            parameters: { type: "object", properties: {} },
          },
        ],
        extraAiTools: {
          ask_user_question: {
            inputSchema: jsonSchema({ type: "object", properties: {} }),
          },
          provider_search: {
            inputSchema: jsonSchema({ type: "object", properties: {} }),
          },
        },
        executor: vi.fn(async () => "unused"),
      })),
      buildRuntimePrompt: vi.fn(async () => "system"),
    } as unknown as CompletionRouteDeps;

    const result = await runAgentStepCompletion({
      deps,
      agentConfig: { name: "nested-agent", model: "mock/model" },
      aiMessages: [{ role: "user", content: "Complete the step" }],
      extraSystemParts: [],
      context: {},
      stepName: "implement",
    });

    expect(result.text).toBe("done");
    expect(visibleTools).toContain("read");
    expect(visibleTools).toContain("provider_search");
    expect(visibleTools).not.toContain("ask_user_question");
  });

  it("loads a tool explicitly before exposing and directly executing it in a nested agent step", async () => {
    const usage = {
      inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 5, text: undefined, reasoning: undefined },
    };
    const visibleByTurn: string[][] = [];
    let turn = 0;
    const model = new MockLanguageModelV3({
      doStream: async (options) => {
        visibleByTurn.push((options.tools ?? []).map((tool) => tool.name));
        turn += 1;
        if (turn === 1) {
          return { stream: convertArrayToReadableStream([
            { type: "stream-start", warnings: [] },
            { type: "tool-call", toolCallId: "load_nested", toolName: "polpo_tool_load", input: JSON.stringify({ names: ["calculate"] }) },
            { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
          ] as any[]) };
        }
        if (turn === 2) {
          return { stream: convertArrayToReadableStream([
            { type: "stream-start", warnings: [] },
            { type: "tool-call", toolCallId: "calculate_nested", toolName: "calculate", input: JSON.stringify({ value: 4 }) },
            { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
          ] as any[]) };
        }
        return { stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "nested_text" },
          { type: "text-delta", id: "nested_text", delta: "8" },
          { type: "text-end", id: "nested_text" },
          { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
        ] as any[]) };
      },
    });
    const executor = vi.fn(async (_name: string, args: Record<string, unknown>) => String(Number(args.value) * 2));
    const deps = {
      getConfig: () => ({ settings: {} }),
      getMemoryStore: () => undefined,
      emit: vi.fn(),
      resolveAgentModel: vi.fn(async () => ({
        model: {
          id: "mock/model",
          aiModel: model,
          provider: "mock",
          contextWindow: 128_000,
          maxTokens: 8192,
        },
      })),
      resolveAgentTools: vi.fn(async () => ({
        tools: [{
          name: "calculate",
          description: "Double a number",
          parameters: {
            type: "object",
            properties: { value: { type: "number" } },
            required: ["value"],
          },
        }],
        executor,
        disclosure: { mode: "model-controlled" as const },
      })),
      buildRuntimePrompt: vi.fn(async () => "system"),
    } as unknown as CompletionRouteDeps;

    const toolInvocation = createToolInvocationContext({
      requestId: "request-nested",
      runId: "run-nested",
      sessionId: "session-nested",
      surface: "loop",
      user: "user-nested",
      metadata: { tenantId: "tenant-nested" },
    });
    const result = await runAgentStepCompletion({
      deps,
      agentConfig: { name: "nested-agent", model: "mock/model", maxTurns: 3 },
      aiMessages: [{ role: "user", content: "Double 4" }],
      extraSystemParts: [],
      context: {},
      stepName: "nested",
      toolInvocation,
    });

    expect(result.text).toBe("8");
    expect(visibleByTurn[0]).not.toContain("calculate");
    expect(visibleByTurn[1]).toContain("calculate");
    expect(executor).toHaveBeenCalledOnce();
    expect(executor).toHaveBeenCalledWith(
      "calculate",
      { value: 4 },
      expect.objectContaining({ callId: "calculate_nested" }),
    );
    expect(deps.resolveAgentTools).toHaveBeenCalledWith(
      expect.objectContaining({ name: "nested-agent" }),
      undefined,
      toolInvocation,
    );
  });

  it("runs model preflight before resolving a loop-step model or tools", async () => {
    const resolveAgentModel = vi.fn();
    const resolveAgentTools = vi.fn();
    const deps = {
      getConfig: () => ({ settings: {} }),
      getMemoryStore: () => undefined,
      emit: vi.fn(),
      resolveAgentModel,
      resolveAgentTools,
      buildRuntimePrompt: vi.fn(async () => "loop system prompt"),
      runPreflightPolicy: createRunPreflightPolicy(
        new RuntimeGuardrailEngine([{
          id: "loop.preflight",
          phases: ["model.preflight"],
          evaluate: () => ({
            action: "block",
            risk: "high",
            reason: "blocked loop model input",
          }),
        }]),
      ),
    } as unknown as CompletionRouteDeps;

    await expect(runAgentStepCompletion({
      deps,
      agentConfig: { name: "test-agent", model: "mock" },
      aiMessages: [{ role: "user", content: "unsafe" }],
      extraSystemParts: [],
      context: {},
      stepName: "review",
    })).rejects.toMatchObject({
      code: "guardrail_blocked",
    });
    expect(resolveAgentModel).not.toHaveBeenCalled();
    expect(resolveAgentTools).not.toHaveBeenCalled();
  });

  it("never dispatches a tool call rejected by the original input schema", async () => {
    const usage = {
      inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 5, text: undefined, reasoning: undefined },
    };
    const model = new MockLanguageModelV3({
      doStream: {
        stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          {
            type: "tool-call",
            toolCallId: "call_invalid",
            toolName: "calculate",
            input: JSON.stringify({ target: 999 }),
          },
          {
            type: "finish",
            finishReason: { unified: "tool-calls", raw: undefined },
            usage,
          },
        ] as any[]),
      },
    });
    const executor = vi.fn(async () => "must not execute");
    const onToolCall = vi.fn();
    const deps = {
      getConfig: () => ({ settings: {} }),
      getMemoryStore: () => undefined,
      emit: vi.fn(),
      resolveAgentModel: vi.fn(async () => ({
        model: {
          id: "xai/grok-4.1-fast-non-reasoning",
          aiModel: model,
          provider: "xai",
          contextWindow: 128_000,
          maxTokens: 8192,
        },
      })),
      resolveAgentTools: vi.fn(async () => ({
        tools: [{
          name: "calculate",
          parameters: {
            type: "object",
            properties: {
              target: { type: "number", minimum: 1000 },
            },
            required: ["target"],
          },
        }],
        executor,
      })),
      buildRuntimePrompt: vi.fn(async () => "system"),
    } as unknown as CompletionRouteDeps;

    const result = await runAgentStepCompletion({
      deps,
      agentConfig: {
        name: "test-agent",
        model: "xai/grok-4.1-fast-non-reasoning",
        maxTurns: 1,
      },
      aiMessages: [{ role: "user", content: "Calculate." }],
      extraSystemParts: [],
      context: {},
      stepName: "test",
      onToolCall,
    });

    expect(executor).not.toHaveBeenCalled();
    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        id: "call_invalid",
        name: "calculate",
        state: "error",
        result: expect.stringContaining("Invalid tool arguments"),
      }),
    ]);
    expect(onToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "call_invalid",
        state: "error",
      }),
    );
  });
});
