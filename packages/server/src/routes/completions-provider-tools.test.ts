import { beforeEach, describe, expect, it, vi } from "vitest";

const { generateTextMock } = vi.hoisted(() => ({
  generateTextMock: vi.fn(),
}));

vi.mock("ai", () => ({
  generateText: generateTextMock,
  streamText: vi.fn(),
  jsonSchema: (schema: unknown) => schema,
}));

import { completionRoutes, type CompletionRouteDeps } from "./completions.js";

function parseSseJsonChunks(body: string): any[] {
  return body
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.startsWith("data: "))
    .map((block) => block.slice("data: ".length))
    .filter((data) => data !== "[DONE]")
    .map((data) => JSON.parse(data));
}

describe("completionRoutes provider-executed tools", () => {
  beforeEach(() => {
    generateTextMock.mockReset();
  });

  function makeDeps(): CompletionRouteDeps {
    return {
      getAgents: async () => [{
        name: "researcher",
        model: "test",
        assignedLoops: ["research-loop"],
        defaultLoop: "research-loop",
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

  it("feeds provider-executed tool results back through AI SDK responseMessages", async () => {
    let secondTurnMessages: any[] | undefined;
    const searchOutput = {
      results: [{ title: "Polpo", url: "https://polpo.sh", snippet: "Agent backend" }],
      id: "search_1",
    };

    generateTextMock
      .mockResolvedValueOnce({
        text: "",
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
      })
      .mockImplementationOnce(async (args: any) => {
        secondTurnMessages = args.messages;
        return {
          text: "Polpo is an agent backend.",
          usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
          providerMetadata: undefined,
          toolCalls: [],
          toolResults: [],
          responseMessages: [{
            role: "assistant",
            content: "Polpo is an agent backend.",
          }],
        };
      });

    const app = completionRoutes(() => makeDeps());
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "researcher",
        messages: [{ role: "user", content: "Research Polpo" }],
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.choices[0].message.content).toBe("Polpo is an agent backend.");
    expect(generateTextMock).toHaveBeenCalledTimes(2);

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
});

describe("completionRoutes loop agent-step tool streaming", () => {
  beforeEach(() => {
    generateTextMock.mockReset();
  });

  function makeDeps(): CompletionRouteDeps {
    return {
      getAgents: async () => [{
        name: "coder",
        model: "test",
        assignedLoops: ["coding-loop"],
        defaultLoop: "coding-loop",
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

  it("streams tool calls made inside an agent loop step before the macro step completes", async () => {
    generateTextMock
      .mockResolvedValueOnce({
        text: "",
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
      })
      .mockResolvedValueOnce({
        text: "done",
        usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
        providerMetadata: undefined,
        toolCalls: [],
        toolResults: [],
        responseMessages: [{
          role: "assistant",
          content: "done",
        }],
      });

    const app = completionRoutes(() => makeDeps());
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "coder",
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
      expect.objectContaining({ id: "call_bash", name: "bash", arguments: { command: "echo hello" }, state: "calling" }),
      expect.objectContaining({ id: "call_bash", name: "bash", result: "ran echo hello", state: "completed" }),
      expect.objectContaining({ name: "loop:implement", state: "completed" }),
    ]);
  });
});
