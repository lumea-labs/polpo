import { describe, expect, it } from "vitest";
import { chatToItems } from "./trace-detail.js";

describe("chatToItems reasoning", () => {
  it("projects persisted reasoning as a separate trace payload", () => {
    expect(chatToItems([{
      id: "assistant-1",
      role: "assistant",
      content: "Done.",
      reasoning: "Checked the constraints.",
      reasoningTruncated: true,
    }])[0]).toMatchObject({
      body: "Done.",
      payload: [{
        label: "reasoning (truncated)",
        value: "Checked the constraints.",
        format: "markdown",
      }],
    });
  });
});
