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

import {
  CompletionRuntimeError,
  completionRoutes,
  type CompletionRouteDeps,
} from "./completions.js";
import {
  RuntimeGuardrailEngine,
  createRunOutputPolicy,
  createRunToolMiddleware,
} from "@polpo-ai/core";

function parseSseJsonChunks(body: string): any[] {
  return body
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.startsWith("data: "))
    .map((block) => block.slice("data: ".length))
    .filter((data) => data !== "[DONE]")
    .map((data) => JSON.parse(data));
}

function mockStreamResult(options: {
  parts?: any[];
  text?: string;
  toolCalls?: any[];
  toolResults?: any[];
  usage?: any;
  responseMessages?: any[];
  providerMetadata?: Record<string, unknown>;
}) {
  const usage = options.usage ?? { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
  async function* fullStream() {
    for (const part of options.parts ?? []) yield part;
    if (options.text) {
      yield { type: "text-delta", id: "text_1", text: options.text };
    }
    yield { type: "finish", finishReason: options.toolCalls?.length ? "tool-calls" : "stop", totalUsage: usage };
  }
  return {
    fullStream: fullStream(),
    toolCalls: Promise.resolve(options.toolCalls ?? []),
    toolResults: Promise.resolve(options.toolResults ?? []),
    usage: Promise.resolve(usage),
    totalUsage: Promise.resolve(usage),
    finishReason: Promise.resolve(options.toolCalls?.length ? "tool-calls" : "stop"),
    rawFinishReason: Promise.resolve(undefined),
    providerMetadata: Promise.resolve(options.providerMetadata),
    response: Promise.resolve({ messages: options.responseMessages ?? [] }),
  };
}

describe("completionRoutes provider-executed tools", () => {
  beforeEach(() => {
    generateTextMock.mockReset();
    streamTextMock.mockReset();
  });

  function makeDeps(): CompletionRouteDeps {
    return {
      getAgents: async () => [{
        name: "researcher",
        model: "test",
        assignedLoops: ["research-loop"],
        allowedTools: ["search_web"],
      }],
      getConfig: () => ({}),
      getMemoryStore: () => null,
      getSessionStore: () => null,
      getStore: () => null,
      emit: () => {},
      buildAgentPrompt: () => "You are a researcher.",
      resolveAgentModel: async () => ({
        model: {
          id: "test",
          provider: "test",
          aiModel: "test-model",
          contextWindow: 100_000,
          maxTokens: 1024,
        },
        providerOptions: undefined,
      }),
      resolveAgentTools: async () => ({
        tools: [],
        extraAiTools: {
          search_web: { type: "provider-defined", id: "gateway.perplexity_search" },
        },
        executor: async (name) => {
          throw new Error(`provider tool "${name}" should not be executed locally`);
        },
      }),
      getProjectLoop: async (name) => ({
        name,
        context: "shared",
        start: "research",
        steps: {
          research: {
            type: "agent",
            systemPrompt: "Search the web, then summarize the result.",
            tools: ["search_web"],
            maxTurns: 3,
            next: "end",
          },
        },
      }),
    };
  }

  it("enforces output policy on inline non-streaming completions", async () => {
    streamTextMock.mockReturnValue(mockStreamResult({
      text: "unsafe inline output",
      toolCalls: [],
      responseMessages: [{
        role: "assistant",
        content: "unsafe inline output",
      }],
    }));
    const deps = makeDeps();
    deps.runOutputPolicy = createRunOutputPolicy(new RuntimeGuardrailEngine([{
      id: "redact-inline-output",
      phases: ["output"],
      evaluate: () => ({
        action: "redact",
        risk: "high",
        reason: "sensitive inline result",
        value: "safe inline output",
      }),
    }]));

    const res = await completionRoutes(() => deps).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "researcher",
        messages: [{ role: "user", content: "answer" }],
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.choices[0].message.content).toBe("safe inline output");
  });

  it("feeds provider-executed tool results back through AI SDK responseMessages", async () => {
    let secondTurnMessages: any[] | undefined;
    const searchOutput = {
      results: [{ title: "Polpo", url: "https://polpo.sh", snippet: "Agent backend" }],
      id: "search_1",
    };

    streamTextMock
      .mockReturnValueOnce(mockStreamResult({
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
        providerMetadata: undefined,
        toolCalls: [{
          toolCallId: "call_search",
          toolName: "search_web",
          input: { query: "Polpo agent backend" },
          providerExecuted: true,
        }],
        toolResults: [{
          type: "tool-result",
          toolCallId: "call_search",
          toolName: "search_web",
          output: searchOutput,
          providerExecuted: true,
        }],
        responseMessages: [{
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call_search",
              toolName: "search_web",
              input: { query: "Polpo agent backend" },
              providerExecuted: true,
            },
            {
              type: "tool-result",
              toolCallId: "call_search",
              toolName: "search_web",
              output: { type: "json", value: searchOutput },
              providerExecuted: true,
            },
          ],
        }],
      }))
      .mockImplementationOnce((args: any) => {
        secondTurnMessages = args.messages;
        return mockStreamResult({
          text: "Polpo is an agent backend.",
          usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
          providerMetadata: undefined,
          toolCalls: [],
          toolResults: [],
          responseMessages: [{
            role: "assistant",
            content: "Polpo is an agent backend.",
          }],
        });
      });

    const app = completionRoutes(() => makeDeps());
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "researcher",
        loop: "research-loop",
        messages: [{ role: "user", content: "Research Polpo" }],
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.choices[0].message.content).toBe("Polpo is an agent backend.");
    expect(streamTextMock).toHaveBeenCalledTimes(2);

    expect(secondTurnMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: expect.arrayContaining([
            expect.objectContaining({
              type: "tool-result",
              toolName: "search_web",
              providerExecuted: true,
            }),
          ]),
        }),
      ]),
    );
    expect(
      secondTurnMessages?.filter((message) =>
        message.role === "tool" && JSON.stringify(message).includes("search_web"),
      ),
    ).toEqual([]);
  });

  it("shares one tool run scope across root tools and every agent loop step", async () => {
    streamTextMock
      .mockReturnValueOnce(mockStreamResult({
        text: "prepared",
        responseMessages: [{ role: "assistant", content: "prepared" }],
      }))
      .mockReturnValueOnce(mockStreamResult({
        text: "verified",
        responseMessages: [{ role: "assistant", content: "verified" }],
      }));

    const deps = makeDeps();
    deps.getProjectLoop = async (name) => ({
      name,
      context: "shared",
      start: "prepare",
      steps: {
        prepare: { type: "agent", next: "verify" },
        verify: { type: "agent", next: "end" },
      },
    });
    const scopeCleanup = vi.fn(async () => undefined);
    const runScope = { id: "tool-run-scope-1", cleanup: scopeCleanup };
    deps.createToolRunScope = vi.fn(async () => runScope);
    const resolutionCleanups: Array<ReturnType<typeof vi.fn>> = [];
    const observedScopes: unknown[] = [];
    deps.resolveAgentTools = vi.fn(async (_agentConfig, scope) => {
      observedScopes.push(scope);
      const cleanup = vi.fn(async () => undefined);
      resolutionCleanups.push(cleanup);
      return {
        tools: [],
        executor: async () => "ok",
        cleanup,
      };
    });

    const response = await completionRoutes(() => deps).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "researcher",
        loop: "research-loop",
        messages: [{ role: "user", content: "Prepare and verify" }],
      }),
    });

    expect(response.status).toBe(200);
    expect(deps.createToolRunScope).toHaveBeenCalledOnce();
    expect(observedScopes).toEqual([runScope, runScope, runScope]);
    expect(resolutionCleanups).toHaveLength(3);
    expect(resolutionCleanups.every((cleanup) => cleanup.mock.calls.length === 1)).toBe(true);
    expect(scopeCleanup).toHaveBeenCalledOnce();
  });

  it("cleans the shared tool run scope when a nested agent tool resolution fails", async () => {
    const deps = makeDeps();
    const scopeCleanup = vi.fn(async () => undefined);
    const rootCleanup = vi.fn(async () => undefined);
    const runScope = { id: "tool-run-scope-failure", cleanup: scopeCleanup };
    deps.createToolRunScope = vi.fn(async () => runScope);
    deps.resolveAgentTools = vi.fn()
      .mockResolvedValueOnce({
        tools: [],
        executor: async () => "ok",
        cleanup: rootCleanup,
      })
      .mockRejectedValueOnce(new Error("nested tool resolution failed"));

    const response = await completionRoutes(() => deps).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "researcher",
        loop: "research-loop",
        messages: [{ role: "user", content: "Research Polpo" }],
      }),
    });

    expect(response.status).toBe(500);
    expect(rootCleanup).toHaveBeenCalledOnce();
    expect(scopeCleanup).toHaveBeenCalledOnce();
  });

  it("cleans the tool run scope when root tool resolution fails", async () => {
    const deps = makeDeps();
    const scopeCleanup = vi.fn(async () => undefined);
    const runScope = { id: "tool-run-scope-root-failure", cleanup: scopeCleanup };
    deps.createToolRunScope = vi.fn(async () => runScope);
    deps.resolveAgentTools = vi.fn(async () => {
      throw new Error("root tool resolution failed");
    });

    const response = await completionRoutes(() => deps).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "researcher",
        loop: "research-loop",
        messages: [{ role: "user", content: "Research Polpo" }],
      }),
    });

    expect(response.status).toBe(500);
    expect(scopeCleanup).toHaveBeenCalledOnce();
  });

  it("returns host runtime resource failures as safe OpenAI-compatible errors", async () => {
    const deps = makeDeps();
    deps.resolveAgentTools = vi.fn(async () => {
      throw new CompletionRuntimeError(
        "Sandbox volume workspace is not granted to agent researcher.",
        "sandbox_volume_not_granted",
        403,
      );
    });

    const response = await completionRoutes(() => deps).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "researcher",
        messages: [{ role: "user", content: "Answer without using tools" }],
      }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: {
        message: "Sandbox volume workspace is not granted to agent researcher.",
        type: "runtime_error",
        code: "sandbox_volume_not_granted",
      },
    });
    expect(streamTextMock).not.toHaveBeenCalled();
  });

  it("returns host runtime resource failures raised while a project Loop initializes", async () => {
    const deps = makeDeps();
    deps.createToolRunScope = vi.fn(async () => {
      throw new CompletionRuntimeError(
        "Sandbox volume workspace is still syncing.",
        "sandbox_volume_sync_unavailable",
        409,
      );
    });

    const response = await completionRoutes(() => deps).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "researcher",
        loop: "research-loop",
        messages: [{ role: "user", content: "Research Polpo" }],
      }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        message: "Sandbox volume workspace is still syncing.",
        type: "runtime_error",
        code: "sandbox_volume_sync_unavailable",
      },
    });
    expect(streamTextMock).not.toHaveBeenCalled();
  });

  it("cleans root tools and the run scope when loop initialization fails", async () => {
    const deps = makeDeps();
    const scopeCleanup = vi.fn(async () => undefined);
    const rootCleanup = vi.fn(async () => undefined);
    deps.createToolRunScope = vi.fn(async () => ({
      id: "tool-run-scope-init-failure",
      cleanup: scopeCleanup,
    }));
    deps.resolveAgentTools = vi.fn(async () => ({
      tools: [],
      executor: async () => "ok",
      cleanup: rootCleanup,
    }));
    deps.getLoopRunStore = () => ({
      createRun: vi.fn(async () => {
        throw new Error("loop store unavailable");
      }),
    } as any);

    const response = await completionRoutes(() => deps).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "researcher",
        loop: "research-loop",
        messages: [{ role: "user", content: "Research Polpo" }],
      }),
    });

    expect(response.status).toBe(500);
    expect(rootCleanup).toHaveBeenCalledOnce();
    expect(scopeCleanup).toHaveBeenCalledOnce();
  });

  it("does not replace a successful loop result when cleanup fails", async () => {
    streamTextMock.mockReturnValue(mockStreamResult({
      text: "completed",
      responseMessages: [{ role: "assistant", content: "completed" }],
    }));
    const deps = makeDeps();
    deps.createToolRunScope = vi.fn(async () => ({
      id: "tool-run-scope-cleanup-failure",
      cleanup: vi.fn(async () => {
        throw new Error("scope cleanup failed");
      }),
    }));
    deps.resolveAgentTools = vi.fn(async () => ({
      tools: [],
      executor: async () => "ok",
      cleanup: vi.fn(async () => {
        throw new Error("resolver cleanup failed");
      }),
    }));

    const response = await completionRoutes(() => deps).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "researcher",
        loop: "research-loop",
        messages: [{ role: "user", content: "Research Polpo" }],
      }),
    });

    expect(response.status).toBe(200);
  });

  it("streams linear tool argument deltas while the model is preparing a tool call", async () => {
    async function* fullStream() {
      yield { type: "tool-input-start", id: "call_search", toolName: "search_web" };
      yield { type: "tool-input-delta", id: "call_search", delta: "{\"query\":\"Polpo" };
      yield { type: "tool-input-delta", id: "call_search", delta: " pricing\"}" };
      yield { type: "finish", finishReason: "stop" };
    }

    streamTextMock.mockReturnValue({
      fullStream: fullStream(),
      toolCalls: Promise.resolve([]),
      toolResults: Promise.resolve([]),
      usage: Promise.resolve({ inputTokens: 10, outputTokens: 2, totalTokens: 12 }),
      providerMetadata: Promise.resolve(undefined),
      responseMessages: Promise.resolve([]),
    });

    const app = completionRoutes(() => makeDeps());
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "researcher",
        stream: true,
        messages: [{ role: "user", content: "search pricing" }],
      }),
    });

    expect(res.status).toBe(200);
    const chunks = parseSseJsonChunks(await res.text());
    const preparingEvents = chunks
      .map((chunk) => chunk.choices?.[0]?.tool_call)
      .filter((event) => event?.state === "preparing");

    expect(preparingEvents).toEqual([
      expect.objectContaining({ id: "call_search", name: "search_web", state: "preparing" }),
      expect.objectContaining({
        id: "call_search",
        name: "search_web",
        state: "preparing",
        argumentsDelta: "{\"query\":\"Polpo",
      }),
      expect.objectContaining({
        id: "call_search",
        name: "search_web",
        state: "preparing",
        argumentsDelta: " pricing\"}",
      }),
    ]);
  });

  it("terminalizes interrupted tool input and recovers the turn without a dangling call", async () => {
    async function* interruptedStream() {
      yield { type: "tool-input-start", id: "call_search", toolName: "search_web" };
      yield { type: "tool-input-delta", id: "call_search", delta: '{"query":"Polpo"' };
      yield {
        type: "error",
        error: { message: "Provider temporarily unavailable", statusCode: 503 },
      };
    }

    streamTextMock
      .mockReturnValueOnce({
        fullStream: interruptedStream(),
      })
      .mockReturnValueOnce(mockStreamResult({
        text: "recovered",
        responseMessages: [{ role: "assistant", content: "recovered" }],
      }));

    const res = await completionRoutes(() => makeDeps()).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "researcher",
        stream: true,
        messages: [{ role: "user", content: "search pricing" }],
      }),
    });

    expect(res.status).toBe(200);
    const chunks = parseSseJsonChunks(await res.text());
    const toolEvents = chunks
      .map((chunk) => chunk.choices?.[0]?.tool_call)
      .filter(Boolean);
    expect(toolEvents).toEqual([
      expect.objectContaining({ id: "call_search", state: "preparing" }),
      expect.objectContaining({ id: "call_search", state: "preparing" }),
      expect.objectContaining({ id: "call_search", state: "interrupted" }),
    ]);
    expect(chunks.map((chunk) => chunk.choices?.[0]?.delta?.content).filter(Boolean).join(""))
      .toBe("recovered");
    expect(streamTextMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to the next agent model candidate before committing output", async () => {
    const resolvedModels: string[] = [];
    const onCompletionFinished = vi.fn();
    streamTextMock
      .mockImplementationOnce(() => {
        throw new Error("503 overloaded");
      })
      .mockReturnValueOnce(mockStreamResult({
        text: "fallback response",
        usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
        responseMessages: [{
          role: "assistant",
          content: "fallback response",
        }],
      }));

    const deps = makeDeps();
    const app = completionRoutes(() => ({
      ...deps,
      onCompletionFinished,
      getAgents: async () => [{
        name: "researcher",
        model: {
          primary: "test/primary",
          fallbacks: ["test/fallback"],
        },
        allowedTools: [],
      }],
      resolveAgentModel: async (agentConfig: any) => {
        resolvedModels.push(agentConfig.model);
        const id = String(agentConfig.model).slice(String(agentConfig.model).indexOf("/") + 1);
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
        tools: [],
        executor: async () => "ok",
      }),
    }));

    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "researcher",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.choices[0].message.content).toBe("fallback response");
    expect(resolvedModels).toEqual(["test/primary", "test/fallback"]);
    expect(onCompletionFinished).toHaveBeenCalledWith(expect.objectContaining({
      model: "fallback",
      resolvedModel: expect.objectContaining({ id: "fallback", provider: "test" }),
    }));
  });
});

