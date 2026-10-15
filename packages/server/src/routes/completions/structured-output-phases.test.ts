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

function fixture() {
  let operationalTurn = 0;
  const responseFormats: unknown[] = [];
  const toolCounts: number[] = [];
  const executor = vi.fn(async () => "inspected");
  const usage = {
    inputTokens: { total: 4 },
    outputTokens: { total: 2 },
  };
  const model = new MockLanguageModelV3({
    doStream: async (options) => {
      responseFormats.push(options.responseFormat);
      toolCounts.push(options.tools?.length ?? 0);
      if (!options.responseFormat) operationalTurn += 1;
      if (!options.responseFormat && operationalTurn === 1) {
        return { stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          { type: "tool-call", toolCallId: "inspect_1", toolName: "inspect", input: "{}" },
          { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
        ] as any[]) };
      }
      const text = options.responseFormat
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
  return { execution, executor, responseFormats, toolCounts };
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
