import { describe, expect, it } from "vitest";
import {
  SessionContinuationError,
  projectResolvedClientToolCalls,
  requestClientToolsForContinuation,
  resolvePendingClientToolCall,
} from "./session-continuation.js";
import type { Message } from "./session-store.js";

function message(input: Partial<Message> & Pick<Message, "role">): Message {
  const { id, content, ts, ...rest } = input;
  return {
    ...rest,
    id: id ?? crypto.randomUUID(),
    content: content ?? "",
    ts: ts ?? new Date().toISOString(),
  };
}

describe("session client-tool continuation", () => {
  it("resolves the latest unresolved client tool call", () => {
    const messages = [
      message({ role: "user", content: "Build a site" }),
      message({
        role: "assistant",
        toolCalls: [{
          id: "call-1",
          name: "configure_site_module",
          arguments: { module: "booking" },
          state: "interrupted",
        }],
      }),
    ];

    expect(resolvePendingClientToolCall(messages, "call-1")).toMatchObject({
      id: "call-1",
      name: "configure_site_module",
    });
  });

  it("returns a detached continuation catalog and removes it from resolved history", () => {
    const tools = [{
      type: "function" as const,
      function: { name: "apply_site_change" },
    }];
    const messages = [
      message({
        role: "assistant",
        toolCalls: [{
          id: "call-1",
          name: "ask_user_question",
          state: "interrupted",
          continuationClientTools: tools,
        }],
      }),
      message({ role: "tool", toolCallId: "call-1", content: "Use Start now" }),
    ];

    const restored = requestClientToolsForContinuation(messages, "call-1");
    expect(restored).toEqual(tools);
    expect(restored).not.toBe(tools);
    expect(projectResolvedClientToolCalls(messages)[0]?.toolCalls?.[0]).toEqual({
      id: "call-1",
      name: "ask_user_question",
      state: "completed",
      result: "Use Start now",
    });
  });

  it("rejects a call that already has a tool result", () => {
    const messages = [
      message({
        role: "assistant",
        toolCalls: [{ id: "call-1", name: "configure", state: "interrupted" }],
      }),
      message({ role: "tool", toolCallId: "call-1", content: "ok" }),
    ];

    expect(() => resolvePendingClientToolCall(messages, "call-1")).toThrowError(
      expect.objectContaining<Partial<SessionContinuationError>>({
        code: "client_tool_call_not_pending",
      }),
    );
  });

  it("rejects an older unresolved call when a newer one is pending", () => {
    const messages = [
      message({
        role: "assistant",
        toolCalls: [{ id: "call-1", name: "first", state: "interrupted" }],
      }),
      message({
        role: "assistant",
        toolCalls: [{ id: "call-2", name: "second", state: "interrupted" }],
      }),
    ];

    expect(() => resolvePendingClientToolCall(messages, "call-1")).toThrowError(
      expect.objectContaining<Partial<SessionContinuationError>>({
        code: "client_tool_call_not_pending",
      }),
    );
  });

  it("rejects unknown calls without leaking other pending IDs", () => {
    const messages = [
      message({
        role: "assistant",
        toolCalls: [{ id: "secret-call", name: "configure", state: "interrupted" }],
      }),
    ];

    expect(() => resolvePendingClientToolCall(messages, "unknown")).toThrowError(
      expect.objectContaining<Partial<SessionContinuationError>>({
        code: "client_tool_call_not_pending",
        message: "Client tool call is not pending",
      }),
    );
  });
});
