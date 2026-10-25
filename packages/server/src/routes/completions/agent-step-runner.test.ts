import { describe, expect, it, vi } from "vitest";
import { jsonSchema } from "ai";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import {
  RuntimeGuardrailEngine,
  createRunPreflightPolicy,
} from "@polpo-ai/core/guardrails";
import { createToolInvocationContext, prepareLoopAgentInput } from "@polpo-ai/core";
import { createScriptedHookRuntime } from "@polpo-ai/core/runtime-hooks";
import { InMemorySteeringController } from "@polpo-ai/core/steering";
import type { CompletionRouteDeps } from "../completions.js";
import {
  agentConfigForModelPrimary,
  buildRuntimeAgentPrompt,
  modelSelectionForAgent,
  modelSelectionForResolvedModel,
  runAgentStepCompletion,
} from "./agent-step-runner.js";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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

describe("runAgentStepCompletion steering", () => {
  it("delivers steering accepted during a model turn at the next safe boundary", async () => {
    const usage = {
      inputTokens: { total: 2, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 1, text: undefined, reasoning: undefined },
    };
    let turn = 0;
    let releaseFirstTurn!: () => void;
    let markFirstTurnStarted!: () => void;
    const firstTurnStarted = new Promise<void>((resolve) => { markFirstTurnStarted = resolve; });
    const firstTurnGate = new Promise<void>((resolve) => { releaseFirstTurn = resolve; });
    let secondPrompt = "";
    const model = new MockLanguageModelV3({
      doStream: async (options) => {
        turn += 1;
        if (turn === 1) {
          markFirstTurnStarted();
          await firstTurnGate;
        } else {
          secondPrompt = JSON.stringify(options.prompt);
        }
        const text = turn === 1 ? "draft" : "updated";
        return { stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: `text-${turn}` },
          { type: "text-delta", id: `text-${turn}`, delta: text },
          { type: "text-end", id: `text-${turn}` },
          { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
        ] as any[]) };
      },
    });
    const deps = {
      getConfig: () => ({ settings: {} }),
      getMemoryStore: () => undefined,
      emit: vi.fn(),
      buildAgentPrompt: () => "You are a test agent.",
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
        tools: [],
        executor: async () => "ok",
      })),
    } as unknown as CompletionRouteDeps;
    const steering = new InMemorySteeringController();

    const pending = runAgentStepCompletion({
      deps,
      agentConfig: { name: "builder", model: "mock", maxTurns: 2 },
      aiMessages: [{ role: "user", content: "Build the page" }],
      extraSystemParts: [],
      context: {},
      stepName: "implement",
      steering,
      steeringPolicy: { acceptance: "best_effort", source: "node" },
    });
    await firstTurnStarted;
    const admission = await steering.enqueue({
      id: "steer-title",
      mode: "steer",
      content: { text: "Change the title to Acme" },
    });
    releaseFirstTurn();

    const result = await pending;

    expect(admission.receipt.admission).toBe("accepted");
    expect(secondPrompt).toContain("Change the title to Acme");
    expect(result.text).toBe("draftupdated");
    expect(steering.getReceipt("steer-title")).toMatchObject({
      admission: "accepted",
      delivery: "delivered",
      policySource: "node",
    });
  });
});

