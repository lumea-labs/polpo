import { describe, expect, it, vi } from "vitest";
import { InMemoryToolExecutionReceiptStore, ToolReceiptSettlementError } from "@polpo-ai/core";
import { createScriptedHookRuntime } from "@polpo-ai/core/runtime-hooks";
import { createGuardedCompletionToolExecutor } from "./tool-guardrails.js";
import { createRuntimeHookedToolExecutor } from "./runtime-hooks.js";
import { executeCompletionToolBatch } from "./tool-execution-batch.js";

describe("durable tool output under faults", () => {
  it("returns exactly the canonical persisted result on execution and replay", async () => {
    const executor = vi.fn(async () => "<html>reference\u0000page</html>");
    const receipts = new InMemoryToolExecutionReceiptStore();
    const guarded = createGuardedCompletionToolExecutor({ executor, tools: [{ name: "http_fetch" }], context: {}, receiptStore: receipts });
    const first = await guarded("http_fetch", {}, { callId: "call-real-null" });
    const replay = await guarded("http_fetch", {}, { callId: "call-real-null" });
    expect(first).toBe("<html>reference\\u0000page</html>");
    expect(replay).toBe(first);
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it("does not swallow uncertain durability as a recoverable model-facing tool error", async () => {
    const failure = new ToolReceiptSettlementError(3, Object.assign(new Error("SQL secret payload"), { code: "22021" }));
    const executor = vi.fn(async () => { throw failure; });
    await expect(executeCompletionToolBatch({ calls: [
      { toolName: "publish_site", toolCallId: "one", input: {} },
      { toolName: "charge_card", toolCallId: "two", input: {} },
    ], executor })).rejects.toBe(failure);
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it("still returns ordinary tool failures to the agent for correction", async () => {
    const result = await executeCompletionToolBatch({ calls: [{ toolName: "read", toolCallId: "missing", input: {} }], executor: async () => { throw new Error("file not found"); } });
    expect(result[0]).toMatchObject({ isError: true, result: "Error: file not found" });
  });

  it("normalizes a hook-rewritten result before it reaches persistence", async () => {
    const execute = createRuntimeHookedToolExecutor({
      executor: async () => "original",
      hooks: {
        surface: "chat",
        runtime: createScriptedHookRuntime({
          hooks: { PostToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: "rewrite" }] }] },
          respond: () => ({
            stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: "a\u0000b\ud800" } }),
          }),
        }),
      },
    });
    expect(await execute("read", {}, { callId: "c1" })).toBe("a\\u0000b\\ud800");
  });
});
