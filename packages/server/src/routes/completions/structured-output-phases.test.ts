import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import { normalizeChatInteractionSettings } from "@polpo-ai/core/chat-interactions";

import type { CompletionRouteDeps } from "../completions.js";
import {
  executeStreamingChatCompletion,
  runNonStreamingChatCompletion,
  type ChatCompletionExecution,
} from "./chat-handler.js";
import { modelOutputForResponseFormat } from "./structured-output.js";
import {
  createGuardedCompletionToolExecutor,
  type CompletionToolProgressState,
} from "./tool-guardrails.js";

const responseFormat = {
  type: "json_schema" as const,
  json_schema: {
    name: "answer",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["answer"],
      properties: { answer: { type: "string" } },
    },
  },
};

// Exact schema used by the production Haiku release smoke.
const productionHaikuResponseFormat = {
  type: "json_schema" as const,
  json_schema: {
    name: "release_status",
    strict: true,
    schema: {
      type: "object",
      properties: { status: { type: "string", enum: ["ready"] } },
      required: ["status"],
      additionalProperties: false,
    },
  },
};

function fixture() {
  let operationalTurn = 0;
  const responseFormats: unknown[] = [];
  const toolCounts: number[] = [];
  const providerOptions: unknown[] = [];
  const executor = vi.fn(async () => "inspected");
  const usage = {
    inputTokens: { total: 4 },
    outputTokens: { total: 2 },
  };
  const model = new MockLanguageModelV3({
    doStream: async (options) => {
      responseFormats.push(options.responseFormat);
      toolCounts.push(options.tools?.length ?? 0);
      providerOptions.push(options.providerOptions);
      if (!options.responseFormat) operationalTurn += 1;
      if (!options.responseFormat && operationalTurn === 1) {
        return { stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          { type: "tool-call", toolCallId: "inspect_1", toolName: "inspect", input: "{}" },
          { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
        ] as any[]) };
      }
      const text = options.responseFormat || (options.tools?.length ?? 0) === 0
        ? '{"answer":"ready"}'
        : "Operational work complete.";
      return { stream: convertArrayToReadableStream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "text" },
        { type: "text-delta", id: "text", delta: text },
        { type: "text-end", id: "text" },
        { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
      ] as any[]) };
    },
  });
  const deps = {
    getConfig: () => ({ settings: {} }),
    emit: vi.fn(),
    resolveAgentModel: vi.fn(async () => ({
      model: {
        id: "mock/model",
        provider: "mock",
        aiModel: model,
        maxTokens: 8192,
        contextWindow: 128_000,
      },
    })),
  } as unknown as CompletionRouteDeps;
  const execution: ChatCompletionExecution = {
    deps,
    body: {
      agent: "test-agent",
      messages: [{ role: "user", content: "Inspect and answer" }],
      response_format: responseFormat,
    },
    completionId: "completion",
    agentConfig: { name: "test-agent", model: "mock/model" },
    agentMode: true,
    fullSystemPrompt: "Inspect before answering.",
    m: {
      id: "mock/model",
      provider: "mock",
      aiModel: model,
      maxTokens: 8192,
      contextWindow: 128_000,
    },
    modelOutput: modelOutputForResponseFormat(responseFormat),
    effectiveTools: [{
      name: "inspect",
      description: "Inspect",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    }],
    effectiveToolExecutor: executor,
    clientSideTools: {},
    interactionSettings: normalizeChatInteractionSettings({}),
    aiMessages: [{ role: "user", content: "Inspect and answer" }],
    sessionStore: null,
    sessionId: null,
  };
  return { execution, executor, responseFormats, toolCounts, providerOptions };
}