describe("runAgentStepCompletion parallel tool calls", () => {
  it("executes read-only calls concurrently and appends ordered history", async () => {
    const usage = {
      inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 5, text: undefined, reasoning: undefined },
    };
    let turn = 0;
    let active = 0;
    let maxActive = 0;
    let secondPrompt = "";
    const model = new MockLanguageModelV3({
      doStream: async (options) => {
        turn += 1;
        if (turn === 1) {
          return { stream: convertArrayToReadableStream([
            { type: "stream-start", warnings: [] },
            { type: "tool-call", toolCallId: "slow", toolName: "read_slow", input: "{}" },
            { type: "tool-call", toolCallId: "fast", toolName: "list_fast", input: "{}" },
            { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
          ] as any[]) };
        }
        secondPrompt = JSON.stringify(options.prompt);
        return { stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "txt" },
          { type: "text-delta", id: "txt", delta: "done" },
          { type: "text-end", id: "txt" },
          { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
        ] as any[]) };
      },
    });
    const executor = vi.fn(async (name: string) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(name === "read_slow" ? 15 : 2);
      active -= 1;
      return `${name}:done`;
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
        tools: ["read_slow", "list_fast"].map((name) => ({
          name,
          description: name,
          parameters: { type: "object", properties: {} },
        })),
        executor,
      })),
      buildRuntimePrompt: vi.fn(async () => "system"),
    } as unknown as CompletionRouteDeps;

    const result = await runAgentStepCompletion({
      deps,
      agentConfig: { name: "nested-agent", model: "mock/model", maxTurns: 2 },
      aiMessages: [{ role: "user", content: "Inspect both resources" }],
      extraSystemParts: [],
      context: {},
      stepName: "inspect",
      parallelToolCalls: true,
    });

    expect(result.text).toBe("done");
    expect(maxActive).toBe(2);
    expect(secondPrompt.indexOf("read_slow:done"))
      .toBeLessThan(secondPrompt.indexOf("list_fast:done"));
  });

  it("returns a real custom-tool failure to the model so the agent can recover", async () => {
    const usage = {
      inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 5, text: undefined, reasoning: undefined },
    };
    let turn = 0;
    let recoveryPrompt = "";
    const model = new MockLanguageModelV3({
      doStream: async (options) => {
        turn += 1;
        if (turn === 1) {
          return { stream: convertArrayToReadableStream([
            { type: "stream-start", warnings: [] },
            {
              type: "tool-call",
              toolCallId: "site-platform-1",
              toolName: "site_platform",
              input: JSON.stringify({ action: "inspect" }),
            },
            { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
          ] as any[]) };
        }
        recoveryPrompt = JSON.stringify(options.prompt);
        return { stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "txt" },
          { type: "text-delta", id: "txt", delta: "I will use the available project tools instead." },
          { type: "text-end", id: "txt" },
          { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
        ] as any[]) };
      },
    });
    const executor = vi.fn(async () => {
      throw new Error("Custom tool failed: site_platform_agent_tool_unavailable");
    });
    const onToolCall = vi.fn();
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
          name: "site_platform",
          description: "Inspect the site platform",
          parameters: { type: "object", properties: { action: { type: "string" } } },
        }],
        executor,
      })),
      buildRuntimePrompt: vi.fn(async () => "system"),
    } as unknown as CompletionRouteDeps;

    const result = await runAgentStepCompletion({
      deps,
      agentConfig: { name: "nested-agent", model: "mock/model", maxTurns: 2 },
      aiMessages: [{ role: "user", content: "Inspect the site" }],
      extraSystemParts: [],
      context: {},
      stepName: "implement",
      onToolCall,
    });

    expect(result.text).toBe("I will use the available project tools instead.");
    expect(recoveryPrompt).toContain("Error: Custom tool failed: site_platform_agent_tool_unavailable");
    expect(onToolCall).toHaveBeenCalledWith(expect.objectContaining({
      id: "site-platform-1",
      name: "site_platform",
      state: "error",
      result: "Error: Custom tool failed: site_platform_agent_tool_unavailable",
    }));
  });
});