describe("completionRoutes loop agent-step tool streaming", () => {
  beforeEach(() => {
    generateTextMock.mockReset();
    streamTextMock.mockReset();
  });

  function makeDeps(): CompletionRouteDeps {
    return {
      getAgents: async () => [{
        name: "coder",
        model: "test",
        assignedLoops: ["coding-loop"],
        allowedTools: ["bash"],
      }],
      getConfig: () => ({}),
      getMemoryStore: () => null,
      getSessionStore: () => null,
      getStore: () => null,
      emit: () => {},
      buildAgentPrompt: () => "You are a coding agent.",
      resolveAgentModel: async () => ({
        model: {
          id: "test",
          provider: "test",
          aiModel: "test-model",
          contextWindow: 100_000,
          maxTokens: 1024,
        },
        providerOptions: undefined,
      }),
      resolveAgentTools: async () => ({
        tools: [],
        executor: async (name, args) => {
          if (name !== "bash") return `Error: Unknown tool "${name}"`;
          return `ran ${(args as any).command}`;
        },
      }),
      getProjectLoop: async (name) => ({
        name,
        context: "shared",
        start: "implement",
        steps: {
          implement: {
            type: "agent",
            systemPrompt: "Implement the requested change.",
            tools: ["bash"],
            maxTurns: 3,
            next: "end",
          },
        },
      }),
    };
  }

  it("preserves model profile resolution while enforcing middleware on direct tool calls", async () => {
    streamTextMock
      .mockReturnValueOnce(mockStreamResult({
        toolCalls: [{
          toolCallId: "call_bash",
          toolName: "bash",
          input: { command: "echo raw" },
        }],
        responseMessages: [{
          role: "assistant",
          content: [{
            type: "tool-call",
            toolCallId: "call_bash",
            toolName: "bash",
            input: { command: "echo raw" },
          }],
        }],
      }))
      .mockReturnValueOnce(mockStreamResult({
        text: "done",
        responseMessages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
      }));

    const deps = makeDeps();
    deps.getAgents = async () => [{
      name: "coder",
      model: { profile: "balanced" },
      allowedModelProfiles: ["balanced"],
      assignedLoops: ["coding-loop"],
      allowedTools: ["bash"],
    }];
    deps.getConfig = () => ({
      settings: {
        modelProfiles: {
          balanced: "test/profile-model",
        },
      },
    } as any);
    const resolveAgentModel = vi.fn(async () => ({
      model: {
        id: "profile-model",
        provider: "test",
        aiModel: "test-model",
        contextWindow: 100_000,
        maxTokens: 1024,
      },
      providerOptions: undefined,
    }));
    deps.resolveAgentModel = resolveAgentModel;
    const executor = vi.fn(async (_name: string, args: Record<string, unknown>) =>
      `ran ${args.command}`
    );
    deps.resolveAgentTools = async () => ({ tools: [], executor });
    deps.runToolMiddleware = createRunToolMiddleware(new RuntimeGuardrailEngine([{
      id: "rewrite-command",
      phases: ["tool.before"],
      evaluate: () => ({
        action: "rewrite",
        risk: "low",
        reason: "canonical command",
        value: { command: "echo guarded" },
      }),
    }]));

    const app = completionRoutes(() => deps);
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "coder",
        messages: [{ role: "user", content: "run it" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(resolveAgentModel).toHaveBeenCalledWith(
      expect.objectContaining({ model: "test/profile-model" }),
      undefined,
    );
    expect(executor).toHaveBeenCalledOnce();
    expect(executor).toHaveBeenCalledWith(
      "bash",
      { command: "echo guarded" },
      { callId: "call_bash", signal: expect.any(AbortSignal) },
    );
    const json = await res.json() as any;
    expect(json.choices[0].message.content).toBe("done");
  });

  it("streams tool calls made inside an agent loop step before the macro step completes", async () => {
    streamTextMock
      .mockReturnValueOnce(mockStreamResult({
        parts: [
          { type: "tool-input-start", id: "call_bash", toolName: "bash" },
          { type: "tool-input-delta", id: "call_bash", delta: "{\"command\":" },
          { type: "tool-input-delta", id: "call_bash", delta: "\"echo hello\"}" },
          { type: "tool-input-end", id: "call_bash" },
          { type: "tool-call", toolCallId: "call_bash", toolName: "bash", input: { command: "echo hello" } },
        ],
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
        providerMetadata: undefined,
        toolCalls: [{
          toolCallId: "call_bash",
          toolName: "bash",
          input: { command: "echo hello" },
        }],
        toolResults: [],
        responseMessages: [{
          role: "assistant",
          content: [{
            type: "tool-call",
            toolCallId: "call_bash",
            toolName: "bash",
            input: { command: "echo hello" },
          }],
        }],
      }))
      .mockReturnValueOnce(mockStreamResult({
        text: "done",
        usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
        providerMetadata: undefined,
        toolCalls: [],
        toolResults: [],
        responseMessages: [{
          role: "assistant",
          content: "done",
        }],
      }));

    const app = completionRoutes(() => makeDeps());
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "coder",
        loop: "coding-loop",
        stream: true,
        messages: [{ role: "user", content: "change the app" }],
      }),
    });

    expect(res.status).toBe(200);
    const chunks = parseSseJsonChunks(await res.text());
    const toolEvents = chunks
      .map((chunk) => chunk.choices?.[0]?.tool_call)
      .filter(Boolean);

    expect(toolEvents).toEqual([
      expect.objectContaining({ name: "loop:implement", state: "calling" }),
      expect.objectContaining({ id: "call_bash", name: "bash", state: "preparing" }),
      expect.objectContaining({ id: "call_bash", name: "bash", state: "preparing", argumentsDelta: "{\"command\":" }),
      expect.objectContaining({ id: "call_bash", name: "bash", state: "preparing", argumentsDelta: "\"echo hello\"}" }),
      expect.objectContaining({ id: "call_bash", name: "bash", arguments: { command: "echo hello" }, state: "calling" }),
      expect.objectContaining({ id: "call_bash", name: "bash", result: "ran echo hello", state: "completed" }),
      expect.objectContaining({ name: "loop:implement", state: "completed" }),
    ]);
  });
});
