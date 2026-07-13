import { describe, expect, it } from "vitest";
import { convertMessages } from "./message-mapping.js";

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
});
