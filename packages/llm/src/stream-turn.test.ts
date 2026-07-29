import { describe, expect, it } from "vitest";
import { jsonSchema } from "ai";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import {
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
});