describe("chat structured-output phases", () => {
  it("separates operational tools from terminal output in non-streaming chat", async () => {
    const f = fixture();
    const response = await runNonStreamingChatCompletion({
      req: { raw: { signal: new AbortController().signal } },
      json: (body: unknown) => body,
    } as any, f.execution) as any;

    expect(response.choices[0].message.content).toBe('{"answer":"ready"}');
    expect(f.responseFormats).toEqual([
      undefined,
      undefined,
      expect.objectContaining({ type: "json" }),
    ]);
    expect(f.toolCounts).toEqual([1, 1, 0]);
    expect(f.executor).toHaveBeenCalledOnce();
  });

  it("buffers and validates terminal output before publishing streaming chat", async () => {
    const f = fixture();
    const frames: string[] = [];
    const writer = {
      write: vi.fn(async () => {}),
      writeSSE: vi.fn(async ({ data }: { data: string }) => { frames.push(data); }),
    };

    await executeStreamingChatCompletion(
      writer,
      f.execution,
      new AbortController().signal,
    );

    expect(f.responseFormats).toEqual([
      undefined,
      undefined,
      expect.objectContaining({ type: "json" }),
    ]);
    expect(f.toolCounts).toEqual([1, 1, 0]);
    expect(f.executor).toHaveBeenCalledOnce();
    const contentFrames = frames
      .filter((frame) => frame !== "[DONE]")
      .map((frame) => JSON.parse(frame))
      .flatMap((frame) => frame.choices ?? [])
      .map((choice) => choice.delta?.content)
      .filter(Boolean);
    expect(contentFrames).toEqual(['{"answer":"ready"}']);
  });
});

