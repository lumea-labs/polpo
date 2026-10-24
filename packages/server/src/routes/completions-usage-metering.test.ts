import { beforeEach, describe, expect, it, vi } from "vitest";

const { generateTextMock, streamTextMock } = vi.hoisted(() => ({
  generateTextMock: vi.fn(),
  streamTextMock: vi.fn(),
}));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: generateTextMock,
    streamText: streamTextMock,
    jsonSchema: (schema: unknown) => schema,
  };
});

import { completionRoutes, type CompletionRouteDeps } from "./completions.js";
import { buildSummarizeFn } from "./completions/agent-step-runner.js";
import { CompletionModelInvocationLedger } from "./completions/model-invocations.js";

/** Gateway metadata as returned by Vercel AI Gateway for one billed call. */
function gatewayMetadata(generationId: string, marketCost = "0.01") {
  return { gateway: { generationId, marketCost, cost: "0.008" } };
}

function mockStreamResult(options: {
  parts?: any[];
  text?: string;
  toolCalls?: any[];
  usage?: any;
  responseMessages?: any[];
  providerMetadata?: Record<string, unknown>;
}) {
  const usage = options.usage ?? { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
  async function* fullStream() {
    for (const part of options.parts ?? []) yield part;
    if (options.text) yield { type: "text-delta", id: "text_1", text: options.text };
    yield { type: "finish", finishReason: options.toolCalls?.length ? "tool-calls" : "stop", totalUsage: usage };
  }
  return {
    fullStream: fullStream(),
    toolCalls: Promise.resolve(options.toolCalls ?? []),
    toolResults: Promise.resolve([]),
    usage: Promise.resolve(usage),
    totalUsage: Promise.resolve(usage),
    finishReason: Promise.resolve(options.toolCalls?.length ? "tool-calls" : "stop"),
    rawFinishReason: Promise.resolve(undefined),
    providerMetadata: Promise.resolve(options.providerMetadata),
    response: Promise.resolve({ messages: options.responseMessages ?? [] }),
  };
}

function toolTurn(callId: string, generationId: string) {
  const call = { toolCallId: callId, toolName: "lookup", input: { q: callId } };
  return mockStreamResult({
    toolCalls: [call],
    providerMetadata: gatewayMetadata(generationId),
    responseMessages: [{
      role: "assistant",
      content: [{ type: "tool-call", ...call }],
    }],
  });
}

function finalTurn(generationId: string) {
  return mockStreamResult({
    text: "done",
    providerMetadata: gatewayMetadata(generationId),
    responseMessages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
  });
}

function queueThreeTurnToolChat() {
  streamTextMock
    .mockReturnValueOnce(toolTurn("call_1", "gen_1"))
    .mockReturnValueOnce(toolTurn("call_2", "gen_2"))
    .mockReturnValueOnce(finalTurn("gen_3"));
}

function marketCostSum(invocations: Array<{ providerMetadata?: Record<string, any> }> | undefined): number {
  const cents = (invocations ?? []).reduce(
    (sum, entry) => sum + Math.round(Number(entry.providerMetadata?.gateway?.marketCost ?? 0) * 100),
    0,
  );
  return cents / 100;
}

const lookupTool = {
  name: "lookup",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["q"],
    properties: { q: { type: "string" } },
  },
};

function makeDeps(overrides: Partial<CompletionRouteDeps> = {}): CompletionRouteDeps {
  return {
    getAgents: async () => [{ name: "researcher", model: "test", allowedTools: ["lookup"] }],
    getConfig: () => ({}),
    getMemoryStore: () => null,
    getSessionStore: () => null,
    getStore: () => null,
    emit: () => {},
    buildAgentPrompt: () => "You are a researcher.",
    resolveAgentModel: async (agentConfig: any) => {
      const ref = typeof agentConfig?.model === "string" ? agentConfig.model : "test";
      const id = ref.includes("/") ? ref.slice(ref.indexOf("/") + 1) : ref;
      return {
        model: {
          id,
          provider: "test",
          aiModel: `${id}-ai-model`,
          contextWindow: 100_000,
          maxTokens: 1024,
        },
        providerOptions: undefined,
      };
    },
    resolveAgentTools: async () => ({
      tools: [lookupTool],
      executor: async (_name, args) => `result for ${(args as any).q}`,
    }),
    ...overrides,
  };
}

async function postCompletion(deps: CompletionRouteDeps, body: Record<string, unknown>) {
  const app = completionRoutes(() => deps);
  const res = await app.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "look it up" }], ...body }),
  });
  await res.text();
  return res;
}

