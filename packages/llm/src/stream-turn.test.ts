import { describe, expect, it } from "vitest";
import { jsonSchema, Output } from "ai";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import {
  prepareModelMessagesForProvider,
  normalizeResponseMessagesForHistory,
  streamModelTurn,
  type ModelTurnEvent,
} from "./stream-turn.js";

function usage() {
  return {
    inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 5, text: undefined, reasoning: undefined },
  };
}

function mockModel(parts: unknown[]) {
  return new MockLanguageModelV3({
    doGenerate: {
      content: [{ type: "text", text: "unused" }],
      finishReason: { unified: "stop", raw: undefined },
      usage: usage(),
      warnings: [],
    },
    doStream: {
      stream: convertArrayToReadableStream(parts as any[]),
    },
  });
}

describe("streamModelTurn", () => {
  it("only sends active tools to the model provider", async () => {
    let providerTools: Array<{ name: string }> | undefined;
    const model = new MockLanguageModelV3({
      doGenerate: {
        content: [{ type: "text", text: "unused" }],
        finishReason: { unified: "stop", raw: undefined },
        usage: usage(),
        warnings: [],
      },
      doStream: async (options) => {
        providerTools = options.tools;
        return {
          stream: convertArrayToReadableStream([
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "txt_1" },
            { type: "text-delta", id: "txt_1", delta: "ok" },
            { type: "text-end", id: "txt_1" },
            { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: usage() },
          ] as any[]),
        };
      },
    });

    await streamModelTurn({
      model,
      messages: [{ role: "user", content: "Use the loaded tool" }],
      tools: {
        tool_search: {
          description: "Search tools",
          inputSchema: jsonSchema({ type: "object", properties: {} }),
        },
        hidden_tool: {
          description: "Must stay hidden",
          inputSchema: jsonSchema({ type: "object", properties: {} }),
        },
      },
      activeTools: ["tool_search"],
    });

    expect(providerTools?.map((tool) => tool.name)).toEqual(["tool_search"]);
  });

  it("normalizes no-argument tool calls before they are stored in history", () => {
    const messages = normalizeResponseMessagesForHistory([
      {
        role: "assistant",
        content: [
          { type: "text", text: "I will inspect tools." },
          { type: "tool-call", toolCallId: "call_1", toolName: "skill_list" },
          { type: "tool-call", toolCallId: "call_2", toolName: "tool_list", input: null },
          { type: "tool-call", toolCallId: "call_3", toolName: "search", input: { query: "x" } },
        ],
      },
    ]);

    expect(messages[0]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "I will inspect tools." },
        { type: "tool-call", toolCallId: "call_1", toolName: "skill_list", input: {} },
        { type: "tool-call", toolCallId: "call_2", toolName: "tool_list", input: {} },
        { type: "tool-call", toolCallId: "call_3", toolName: "search", input: { query: "x" } },
      ],
    });
  });

  it("canonicalizes compatible tool-call argument shapes without mutating history", () => {
    const input = [{
      role: "assistant",
      content: [
        { type: "tool_call", id: "call_1", name: "bash", arguments: "{\"command\":\"pwd\"}" },
        { type: "tool-call", toolCallId: "call_2", toolName: "tool_list", args: null },
      ],
    }];

    const normalized = normalizeResponseMessagesForHistory(input);

    expect(normalized).toEqual([{
      role: "assistant",
      content: [
        expect.objectContaining({
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "bash",
          input: { command: "pwd" },
        }),
        expect.objectContaining({
          type: "tool-call",
          toolCallId: "call_2",
          toolName: "tool_list",
          input: {},
        }),
      ],
    }]);
    expect(input[0]?.content[0]).not.toHaveProperty("input");
  });

  it("canonicalizes raw OpenAI tool-call history at the provider boundary", () => {
    const normalized = prepareModelMessagesForProvider([
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "bash", arguments: "{\"command\":\"pwd\"}" },
        }],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: "/workspace",
      },
    ]);

    expect(normalized).toEqual([
      {
        role: "assistant",
        content: [expect.objectContaining({
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "bash",
          input: { command: "pwd" },
        })],
      },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "call_1",
          toolName: "bash",
          output: { type: "text", value: "/workspace" },
        }],
      },
    ]);
  });

  it("repairs partial parallel tool results before the next provider turn", () => {
    const messages = prepareModelMessagesForProvider([
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "call_ok", toolName: "bash", input: { command: "pwd" } },
          { type: "tool-call", toolCallId: "call_missing", toolName: "tool_list" },
        ],
      },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "call_ok",
          toolName: "bash",
          output: { type: "text", value: "/workspace" },
        }],
      },
      { role: "user", content: "Continue" },
    ] as any);

    expect(messages).toEqual([
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "call_ok", toolName: "bash", input: { command: "pwd" } },
          { type: "tool-call", toolCallId: "call_missing", toolName: "tool_list", input: {} },
        ],
      },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "call_ok",
          toolName: "bash",
          output: { type: "text", value: "/workspace" },
        }],
      },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "call_missing",
          toolName: "tool_list",
          output: {
            type: "error-text",
            value: "Tool result unavailable: the prior execution did not return a result.",
          },
        }],
      },
      { role: "user", content: "Continue" },
    ]);
  });

  it("drops irrecoverable calls and orphan results while preserving provider-executed results", () => {
    const messages = prepareModelMessagesForProvider([
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "", toolName: "bash", input: { command: "pwd" } },
          { type: "tool-call", toolCallId: "provider_1", toolName: "web_search", input: { query: "Polpo" }, providerExecuted: true },
          {
            type: "tool-result",
            toolCallId: "provider_1",
            toolName: "web_search",
            output: { type: "text", value: "result" },
            providerExecuted: true,
          },
        ],
      },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "orphan",
          toolName: "unknown",
          output: { type: "text", value: "ignore" },
        }],
      },
    ] as any);

    expect(messages).toEqual([{
      role: "assistant",
      content: [
        expect.objectContaining({
          type: "tool-call",
          toolCallId: "provider_1",
          toolName: "web_search",
          input: { query: "Polpo" },
        }),
        expect.objectContaining({
          type: "tool-result",
          toolCallId: "provider_1",
          toolName: "web_search",
        }),
      ],
    }]);
  });

  it("is idempotent when provider history is already valid", () => {
    const history = [
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call_1", toolName: "bash", input: { command: "pwd" } }],
      },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "call_1",
          toolName: "bash",
          output: { type: "text", value: "/workspace" },
        }],
      },
    ] as any;

    const once = prepareModelMessagesForProvider(history);
    expect(prepareModelMessagesForProvider(once)).toEqual(once);
  });

  it("treats an approval response as a resolved tool call", async () => {
    const history = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "call_1", toolName: "bash", input: { command: "pwd" } },
          { type: "tool-approval-request", approvalId: "approval_1", toolCallId: "call_1" },
        ],
      },
      {
        role: "tool",
        content: [{ type: "tool-approval-response", approvalId: "approval_1", approved: false }],
      },
      { role: "user", content: "Use another approach" },
    ] as any;

    const prepared = prepareModelMessagesForProvider(history);

    expect(prepared).toEqual(history);
    expect(JSON.stringify(prepared)).not.toContain("Tool result unavailable");
  });

  it("uses the matching call name for legacy tool results", () => {
    const prepared = prepareModelMessagesForProvider([
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call_1", toolName: "bash", input: { command: "pwd" } }],
      },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "call_1",
          toolName: "unknown",
          output: "/workspace",
        }],
      },
    ] as any);

    expect((prepared[1] as any).content[0]).toEqual({
      type: "tool-result",
      toolCallId: "call_1",
      toolName: "bash",
      output: { type: "text", value: "/workspace" },
    });
  });

  it("never sends missing arguments or missing tool results to the model provider", async () => {
    let providerPrompt: unknown;
    const model = new MockLanguageModelV3({
      doGenerate: {
        content: [{ type: "text", text: "unused" }],
        finishReason: { unified: "stop", raw: undefined },
        usage: usage(),
        warnings: [],
      },
      doStream: async (options) => {
        providerPrompt = options.prompt;
        return {
          stream: convertArrayToReadableStream([
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "txt_1" },
            { type: "text-delta", id: "txt_1", delta: "Recovered" },
            { type: "text-end", id: "txt_1" },
            { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: usage() },
          ] as any[]),
        };
      },
    });

    await streamModelTurn({
      model,
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "call_1", toolName: "tool_list" }],
        },
        { role: "user", content: "Continue" },
      ] as any,
      tools: {
        tool_list: {
          description: "List tools",
          inputSchema: jsonSchema({ type: "object", properties: {} }),
        },
      },
    });

    expect(providerPrompt).toEqual([
      {
        role: "assistant",
        content: [expect.objectContaining({
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "tool_list",
          input: {},
        })],
      },
      {
        role: "tool",
        content: [expect.objectContaining({
          type: "tool-result",
          toolCallId: "call_1",
          toolName: "tool_list",
        })],
      },
      { role: "user", content: [{ type: "text", text: "Continue" }] },
    ]);
  });

  it("streams text events and returns response messages", async () => {
    const events: ModelTurnEvent[] = [];
    const model = mockModel([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "txt_1" },
      { type: "text-delta", id: "txt_1", delta: "Hello" },
      { type: "text-delta", id: "txt_1", delta: " world" },
      { type: "text-end", id: "txt_1" },
      { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: usage() },
    ]);

    const result = await streamModelTurn({
      model,
      messages: [{ role: "user", content: "Say hello" }],
    }, (event) => {
      events.push(event);
    });

    expect(result.text).toBe("Hello world");
    expect(events).toEqual([
      { type: "text-delta", id: "txt_1", text: "Hello" },
      { type: "text-delta", id: "txt_1", text: " world" },
      expect.objectContaining({ type: "finish", finishReason: "stop" }),
    ]);
    expect(result.toolCalls).toEqual([]);
    expect(result.responseMessages.length).toBeGreaterThan(0);
  });

  it("streams tool input deltas before the completed tool call", async () => {
    const events: ModelTurnEvent[] = [];
    const model = mockModel([
      { type: "stream-start", warnings: [] },
      { type: "tool-input-start", id: "call_1", toolName: "bash" },
      { type: "tool-input-delta", id: "call_1", delta: "{\"command\":" },
      { type: "tool-input-delta", id: "call_1", delta: "\"pwd\"}" },
      { type: "tool-input-end", id: "call_1" },
      { type: "tool-call", toolCallId: "call_1", toolName: "bash", input: "{\"command\":\"pwd\"}" },
      { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage: usage() },
    ]);

    const result = await streamModelTurn({
      model,
      messages: [{ role: "user", content: "Run pwd" }],
      tools: {
        bash: {
          description: "Run a shell command",
          inputSchema: jsonSchema({
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
          }),
        },
      },
    }, (event) => {
      events.push(event);
    });

    expect(events).toEqual([
      { type: "tool-input-start", id: "call_1", name: "bash", providerExecuted: undefined, dynamic: false, title: undefined },
      { type: "tool-input-delta", id: "call_1", delta: "{\"command\":" },
      { type: "tool-input-delta", id: "call_1", delta: "\"pwd\"}" },
      { type: "tool-input-end", id: "call_1" },
      { type: "tool-call", id: "call_1", name: "bash", args: { command: "pwd" }, providerExecuted: undefined, dynamic: undefined },
      expect.objectContaining({ type: "finish", finishReason: "tool-calls" }),
    ]);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.toolName).toBe("bash");
    expect(result.toolCalls[0]?.input).toEqual({ command: "pwd" });
    expect(result.responseMessages.length).toBeGreaterThan(0);
  });

  it("normalizes no-argument tool calls returned by the stream result", async () => {
    const model = mockModel([
      { type: "stream-start", warnings: [] },
      { type: "tool-call", toolCallId: "call_1", toolName: "tool_list", input: undefined },
      { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage: usage() },
    ]);

    const result = await streamModelTurn({
      model,
      messages: [{ role: "user", content: "List tools" }],
      tools: {
        tool_list: {
          description: "List available tools",
          inputSchema: jsonSchema({
            type: "object",
            properties: {},
            additionalProperties: false,
          }),
        },
      },
    });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.toolName).toBe("tool_list");
    expect(result.toolCalls[0]?.input).toEqual({});
  });

  it("preserves invalid tool-call metadata in events and results", async () => {
    const events: ModelTurnEvent[] = [];
    const model = mockModel([
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
        usage: usage(),
      },
    ]);

    const result = await streamModelTurn({
      model,
      messages: [{ role: "user", content: "Calculate." }],
      tools: {
        calculate: {
          description: "Calculate a target",
          inputSchema: jsonSchema(
            {
              type: "object",
              properties: { target: { type: "number" } },
              required: ["target"],
            },
            {
              validate: (value) => ({
                success: false,
                error: new Error(`Rejected ${JSON.stringify(value)}`),
              }),
            },
          ),
        },
      },
    }, (event) => {
      events.push(event);
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool-call",
        id: "call_invalid",
        invalid: true,
        error: expect.any(Error),
      }),
    );
    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        toolCallId: "call_invalid",
        invalid: true,
        error: expect.any(Error),
      }),
    ]);
  });

  it("returns a schema-validated structured output", async () => {
    const model = mockModel([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "txt_1" },
      { type: "text-delta", id: "txt_1", delta: '{"name":"Ada","plan":"pro"}' },
      { type: "text-end", id: "txt_1" },
      { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: usage() },
    ]);

    const result = await streamModelTurn({
      model,
      messages: [{ role: "user", content: "Create a profile" }],
      output: Output.object({
        schema: jsonSchema(
          {
            type: "object",
            properties: {
              name: { type: "string" },
              plan: { type: "string", enum: ["free", "pro"] },
            },
            required: ["name", "plan"],
            additionalProperties: false,
          },
          {
            validate: (value) => value && typeof value === "object" && (value as any).plan === "pro"
              ? { success: true, value }
              : { success: false, error: new Error("invalid profile") },
          },
        ),
        name: "user_profile",
      }),
    });

    expect(result.output).toEqual({ name: "Ada", plan: "pro" });
    expect(result.text).toBe('{"name":"Ada","plan":"pro"}');
  });

  it("does not parse a structured output on an intermediate tool-call turn", async () => {
    const model = mockModel([
      { type: "stream-start", warnings: [] },
      { type: "tool-call", toolCallId: "call_1", toolName: "lookup", input: "{}" },
      { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage: usage() },
    ]);

    const result = await streamModelTurn({
      model,
      messages: [{ role: "user", content: "Look it up" }],
      tools: {
        lookup: {
          description: "Lookup data",
          inputSchema: jsonSchema({ type: "object", properties: {} }),
        },
      },
      output: Output.object({
        schema: jsonSchema({
          type: "object",
          properties: { answer: { type: "string" } },
          required: ["answer"],
        }),
      }),
    });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.output).toBeUndefined();
  });
});