function anthropicStructuredOutputFixture(options: {
  runtimeMode?: "gateway" | "provider";
  reasoning?: "off" | "medium";
  omitConfiguredReasoning?: boolean;
  terminalTexts?: string[];
} = {}) {
  const runtimeMode = options.runtimeMode ?? "gateway";
  const reasoning = options.reasoning ?? "medium";
  const terminalTexts = options.terminalTexts ?? [];
  const calls: Array<{
    responseFormat: unknown;
    providerOptions: Record<string, any> | undefined;
    prompt: unknown;
  }> = [];
  let terminalAttempt = 0;
  const usage = {
    inputTokens: { total: 4 },
    outputTokens: { total: 2 },
  };
  const model = new MockLanguageModelV3({
    doStream: async (options) => {
      const providerOptions = options.providerOptions as Record<string, any> | undefined;
      calls.push({ responseFormat: options.responseFormat, providerOptions, prompt: options.prompt });
      if (
        runtimeMode === "gateway"
        && options.responseFormat
        && providerOptions?.anthropic?.thinking
      ) {
        throw new Error(
          "toolChoice 'required' is not supported with this model or thinking configuration",
        );
      }
      const gatewayTerminalText = runtimeMode === "gateway"
        && !options.responseFormat
        && calls.length > 1;
      const terminalText = terminalTexts[terminalAttempt]
        ?? '{"status":"ready"}';
      if (gatewayTerminalText) terminalAttempt += 1;
      const content = options.responseFormat || gatewayTerminalText
        ? [
            { type: "text-start", id: "text" },
            { type: "text-delta", id: "text", delta: terminalText },
            { type: "text-end", id: "text" },
          ]
        : [
            { type: "reasoning-start", id: "reasoning" },
            { type: "reasoning-delta", id: "reasoning", delta: "Checked readiness." },
            { type: "reasoning-end", id: "reasoning" },
            { type: "text-start", id: "text" },
            { type: "text-delta", id: "text", delta: "The system is ready." },
            { type: "text-end", id: "text" },
          ];
      return { stream: convertArrayToReadableStream([
        { type: "stream-start", warnings: [] },
        ...content,
        { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
      ] as any[]) };
    },
  });
  const reasoningProviderOptions = reasoning === "off"
    ? { anthropic: { structuredOutputMode: "auto" } }
    : {
        anthropic: {
          structuredOutputMode: "auto",
          thinking: { type: "enabled", budgetTokens: 4096 },
          effort: "medium",
        },
      };
  const resolvedModel = {
    id: "claude-haiku-4.5",
    provider: "anthropic",
    runtimeMode,
    aiModel: model,
    maxTokens: 8192,
    contextWindow: 200_000,
  };
  const execution: ChatCompletionExecution = {
    deps: {
      getConfig: () => ({ settings: {} }),
      emit: vi.fn(),
      resolveAgentModel: vi.fn(async () => ({
        model: resolvedModel,
        providerOptions: reasoningProviderOptions,
      })),
    } as unknown as CompletionRouteDeps,
    body: {
      agent: "release-haiku-structured-smoke",
      messages: [{ role: "user", content: "Report that the system is ready." }],
      response_format: productionHaikuResponseFormat,
    },
    completionId: "chat-production-regression",
    agentConfig: {
      name: "release-haiku-structured-smoke",
      model: "anthropic/claude-haiku-4.5",
      ...(options.omitConfiguredReasoning ? {} : { reasoning }),
    },
    agentMode: true,
    fullSystemPrompt: "Return the requested structured result.",
    m: resolvedModel,
    providerOpts: reasoningProviderOptions,
    modelOutput: modelOutputForResponseFormat(productionHaikuResponseFormat),
    effectiveTools: [],
    effectiveToolExecutor: vi.fn(),
    clientSideTools: {},
    interactionSettings: normalizeChatInteractionSettings({}),
    aiMessages: [{ role: "user", content: "Report that the system is ready." }],
    sessionStore: null,
    sessionId: null,
  };
  return { calls, execution };
}

describe("Anthropic Gateway reasoning with structured output", () => {
  it("keeps reasoning in the operational turn and removes it from the non-streaming schema turn", async () => {
    const f = anthropicStructuredOutputFixture();
    const response = await runNonStreamingChatCompletion({
      req: { raw: { signal: new AbortController().signal } },
      json: (body: unknown) => body,
    } as any, f.execution) as any;

    expect(response.choices[0].message.content).toBe('{"status":"ready"}');
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0]).toMatchObject({
      responseFormat: undefined,
      providerOptions: { anthropic: { thinking: { type: "enabled" } } },
    });
    expect(f.calls[1]).toMatchObject({
      responseFormat: undefined,
      providerOptions: { anthropic: { structuredOutputMode: "auto" } },
    });
    expect(f.calls[1]?.providerOptions?.anthropic).not.toHaveProperty("thinking");
    expect(f.calls[1]?.providerOptions?.anthropic).not.toHaveProperty("effort");
    const terminalSystem = (f.calls[1]?.prompt as Array<{ role?: string; content?: string }>)
      .find((message) => message.role === "system")?.content;
    expect(terminalSystem).toContain('"enum":["ready"]');
  });

  it("publishes only the validated schema result while streaming the same production payload", async () => {
    const f = anthropicStructuredOutputFixture();
    const frames: string[] = [];
    await executeStreamingChatCompletion({
      write: vi.fn(async () => {}),
      writeSSE: vi.fn(async ({ data }: { data: string }) => { frames.push(data); }),
    }, f.execution, new AbortController().signal);

    expect(f.calls).toHaveLength(2);
    expect(f.calls[0]?.providerOptions?.anthropic?.thinking).toEqual({
      type: "enabled",
      budgetTokens: 4096,
    });
    expect(f.calls[1]).toMatchObject({
      responseFormat: undefined,
      providerOptions: {
        anthropic: {
          structuredOutputMode: "auto",
        },
      },
    });
    expect(f.calls[1]?.providerOptions?.anthropic).toEqual({
      structuredOutputMode: "auto",
    });
    const content = frames
      .filter((frame) => frame !== "[DONE]")
      .map((frame) => JSON.parse(frame))
      .flatMap((frame) => frame.choices ?? [])
      .map((choice) => choice.delta?.content)
      .filter(Boolean);
    expect(content).toEqual(['{"status":"ready"}']);
  });

  it("separates the schema pass when Cloud defaults thinking outside the agent config", async () => {
    const f = anthropicStructuredOutputFixture({ omitConfiguredReasoning: true });
    const response = await runNonStreamingChatCompletion({
      req: { raw: { signal: new AbortController().signal } },
      json: (body: unknown) => body,
    } as any, f.execution) as any;

    expect(f.calls).toHaveLength(2);
    expect(f.calls[0]?.providerOptions?.anthropic?.thinking).toEqual({
      type: "enabled",
      budgetTokens: 4096,
    });
    expect(f.calls[1]?.responseFormat).toBeUndefined();
    expect(f.calls[1]?.providerOptions?.anthropic).toEqual({
      structuredOutputMode: "auto",
    });
    expect(response.choices[0].message.content).toBe('{"status":"ready"}');
  });

  it("repairs only the terminal JSON when the first real production payload is invalid", async () => {
    const f = anthropicStructuredOutputFixture({
      terminalTexts: [
        "The system is ready.",
        '{"status":"ready"}',
      ],
    });
    const response = await runNonStreamingChatCompletion({
      req: { raw: { signal: new AbortController().signal } },
      json: (body: unknown) => body,
    } as any, f.execution) as any;

    expect(response.choices[0].message.content).toBe('{"status":"ready"}');
    expect(f.calls).toHaveLength(3);
    expect(f.calls.slice(1).every((call) => call.responseFormat === undefined)).toBe(true);
    expect(f.calls.slice(1).every((call) => !call.providerOptions?.anthropic?.thinking)).toBe(true);
    expect(f.execution.deps.emit).toHaveBeenCalledWith(
      "runtime:structured-output-recovery",
      expect.objectContaining({ phase: "succeeded", source: "chat" }),
    );
  });

  it("fails closed after one invalid terminal JSON recovery", async () => {
    const f = anthropicStructuredOutputFixture({
      terminalTexts: ["not JSON", '{"status":"wrong"}'],
    });
    const response = await runNonStreamingChatCompletion({
      req: { raw: { signal: new AbortController().signal } },
      json: (body: unknown) => body,
    } as any, f.execution) as any;

    expect(response).toMatchObject({
      error: { code: "invalid_response_format_output" },
    });
    expect(f.calls).toHaveLength(3);
    expect(f.execution.deps.emit).toHaveBeenCalledWith(
      "runtime:structured-output-recovery",
      expect.objectContaining({ phase: "failed", source: "chat" }),
    );
  });

  it("keeps direct Anthropic native reasoning and structured output in one turn", async () => {
    const f = anthropicStructuredOutputFixture({ runtimeMode: "provider" });
    const response = await runNonStreamingChatCompletion({
      req: { raw: { signal: new AbortController().signal } },
      json: (body: unknown) => body,
    } as any, f.execution) as any;

    expect(response.choices[0].message.content).toBe('{"status":"ready"}');
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({
      responseFormat: { type: "json" },
      providerOptions: {
        anthropic: {
          structuredOutputMode: "auto",
          thinking: { type: "enabled", budgetTokens: 4096 },
          effort: "medium",
        },
      },
    });
  });

  it("keeps a non-reasoning Anthropic Gateway schema request in one turn", async () => {
    const f = anthropicStructuredOutputFixture({ reasoning: "off" });
    const response = await runNonStreamingChatCompletion({
      req: { raw: { signal: new AbortController().signal } },
      json: (body: unknown) => body,
    } as any, f.execution) as any;

    expect(response.choices[0].message.content).toBe('{"status":"ready"}');
    expect(f.calls).toEqual([expect.objectContaining({
      responseFormat: expect.objectContaining({ type: "json" }),
      providerOptions: { anthropic: { structuredOutputMode: "auto" } },
    })]);
  });

  it("removes thinking only from the terminal schema turn after real tool execution", async () => {
    const f = fixture();
    const reasoningProviderOptions = {
      anthropic: {
        structuredOutputMode: "auto",
        thinking: { type: "enabled", budgetTokens: 4096 },
      },
    };
    Object.assign(f.execution.m, {
      id: "claude-haiku-4.5",
      provider: "anthropic",
      runtimeMode: "gateway",
    });
    f.execution.agentConfig.reasoning = "medium";
    f.execution.providerOpts = reasoningProviderOptions;
    (f.execution.deps.resolveAgentModel as any) = vi.fn(async () => ({
      model: f.execution.m,
      providerOptions: reasoningProviderOptions,
    }));

    const response = await runNonStreamingChatCompletion({
      req: { raw: { signal: new AbortController().signal } },
      json: (body: unknown) => body,
    } as any, f.execution) as any;

    expect(response.choices[0].message.content).toBe('{"answer":"ready"}');
    expect(f.executor).toHaveBeenCalledOnce();
    expect(f.providerOptions).toEqual([
      reasoningProviderOptions,
      reasoningProviderOptions,
      { anthropic: { structuredOutputMode: "auto" } },
    ]);
  });
});

