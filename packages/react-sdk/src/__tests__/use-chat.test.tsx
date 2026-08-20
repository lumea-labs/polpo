// @vitest-environment jsdom
import React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useChat } from "../hooks/use-chat.js";
import { createMockClient, createMockStore, createWrapper } from "./helpers.js";

describe("useChat interactions", () => {
  it("reconstructs streamed tool arguments from linear deltas", async () => {
    const onToolCall = vi.fn();
    const stream = {
      abort: vi.fn(),
      async *[Symbol.asyncIterator]() {
        for (const toolCall of [
          { id: "call-1", name: "write", state: "preparing" },
          { id: "call-1", name: "write", state: "preparing", argumentsDelta: "{\"path\":" },
          { id: "call-1", name: "write", state: "preparing", argumentsDelta: "\"file.txt\"}" },
        ]) {
          yield {
            id: "chatcmpl-1",
            object: "chat.completion.chunk",
            created: 1,
            model: "polpo",
            choices: [{ index: 0, delta: {}, tool_call: toolCall, finish_reason: null }],
          };
        }
      },
    };
    const client = createMockClient({
      chatCompletionsStream: vi.fn().mockReturnValue(stream),
    });
    const wrapper = createWrapper(client, createMockStore());
    const { result } = renderHook(() => useChat({ onToolCall }), { wrapper });

    await act(async () => {
      await result.current.sendMessage("Write the file");
    });

    expect(result.current.messages.at(-1)?.toolCalls?.[0]).toEqual(expect.objectContaining({
      id: "call-1",
      argumentsText: "{\"path\":\"file.txt\"}",
    }));
    expect(onToolCall).toHaveBeenLastCalledWith(expect.objectContaining({
      argumentsText: "{\"path\":\"file.txt\"}",
    }));
  });

  it("continues a pending client tool into a durable project loop", async () => {
    const directStream = {
      sessionId: "session-1",
      sessionVersion: 2,
      runId: null,
      lastEventId: null,
      abort: vi.fn(),
      async *[Symbol.asyncIterator]() {
        yield {
          id: "chatcmpl-1",
          object: "chat.completion.chunk",
          created: 1,
          model: "polpo",
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                id: "call-1",
                type: "function",
                function: { name: "configure_site_module", arguments: "{}" },
              }],
            },
            finish_reason: "tool_calls",
          }],
        };
      },
    };
    const loopStream = {
      sessionId: "session-1",
      sessionVersion: 4,
      runId: "chatcmpl-loop",
      lastEventId: "3",
      abort: vi.fn(),
      async *[Symbol.asyncIterator]() {
        yield {
          id: "chatcmpl-loop",
          object: "chat.completion.chunk",
          created: 1,
          model: "polpo",
          choices: [{ index: 0, delta: { content: "Built" }, finish_reason: "stop" }],
        };
      },
    };
    const chatCompletionsStream = vi.fn().mockReturnValue(directStream);
    const continueWithToolResult = vi.fn().mockReturnValue(loopStream);
    const client = createMockClient({ chatCompletionsStream, continueWithToolResult });
    const wrapper = createWrapper(client, createMockStore());
    const { result } = renderHook(() => useChat({ agent: "leo" }), { wrapper });

    await act(async () => {
      await result.current.sendMessage("Build a site");
    });
    expect(result.current.sessionVersion).toBe(2);
    expect(result.current.pendingToolCall?.toolCallId).toBe("call-1");

    await act(async () => {
      await result.current.continueToolResult("call-1", "configured", {
        loop: "build-site",
        idempotencyKey: "continue-1",
      });
    });

    expect(continueWithToolResult).toHaveBeenCalledWith({
      sessionId: "session-1",
      sessionVersion: 2,
      idempotencyKey: "continue-1",
      agent: "leo",
      loop: "build-site",
      toolCallId: "call-1",
      result: "configured",
    });
    expect(result.current.sessionVersion).toBe(4);
    expect(result.current.messages.at(-1)?.content).toBe("Built");
  });

  it("activates assigned skills for one message without making them persistent", async () => {
    const makeStream = () => ({
      abort: vi.fn(),
      async *[Symbol.asyncIterator]() {
        yield {
          id: "chatcmpl-1",
          object: "chat.completion.chunk",
          created: 1,
          model: "polpo",
          choices: [{ index: 0, delta: { content: "Done" }, finish_reason: "stop" }],
        };
      },
    });
    const chatCompletionsStream = vi.fn()
      .mockImplementation(() => makeStream());
    const client = createMockClient({ chatCompletionsStream });
    const wrapper = createWrapper(client, createMockStore());
    const { result } = renderHook(() => useChat({ agent: "builder" }), { wrapper });

    await act(async () => {
      await result.current.sendMessage("Build it", {
        skills: ["frontend-design"],
      });
      await result.current.sendMessage("Summarize it");
    });

    expect(chatCompletionsStream.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        polpo: expect.objectContaining({ skills: ["frontend-design"] }),
      }),
    );
    expect(chatCompletionsStream.mock.calls[1]?.[0].polpo).not.toHaveProperty("skills");
  });

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

  it("opts into durable delivery and detaches without cancelling the run", async () => {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const detach = vi.fn(() => finish());
    const abort = vi.fn();
    const cancel = vi.fn().mockResolvedValue(undefined);
    const stream = {
      runId: "run-1",
      lastEventId: "4",
      sessionId: null,
      detach,
      abort,
      cancel,
      subscribeConnectionState: vi.fn(() => () => {}),
      async *[Symbol.asyncIterator]() {
        await finished;
      },
    };
    const chatCompletionsStream = vi.fn().mockReturnValue(stream);
    const client = createMockClient({ chatCompletionsStream });
    const wrapper = createWrapper(client, createMockStore());
    const { result } = renderHook(() => useChat({ durable: true }), { wrapper });

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.sendMessage("Keep working");
    });
    await waitFor(() => expect(chatCompletionsStream).toHaveBeenCalledOnce());
    act(() => result.current.detach());
    await act(async () => pending);

    expect(chatCompletionsStream).toHaveBeenCalledWith(expect.objectContaining({
      polpo: expect.objectContaining({ delivery: { onDisconnect: "continue" } }),
    }));
    expect(detach).toHaveBeenCalledOnce();
    expect(abort).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(result.current.runId).toBe("run-1");
    expect(result.current.lastEventId).toBe("4");
  });
});
