// @vitest-environment jsdom
import React from "react";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useChat } from "../hooks/use-chat.js";
import { createMockClient, createMockStore, createWrapper } from "./helpers.js";

describe("useChat interactions", () => {
  it("declares supported capabilities and attaches suggestions to the response", async () => {
    const suggestion = {
      id: "suggestion_tests",
      label: "Add tests",
      prompt: "Add tests for this change.",
    };
    const stream = {
      sessionId: "session-1",
      abort: vi.fn(),
      async *[Symbol.asyncIterator]() {
        yield {
          id: "chatcmpl-1",
          object: "chat.completion.chunk",
          created: 1,
          model: "polpo",
          choices: [{ index: 0, delta: { content: "Done" }, finish_reason: null }],
        };
        yield {
          id: "chatcmpl-1",
          object: "chat.completion.chunk",
          created: 1,
          model: "polpo",
          choices: [{ index: 0, delta: {}, finish_reason: null }],
          polpo: { suggestions: [suggestion] },
        };
      },
    };
    const chatCompletionsStream = vi.fn().mockReturnValue(stream);
    const client = createMockClient({ chatCompletionsStream });
    const wrapper = createWrapper(client, createMockStore());
    const onSuggestions = vi.fn();
    const { result } = renderHook(() => useChat({ onSuggestions }), { wrapper });

    await act(async () => {
      await result.current.sendMessage("Implement it");
    });

    expect(chatCompletionsStream).toHaveBeenCalledWith(expect.objectContaining({
      polpo: {
        capabilities: {
          ask_user_question: true,
          suggestions: true,
        },
      },
    }));
    expect(result.current.suggestions).toEqual([suggestion]);
    expect(result.current.messages.at(-1)?.suggestions).toEqual([suggestion]);
    expect(onSuggestions).toHaveBeenCalledWith([suggestion]);
  });
});