function repeatedStableReadFixture() {
  const providerCalls = vi.fn();
  const usage = {
    inputTokens: { total: 2 },
    outputTokens: { total: 1 },
  };
  let turn = 0;
  const model = new MockLanguageModelV3({
    doStream: async () => {
      providerCalls();
      turn += 1;
      return { stream: convertArrayToReadableStream([
        { type: "stream-start", warnings: [] },
        {
          type: "tool-call",
          toolCallId: `read_${turn}`,
          toolName: "stable_read",
          input: JSON.stringify({ key: "same" }),
        },
        { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
      ] as any[]) };
    },
  });
  const executor = vi.fn(async () => "unchanged");
  const progress: CompletionToolProgressState = {};
  const tool = {
    name: "stable_read",
    description: "Read stable state",
    parameters: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      resultStability: "stable" as const,
    },
  };
  const guarded = createGuardedCompletionToolExecutor({
    executor,
    tools: [tool],
    context: { source: "request" },
    onProgress: ({ name, decision }) => {
      if (decision.action !== "stall") return;
      progress.stalled = {
        code: decision.code,
        toolName: name,
        fingerprint: decision.fingerprint,
        observation: decision.observation,
        message: decision.message,
      };
    },
  });
  const execution: ChatCompletionExecution = {
    deps: { getConfig: () => ({ settings: {} }), emit: vi.fn() } as any,
    body: { agent: "test-agent", messages: [{ role: "user", content: "Read it" }] },
    completionId: "completion-stall",
    agentConfig: { name: "test-agent", model: "mock/model" },
    agentMode: true,
    fullSystemPrompt: "Use the read tool.",
    m: {
      id: "mock/model",
      provider: "mock",
      aiModel: model,
      maxTokens: 8192,
      contextWindow: 128_000,
    },
    effectiveTools: [tool],
    effectiveToolExecutor: guarded,
    toolProgressState: progress,
    clientSideTools: {},
    interactionSettings: normalizeChatInteractionSettings({}),
    aiMessages: [{ role: "user", content: "Read it" }],
    sessionStore: null,
    sessionId: null,
  };
  return { execution, executor, providerCalls };
}