describe("completion usage metering", () => {
  beforeEach(() => {
    generateTextMock.mockReset();
    streamTextMock.mockReset();
  });

  for (const stream of [false, true]) {
    it(`reports every billed call of a 3-turn tool chat (stream=${stream})`, async () => {
      queueThreeTurnToolChat();
      const onCompletionFinished = vi.fn();

      const res = await postCompletion(makeDeps({ onCompletionFinished }), { agent: "researcher", stream });

      expect(res.status).toBe(200);
      expect(streamTextMock).toHaveBeenCalledTimes(3);
      expect(onCompletionFinished).toHaveBeenCalledOnce();
      const info = onCompletionFinished.mock.calls[0]![0];
      expect(info.invocations).toEqual([
        expect.objectContaining({ phase: "operational", status: "succeeded", providerMetadata: gatewayMetadata("gen_1") }),
        expect.objectContaining({ phase: "operational", status: "succeeded", providerMetadata: gatewayMetadata("gen_2") }),
        expect.objectContaining({ phase: "operational", status: "succeeded", providerMetadata: gatewayMetadata("gen_3") }),
      ]);
      expect(marketCostSum(info.invocations)).toBe(0.03);
      expect(info.usage).toMatchObject({ inputTokens: 30, outputTokens: 15, totalTokens: 45 });
      // Legacy consumers keep receiving the final call's metadata.
      expect(info.providerMetadata).toEqual(gatewayMetadata("gen_3"));
    });
  }

  it("meters a fallback attempt the provider billed before the stream failed", async () => {
    streamTextMock
      .mockReturnValueOnce(mockStreamResult({
        parts: [
          {
            type: "finish-step",
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            providerMetadata: gatewayMetadata("gen_failed"),
          },
          { type: "error", error: new Error("503 overloaded") },
        ],
      }))
      .mockReturnValueOnce(finalTurn("gen_ok"));
    const onCompletionFinished = vi.fn();

    const res = await postCompletion(makeDeps({
      onCompletionFinished,
      getAgents: async () => [{
        name: "researcher",
        model: { primary: "test/primary", fallbacks: ["test/fallback"] },
        allowedTools: [],
      }],
    }), { agent: "researcher" });

    expect(res.status).toBe(200);
    const info = onCompletionFinished.mock.calls[0]![0];
    expect(info.invocations).toEqual([
      expect.objectContaining({ status: "failed", model: "test/primary", providerMetadata: gatewayMetadata("gen_failed") }),
      expect.objectContaining({ status: "succeeded", model: "test/fallback", providerMetadata: gatewayMetadata("gen_ok") }),
    ]);
    expect(marketCostSum(info.invocations)).toBe(0.02);
  });

  for (const stream of [false, true]) {
    it(`reports every billed call of a loop agent step (stream=${stream})`, async () => {
      queueThreeTurnToolChat();
      const onCompletionFinished = vi.fn();
      const deps = makeDeps({
        onCompletionFinished,
        getAgents: async () => [{
          name: "researcher",
          model: "test",
          assignedLoops: ["research-loop"],
          allowedTools: ["lookup"],
        }],
        getProjectLoop: async (name) => ({
          name,
          context: "shared",
          start: "research",
          steps: {
            research: {
              type: "agent",
              systemPrompt: "Research the question.",
              tools: ["lookup"],
              maxTurns: 5,
              next: "end",
            },
          },
        }),
      });

      const res = await postCompletion(deps, { agent: "researcher", loop: "research-loop", stream });

      expect(res.status).toBe(200);
      expect(streamTextMock).toHaveBeenCalledTimes(3);
      expect(onCompletionFinished).toHaveBeenCalledOnce();
      const info = onCompletionFinished.mock.calls[0]![0];
      expect(info.invocations).toHaveLength(3);
      expect(marketCostSum(info.invocations)).toBe(0.03);
      expect(info.providerMetadata).toEqual(gatewayMetadata("gen_3"));
    });
  }

  it("records compaction summarizer calls as billed invocations", async () => {
    generateTextMock.mockResolvedValueOnce({
      text: "summary",
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      providerMetadata: gatewayMetadata("gen_compaction"),
    });
    const invocations = new CompletionModelInvocationLedger();
    const summarize = buildSummarizeFn({
      id: "test",
      provider: "test",
      aiModel: "test-ai-model",
      contextWindow: 100_000,
      maxTokens: 1024,
    } as any, undefined, { invocations });

    await expect(summarize([{ role: "user", content: "long history" }], "Summarize")).resolves.toBe("summary");
    expect(invocations.list()).toEqual([{
      phase: "compaction",
      status: "succeeded",
      model: "test",
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      providerMetadata: gatewayMetadata("gen_compaction"),
    }]);
  });
});
