import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import {
  RuntimeGuardrailEngine,
  createRunPreflightPolicy,
} from "@polpo-ai/core/guardrails";
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
      },
    );
    expect(deps.buildAgentPrompt).not.toHaveBeenCalled();
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
