import { describe, expect, it } from "vitest";
import { appendModelResponseMessages, convertMessages } from "./message-mapping.js";

describe("convertMessages", () => {
  it("drops empty text blocks before sending messages to a provider", () => {
    const { aiMessages, extraSystemParts } = convertMessages([
      { role: "system", content: [{ type: "text", text: "  " }] },
      { role: "user", content: [{ type: "text", text: "" }] },
      { role: "assistant", content: "   " },
      { role: "user", content: [{ type: "text", text: "hello" }, { type: "text", text: " " }] },
    ] as any);

    expect(extraSystemParts).toEqual([]);
    expect(aiMessages).toEqual([{ role: "user", content: "hello" }]);
  });

  it("keeps tool-result structure but replaces an empty tool payload", () => {
    const { aiMessages } = convertMessages([{
      role: "tool",
      tool_call_id: "call_1",
      name: "ask_user_question",
      content: "",
    }] as any);

    expect(aiMessages).toEqual([{
      role: "tool",
      content: [{
        type: "tool-result",
        toolCallId: "call_1",
        toolName: "ask_user_question",
        output: { type: "text", value: "(empty tool result)" },
      }],
    }]);
  });

  it("normalizes fallback assistant tool-call input to an empty object", async () => {
    const messages: any[] = [];

    await appendModelResponseMessages(
      messages,
      { responseMessages: Promise.resolve([]) },
      "",
      [{ toolCallId: "call_1", toolName: "tool_list" }],
    );

    expect(messages).toEqual([{
      role: "assistant",
      content: [{
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "tool_list",
        input: {},
      }],
    }]);
  });

  it("normalizes response assistant tool-call input before appending history", async () => {
    const messages: any[] = [];

    await appendModelResponseMessages(
      messages,
      {
        responseMessages: Promise.resolve([{
          role: "assistant",
          content: [
            { type: "text", text: "I will inspect tools." },
            { type: "tool-call", toolCallId: "call_1", toolName: "tool_list" },
            { type: "tool-call", toolCallId: "call_2", toolName: "skill_list", input: null },
            { type: "tool-call", toolCallId: "call_3", toolName: "search", input: { query: "slack" } },
          ],
        }]),
      },
      "",
      [],
    );

    expect(messages).toEqual([{
      role: "assistant",
      content: [
        { type: "text", text: "I will inspect tools." },
        { type: "tool-call", toolCallId: "call_1", toolName: "tool_list", input: {} },
        { type: "tool-call", toolCallId: "call_2", toolName: "skill_list", input: {} },
        { type: "tool-call", toolCallId: "call_3", toolName: "search", input: { query: "slack" } },
      ],
    }]);
  });

  it("normalizes client assistant tool_calls arguments to objects", () => {
    const { aiMessages } = convertMessages([{
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "tool_list", arguments: "" } },
        { id: "call_2", type: "function", function: { name: "skill_list", arguments: "[]" } },
        { id: "call_3", type: "function", function: { name: "search", arguments: "{\"query\":\"slack\"}" } },
      ],
    }] as any);

    expect(aiMessages).toEqual([{
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "call_1", toolName: "tool_list", input: {} },
        { type: "tool-call", toolCallId: "call_2", toolName: "skill_list", input: {} },
        { type: "tool-call", toolCallId: "call_3", toolName: "search", input: { query: "slack" } },
      ],
    }]);
  });
});