describe("runAgentStepCompletion runtime hook parity", () => {
  it("applies tool:before inside a Loop agent node before the tool side effect", async () => {
    const usage = {
      inputTokens: { total: 10 },
      outputTokens: { total: 5 },
    };
    let turn = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        turn += 1;
        if (turn === 1) {
          return { stream: convertArrayToReadableStream([
            { type: "stream-start", warnings: [] },
            { type: "tool-call", toolCallId: "write-1", toolName: "write_file", input: JSON.stringify({ path: "forbidden" }) },
            { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
          ] as any[]) };
        }
        return { stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "text" },
          { type: "text-delta", id: "text", delta: "blocked safely" },
          { type: "text-end", id: "text" },
          { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
        ] as any[]) };
      },
    });
    const executor = vi.fn(async () => "side effect happened");
    const hookInputs: Record<string, any>[] = [];
    const hooks = createScriptedHookRuntime({
      hooks: { PreToolUse: [{ matcher: "write_file", hooks: [{ type: "command", command: "policy-check" }] }] },
      respond: (input) => {
        hookInputs.push(input);
        return { exitCode: 2, stderr: "protected path" };
      },
    });
    const deps = {
      getConfig: () => ({ settings: {} }),
      getMemoryStore: () => undefined,
      emit: vi.fn(),
      resolveRuntimeHooks: vi.fn(async () => hooks),
      resolveAgentModel: vi.fn(async () => ({
        model: { id: "mock/model", aiModel: model, provider: "mock", contextWindow: 128_000, maxTokens: 8192 },
      })),
      resolveAgentTools: vi.fn(async () => ({
        tools: [{ name: "write_file", description: "write", parameters: { type: "object", properties: { path: { type: "string" } } } }],
        executor,
      })),
      buildRuntimePrompt: vi.fn(async () => "system"),
    } as unknown as CompletionRouteDeps;

    const result = await runAgentStepCompletion({
      deps,
      agentConfig: { name: "nested-agent", model: "mock/model" },
      aiMessages: [{ role: "user", content: "Write the file" }],
      extraSystemParts: [],
      context: {},
      stepName: "implement",
    });

    expect(result.text).toBe("blocked safely");
    expect(executor).not.toHaveBeenCalled();
    expect(hookInputs).toEqual([expect.objectContaining({
      hook_event_name: "PreToolUse",
      tool_name: "write_file",
      tool_input: { path: "forbidden" },
      tool_use_id: "write-1",
    })]);
    expect(deps.resolveRuntimeHooks).toHaveBeenCalledWith(expect.objectContaining({ surface: "loop", step: "implement" }));
  });

  it("continues the same agent when a Stop hook blocks, replacing the candidate", async () => {
    const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } };
    let modelTurn = 0;
    const prompts: unknown[] = [];
    const model = new MockLanguageModelV3({
      doStream: async (options) => {
        prompts.push(options.prompt);
        modelTurn += 1;
        const text = modelTurn === 1 ? "draft" : "corrected";
        return { stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "text" },
          { type: "text-delta", id: "text", delta: text },
          { type: "text-end", id: "text" },
          { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
        ] as any[]) };
      },
    });
    let stopCalls = 0;
    const hooks = createScriptedHookRuntime({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "review" }] }] },
      respond: () => {
        stopCalls += 1;
        return stopCalls === 1 ? { exitCode: 2, stderr: "Mention the verified result" } : { exitCode: 0 };
      },
    });
    const executor = vi.fn();
    const deps = {
      getConfig: () => ({ settings: {} }), getMemoryStore: () => undefined, emit: vi.fn(),
      resolveRuntimeHooks: vi.fn(async () => hooks),
      resolveAgentModel: vi.fn(async () => ({
        model: { id: "mock/model", aiModel: model, provider: "mock", contextWindow: 128_000, maxTokens: 8192 },
      })),
      resolveAgentTools: vi.fn(async () => ({ tools: [], executor })),
      buildRuntimePrompt: vi.fn(async () => "system"),
    } as unknown as CompletionRouteDeps;

    const result = await runAgentStepCompletion({
      deps, agentConfig: { name: "reviewer", model: "mock/model" },
      aiMessages: [{ role: "user", content: "Answer" }], extraSystemParts: [], context: {}, stepName: "review",
    });

    expect(result.text).toBe("corrected");
    expect(modelTurn).toBe(2);
    expect(executor).not.toHaveBeenCalled();
    expect(JSON.stringify(prompts[1])).toContain("Mention the verified result");
    expect(stopCalls).toBe(2);
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
  it("creates an internal instruction when deterministic context is the only agent-step input", async () => {
    const observedPrompts: unknown[][] = [];
    const model = new MockLanguageModelV3({
      doStream: async (options) => {
        observedPrompts.push(options.prompt);
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
        tools: [],
        extraAiTools: {},
        executor: vi.fn(),
      })),
      buildRuntimePrompt: vi.fn(async () => "system"),
    } as unknown as CompletionRouteDeps;

    const result = await runAgentStepCompletion({
      deps,
      agentConfig: { name: "nested-agent", model: "mock/model" },
      aiMessages: [],
      extraSystemParts: [],
      context: {
        site_context: {
          output: { operation: { summary: "Add WhatsApp" } },
        },
      },
      stepName: "implement",
    });

    expect(result.text).toBe("done");
    expect(observedPrompts).toHaveLength(1);
    expect(observedPrompts[0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user" }),
    ]));
  });

  it("uses projected input as the only user payload and excludes conversation and shared context", async () => {
    const observedPrompts: unknown[][] = [];
    const model = new MockLanguageModelV3({
      doStream: async (options) => {
        observedPrompts.push(options.prompt);
        return { stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "text" },
          { type: "text-delta", id: "text", delta: "repaired" },
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
    const buildRuntimePrompt = vi.fn(async () => "step system prompt");
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
        tools: [],
        extraAiTools: {},
        executor: vi.fn(),
      })),
      buildRuntimePrompt,
    } as unknown as CompletionRouteDeps;

    const context = {
      validation: { failures: [{ message: "fix-this-exactly" }] },
      creativeBrief: "must-not-reach-model",
    };
    const projectedInput = prepareLoopAgentInput(
      {
        failures: { $context: "validation.failures" },
        attempt: 1,
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["failures", "attempt"],
        properties: {
          failures: { type: "array", minItems: 1 },
          attempt: { type: "integer", minimum: 1 },
        },
      },
      context,
    );

    await runAgentStepCompletion({
      deps,
      agentConfig: { name: "repair-agent", model: "mock/model" },
      aiMessages: [{ role: "user", content: "redesign everything creatively" }],
      extraSystemParts: ["caller creative system context"],
      context,
      stepName: "repair",
      projectedInput,
    });

    expect(buildRuntimePrompt).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        extraSystemParts: [],
        loopContextPart: "",
        includeAgentMemory: false,
        includeSharedMemory: false,
      }),
    );
    const prompt = JSON.stringify(observedPrompts[0]);
    expect(prompt).toContain("fix-this-exactly");
    expect(prompt).toContain('\\"attempt\\":1');
    expect(prompt).not.toContain("redesign everything creatively");
    expect(prompt).not.toContain("must-not-reach-model");
    expect(prompt).not.toContain("caller creative system context");
  });

  it("fails before provider invocation when an agent step has neither messages nor context", async () => {
    const doStream = vi.fn();
    const model = new MockLanguageModelV3({ doStream });
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
        tools: [],
        extraAiTools: {},
        executor: vi.fn(),
      })),
      buildRuntimePrompt: vi.fn(async () => "system"),
    } as unknown as CompletionRouteDeps;

    await expect(runAgentStepCompletion({
      deps,
      agentConfig: { name: "nested-agent", model: "mock/model" },
      aiMessages: [],
      extraSystemParts: [],
      context: {},
      stepName: "implement",
    })).rejects.toMatchObject({
      name: "LoopAgentStepPromptRequiredError",
      code: "loop_agent_step_prompt_required",
      stepName: "implement",
    });
    expect(doStream).not.toHaveBeenCalled();
  });

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

    const controller = new AbortController();
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
      signal: controller.signal,
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
      controller.signal,
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
    const batches: Record<string, any>[] = [];
    const hooks = createScriptedHookRuntime({
      hooks: { PostToolBatch: [{ hooks: [{ type: "command", command: "audit" }] }] },
      respond: (input) => { batches.push(input); return {}; },
    });
    const deps = {
      getConfig: () => ({ settings: {} }),
      getMemoryStore: () => undefined,
      emit: vi.fn(),
      resolveRuntimeHooks: vi.fn(async () => hooks),
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
    // A rejected call still resolved, with its error, in the batch (reference behavior).
    expect(batches).toEqual([expect.objectContaining({
      hook_event_name: "PostToolBatch",
      tool_calls: [expect.objectContaining({ tool_name: "calculate", tool_use_id: "call_invalid" })],
    })]);
  });
});

