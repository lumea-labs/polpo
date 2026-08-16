// @vitest-environment jsdom
import React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
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

  it("rehydrates active suggestions from the latest assistant message", async () => {
    const suggestion = {
      id: "suggestion_resume",
      label: "Resume",
      prompt: "Resume the previous work.",
    };
    const messages = [
      { id: "user-1", role: "user" as const, content: "Start", ts: "2026-08-15T10:00:00.000Z" },
      {
        id: "assistant-1",
        role: "assistant" as const,
        content: "Ready.",
        ts: "2026-08-15T10:00:01.000Z",
        suggestions: [suggestion],
      },
    ];
    const client = createMockClient({
      getSessionMessages: vi.fn().mockResolvedValue({ messages }),
    });
    const wrapper = createWrapper(client, createMockStore());
    const onSuggestions = vi.fn();
    const { result } = renderHook(
      () => useChat({ sessionId: "session-1", onSuggestions }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.status).toBe("idle"));

    expect(result.current.messages).toEqual(messages);
    expect(result.current.suggestions).toEqual([suggestion]);
    expect(onSuggestions).toHaveBeenCalledOnce();
    expect(onSuggestions).toHaveBeenCalledWith([suggestion]);
  });

  it("does not reactivate historical suggestions after a newer user message", async () => {
    const suggestion = {
      id: "suggestion_stale",
      label: "Continue",
      prompt: "Continue.",
    };
    const messages = [
      {
        id: "assistant-1",
        role: "assistant" as const,
        content: "Ready.",
        ts: "2026-08-15T10:00:00.000Z",
        suggestions: [suggestion],
      },
      { id: "user-2", role: "user" as const, content: "Different request", ts: "2026-08-15T10:00:01.000Z" },
    ];
    const client = createMockClient({
      getSessionMessages: vi.fn().mockResolvedValue({ messages }),
    });
    const wrapper = createWrapper(client, createMockStore());
    const onSuggestions = vi.fn();
    const { result } = renderHook(
      () => useChat({ sessionId: "session-1", onSuggestions }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.status).toBe("idle"));

    expect(result.current.messages).toEqual(messages);
    expect(result.current.messages[0]?.suggestions).toEqual([suggestion]);
    expect(result.current.suggestions).toEqual([]);
    expect(onSuggestions).not.toHaveBeenCalled();
  });

  it("replaces active suggestions when switching sessions", async () => {
    const firstSuggestion = {
      id: "suggestion_first",
      label: "First",
      prompt: "Use the first suggestion.",
    };
    const secondSuggestion = {
      id: "suggestion_second",
      label: "Second",
      prompt: "Use the second suggestion.",
    };
    const getSessionMessages = vi.fn().mockImplementation(async (sessionId: string) => ({
      messages: [{
        id: `${sessionId}-assistant`,
        role: "assistant" as const,
        content: "Ready.",
        ts: "2026-08-15T10:00:00.000Z",
        suggestions: sessionId === "session-1" ? [firstSuggestion] : [secondSuggestion],
      }],
    }));
    const client = createMockClient({ getSessionMessages });
    const wrapper = createWrapper(client, createMockStore());
    const { result } = renderHook(() => useChat(), { wrapper });

    await act(async () => {
      await result.current.setSessionId("session-1");
    });
    expect(result.current.suggestions).toEqual([firstSuggestion]);

    await act(async () => {
      await result.current.setSessionId("session-2");
    });
    expect(result.current.suggestions).toEqual([secondSuggestion]);
  });

  it("clears active suggestions when loading another session fails", async () => {
    const suggestion = {
      id: "suggestion_existing",
      label: "Existing",
      prompt: "Use the existing suggestion.",
    };
    const getSessionMessages = vi.fn()
      .mockResolvedValueOnce({
        messages: [{
          id: "assistant-1",
          role: "assistant" as const,
          content: "Ready.",
          ts: "2026-08-15T10:00:00.000Z",
          suggestions: [suggestion],
        }],
      })
      .mockRejectedValueOnce(new Error("session unavailable"));
    const client = createMockClient({ getSessionMessages });
    const wrapper = createWrapper(client, createMockStore());
    const { result } = renderHook(() => useChat(), { wrapper });

    await act(async () => {
      await result.current.setSessionId("session-1");
    });
    expect(result.current.suggestions).toEqual([suggestion]);

    await act(async () => {
      await result.current.setSessionId("session-2");
    });
    expect(result.current.messages).toEqual([]);
    expect(result.current.suggestions).toEqual([]);
  });
});