describe("chat stable-read livelock boundary", () => {
  it("returns a typed non-streaming error on the fourth observation", async () => {
    const fixture = repeatedStableReadFixture();
    let status = 200;
    const response = await runNonStreamingChatCompletion({
      req: { raw: { signal: new AbortController().signal } },
      json: (body: unknown, nextStatus?: number) => {
        status = nextStatus ?? 200;
        return body;
      },
    } as any, fixture.execution) as any;

    expect(status).toBe(409);
    expect(response.error).toMatchObject({
      type: "runtime_error",
      code: "tool_loop_stalled",
    });
    expect(fixture.providerCalls).toHaveBeenCalledTimes(4);
    expect(fixture.executor).toHaveBeenCalledTimes(1);
  });

  it("emits the same typed error and stops the streaming loop", async () => {
    const fixture = repeatedStableReadFixture();
    const frames: string[] = [];
    await executeStreamingChatCompletion({
      write: vi.fn(async () => {}),
      writeSSE: vi.fn(async ({ data }: { data: string }) => { frames.push(data); }),
    }, fixture.execution, new AbortController().signal);

    const payloads = frames
      .filter((frame) => frame !== "[DONE]")
      .map((frame) => JSON.parse(frame));
    expect(payloads.some((frame) =>
      frame.choices?.[0]?.error?.code === "tool_loop_stalled"
    )).toBe(true);
    expect(fixture.providerCalls).toHaveBeenCalledTimes(4);
    expect(fixture.executor).toHaveBeenCalledTimes(1);
  });
});