describe("runAgentStepCompletion structured loop output", () => {
  const usage = {
    inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 5, text: undefined, reasoning: undefined },
  };
  const outputSchema = {
    type: "object",
    additionalProperties: false,
    required: ["summary", "response"],
    properties: {
      summary: { type: "string" },
      response: { type: "string" },
    },
  };

  function structuredStepDeps(
    finalText: string,
    maxTurns = 2,
    recoveryText = finalText,
  ) {
    let operationalTurn = 0;
    let terminalAttempt = 0;
    const responseFormats: unknown[] = [];
    const toolCounts: number[] = [];
    const prompts: unknown[] = [];
    const executeTool = vi.fn(async () => "inspection complete");
    const model = new MockLanguageModelV3({
      doStream: async (options) => {
        responseFormats.push(options.responseFormat);
        toolCounts.push(options.tools?.length ?? 0);
        prompts.push(options.prompt);
        if (!options.responseFormat) {
          operationalTurn += 1;
        }
        if (!options.responseFormat && operationalTurn === 1) {
          return { stream: convertArrayToReadableStream([
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "preface" },
            { type: "text-delta", id: "preface", delta: "I will inspect first." },
            { type: "text-end", id: "preface" },
            { type: "tool-call", toolCallId: "inspect_1", toolName: "inspect", input: "{}" },
            { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
          ] as any[]) };
        }
        if (!options.responseFormat) {
          return { stream: convertArrayToReadableStream([
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "operational-complete" },
            { type: "text-delta", id: "operational-complete", delta: "Operational work complete." },
            { type: "text-end", id: "operational-complete" },
            { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
          ] as any[]) };
        }
        terminalAttempt += 1;
        const terminalText = terminalAttempt === 1 ? finalText : recoveryText;
        return { stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "final" },
          { type: "text-delta", id: "final", delta: terminalText },
          { type: "text-end", id: "final" },
          { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
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
        tools: [{
          name: "inspect",
          description: "Inspect the workspace",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        }],
        executor: executeTool,
      })),
      buildRuntimePrompt: vi.fn(async () => "system"),
    } as unknown as CompletionRouteDeps;

    return { deps, executeTool, maxTurns, responseFormats, toolCounts, prompts };
  }

  it("enforces the schema on the terminal turn after tool use", async () => {
    const fixture = structuredStepDeps('{"summary":"implemented","response":"ready"}');

    const result = await runAgentStepCompletion({
      deps: fixture.deps,
      agentConfig: { name: "nested-agent", model: "mock/model", maxTurns: fixture.maxTurns },
      aiMessages: [{ role: "user", content: "Implement it" }],
      extraSystemParts: [],
      context: {},
      stepName: "implement",
      outputSchema,
    });

    expect(fixture.responseFormats).toEqual([
      undefined,
      undefined,
      expect.objectContaining({ type: "json" }),
    ]);
    expect(fixture.toolCounts).toEqual([1, 1, 0]);
    expect((fixture.prompts[2] as Array<{ role?: string }>).at(-1)?.role).toBe("user");
    expect(result.output).toEqual({ summary: "implemented", response: "ready" });
    expect(result.text).toBe('{"summary":"implemented","response":"ready"}');
  });

  it("prevents the production implement-step failure when Cloud defaults Anthropic Gateway thinking", async () => {
    let operationalTurn = 0;
    const calls: Array<{
      responseFormat: unknown;
      providerOptions: Record<string, any> | undefined;
      prompt: unknown;
    }> = [];
    const executeTool = vi.fn(async () => "implementation complete");
    const model = new MockLanguageModelV3({
      doStream: async (options) => {
        const providerOptions = options.providerOptions as Record<string, any> | undefined;
        calls.push({ responseFormat: options.responseFormat, providerOptions, prompt: options.prompt });
        if (
          options.responseFormat
          && (options.prompt as Array<{ role?: string }>).at(-1)?.role === "assistant"
        ) {
          throw new Error(
            "Your API request included an assistant message in the final position, which would pre-fill the assistant response. When using output format, pre-filling the assistant response is not supported.",
          );
        }
        if (!options.responseFormat) operationalTurn += 1;
        if (!options.responseFormat && operationalTurn === 1) {
          return { stream: convertArrayToReadableStream([
            { type: "stream-start", warnings: [] },
            { type: "reasoning-start", id: "reasoning" },
            { type: "reasoning-delta", id: "reasoning", delta: "Inspect and implement." },
            { type: "reasoning-end", id: "reasoning" },
            { type: "tool-call", toolCallId: "implement_1", toolName: "implement_change", input: "{}" },
            { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
          ] as any[]) };
        }
        const text = options.responseFormat
          ? '{"summary":"implemented","response":"ready"}'
          : "Implementation complete.";
        return { stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "text" },
          { type: "text-delta", id: "text", delta: text },
          { type: "text-end", id: "text" },
          { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
        ] as any[]) };
      },
    });
    const reasoningProviderOptions = {
      anthropic: {
        structuredOutputMode: "auto",
        thinking: { type: "enabled", budgetTokens: 4096 },
        effort: "medium",
      },
    };
    const resolved = {
      model: {
        id: "claude-haiku-4.5",
        aiModel: model,
        provider: "anthropic",
        runtimeMode: "gateway" as const,
        contextWindow: 200_000,
        maxTokens: 8192,
      },
      providerOptions: reasoningProviderOptions,
    };
    const deps = {
      getConfig: () => ({ settings: {} }),
      getMemoryStore: () => undefined,
      emit: vi.fn(),
      resolveAgentModel: vi.fn(async () => resolved),
      resolveAgentTools: vi.fn(async () => ({
        tools: [{
          name: "implement_change",
          description: "Apply the requested implementation",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        }],
        executor: executeTool,
      })),
      buildRuntimePrompt: vi.fn(async () => "system"),
    } as unknown as CompletionRouteDeps;

    const result = await runAgentStepCompletion({
      deps,
      agentConfig: {
        name: "implement-agent",
        model: "anthropic/claude-haiku-4.5",
        maxTurns: 2,
      },
      aiMessages: [{ role: "user", content: "Implement it" }],
      extraSystemParts: [],
      context: {},
      stepName: "implement",
      outputSchema,
    });

    expect(result.output).toEqual({ summary: "implemented", response: "ready" });
    expect(executeTool).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(3);
    expect(calls.slice(0, 2).every((call) => call.providerOptions?.anthropic?.thinking)).toBe(true);
    expect(calls[2]).toMatchObject({
      responseFormat: { type: "json" },
      providerOptions: reasoningProviderOptions,
    });
    const terminalPrompt = calls[2]?.prompt as Array<{
      role?: string;
      content?: Array<{ type?: string; text?: string }>;
    }>;
    expect(terminalPrompt.at(-1)?.role).toBe("user");
    expect(terminalPrompt.at(-1)?.content?.[0]?.text).toContain("Operational work is complete");
    expect(deps.emit).not.toHaveBeenCalledWith(
      "runtime:structured-output-recovery",
      expect.objectContaining({ phase: "failed", step: "implement" }),
    );
  });

  it("rejects markdown instead of completing the structured step", async () => {
    const fixture = structuredStepDeps("**summary:** implemented\n**response:** ready");

    await expect(runAgentStepCompletion({
      deps: fixture.deps,
      agentConfig: { name: "nested-agent", model: "mock/model", maxTurns: fixture.maxTurns },
      aiMessages: [{ role: "user", content: "Implement it" }],
      extraSystemParts: [],
      context: {},
      stepName: "implement",
      outputSchema,
    })).rejects.toMatchObject({
      code: "loop_agent_output_invalid",
      stepName: "implement",
    });
  });

  it("recovers only the terminal structured output without re-executing completed tools", async () => {
    const fixture = structuredStepDeps(
      "I completed the implementation.",
      2,
      '{"summary":"implemented","response":"ready"}',
    );

    const result = await runAgentStepCompletion({
      deps: fixture.deps,
      agentConfig: { name: "nested-agent", model: "mock/model", maxTurns: fixture.maxTurns },
      aiMessages: [{ role: "user", content: "Implement it" }],
      extraSystemParts: [],
      context: {},
      stepName: "implement",
      outputSchema,
    });

    expect(result.output).toEqual({ summary: "implemented", response: "ready" });
    expect(result.text).toBe('{"summary":"implemented","response":"ready"}');
    expect(fixture.responseFormats).toHaveLength(4);
    expect(fixture.responseFormats.slice(0, 2)).toEqual([undefined, undefined]);
    expect(fixture.toolCounts).toEqual([1, 1, 0, 0]);
    expect(fixture.deps.resolveAgentTools).toHaveBeenCalledTimes(1);
    expect(fixture.executeTool).toHaveBeenCalledTimes(1);
    expect(fixture.deps.emit).toHaveBeenCalledWith(
      "runtime:structured-output-recovery",
      expect.objectContaining({ phase: "succeeded", step: "implement" }),
    );
  });

  it("fails closed when the bounded terminal structured-output recovery is also invalid", async () => {
    const fixture = structuredStepDeps(
      "I completed the implementation.",
      2,
      "Still not JSON.",
    );

    await expect(runAgentStepCompletion({
      deps: fixture.deps,
      agentConfig: { name: "nested-agent", model: "mock/model", maxTurns: fixture.maxTurns },
      aiMessages: [{ role: "user", content: "Implement it" }],
      extraSystemParts: [],
      context: {},
      stepName: "implement",
      outputSchema,
    })).rejects.toMatchObject({
      code: "loop_agent_output_invalid",
      stepName: "implement",
      details: expect.objectContaining({ phase: "terminal_output_recovery" }),
    });

    expect(fixture.executeTool).toHaveBeenCalledTimes(1);
    expect(fixture.responseFormats).toHaveLength(4);
    expect(fixture.responseFormats.slice(0, 2)).toEqual([undefined, undefined]);
    expect(fixture.toolCounts).toEqual([1, 1, 0, 0]);
    expect(fixture.deps.emit).toHaveBeenCalledWith(
      "runtime:structured-output-recovery",
      expect.objectContaining({ phase: "failed", step: "implement" }),
    );
  });

  it("uses a no-tool terminal turn after maxTurns when completed tool evidence exists", async () => {
    const fixture = structuredStepDeps('{"summary":"unused","response":"unused"}', 1);

    const result = await runAgentStepCompletion({
      deps: fixture.deps,
      agentConfig: { name: "nested-agent", model: "mock/model", maxTurns: fixture.maxTurns },
      aiMessages: [{ role: "user", content: "Implement it" }],
      extraSystemParts: [],
      context: {},
      stepName: "implement",
      outputSchema,
    });

    expect(result.output).toEqual({ summary: "unused", response: "unused" });
    expect(fixture.responseFormats).toEqual([
      undefined,
      expect.objectContaining({ type: "json" }),
    ]);
    expect(fixture.toolCounts).toEqual([1, 0]);
  });
});
