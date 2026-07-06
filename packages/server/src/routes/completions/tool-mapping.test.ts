import { describe, expect, it, vi } from "vitest";
import { persistAssistantMessage } from "./tool-mapping.js";

function fakeStore() {
  return { updateMessage: vi.fn().mockResolvedValue(true) };
}

describe("persistAssistantMessage", () => {
  it("no-ops when the session is not tracked", async () => {
    const store = fakeStore();
    await persistAssistantMessage(undefined, "s1", "m1", "hi", []);
    await persistAssistantMessage(store, null, "m1", "hi", []);
    await persistAssistantMessage(store, "s1", undefined, "hi", []);
    expect(store.updateMessage).not.toHaveBeenCalled();
  });

  it("persists trimmed final text with the tool calls", async () => {
    const store = fakeStore();
    const toolCalls = [{ id: "t1", name: "get_status", arguments: {}, state: "completed" }];
    await persistAssistantMessage(store, "s1", "m1", "  done  ", toolCalls);
    expect(store.updateMessage).toHaveBeenCalledWith("s1", "m1", "done", toolCalls);
  });

  it("falls back to empty string when the model produced no text", async () => {
    const store = fakeStore();
    await persistAssistantMessage(store, "s1", "m1", "   ", []);
    expect(store.updateMessage).toHaveBeenCalledWith("s1", "m1", "", []);
  });

  it("uses the provided emptyFallback for empty text", async () => {
    const store = fakeStore();
    await persistAssistantMessage(store, "s1", "m1", "", [], { emptyFallback: "[Response interrupted]" });
    expect(store.updateMessage).toHaveBeenCalledWith("s1", "m1", "[Response interrupted]", []);
  });

  it("redacts vault credentials before persisting", async () => {
    const store = fakeStore();
    const toolCalls = [
      { id: "t1", name: "set_vault_entry", arguments: { service: "smtp", credentials: { password: "s3cret", user: "bob" } } },
    ];
    await persistAssistantMessage(store, "s1", "m1", "saved", toolCalls);
    const persisted = store.updateMessage.mock.calls[0]![3];
    expect(persisted[0].arguments.credentials).toEqual({ password: "[REDACTED]", user: "[REDACTED]" });
    // original must not be mutated
    expect(toolCalls[0]!.arguments.credentials.password).toBe("s3cret");
  });
});
