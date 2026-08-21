import { describe, expect, it, vi } from "vitest";
import { executeCompletionToolBatch } from "./tool-execution-batch.js";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("executeCompletionToolBatch", () => {
  it("runs eligible calls concurrently and returns stable ordered results", async () => {
    let active = 0;
    let maxActive = 0;
    const calling: string[] = [];
    const executor = vi.fn(async (name: string) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(name === "read_slow" ? 15 : 2);
      active -= 1;
      return `${name}:done`;
    });

    const results = await executeCompletionToolBatch({
      calls: [
        { toolCallId: "slow", toolName: "read_slow", input: {} },
        { toolCallId: "fast", toolName: "list_fast", input: {} },
      ],
      executor,
      onCalling: (call) => { calling.push(call.toolCallId); },
    });

    expect(maxActive).toBe(2);
    expect(calling).toEqual(["slow", "fast"]);
    expect(results.map((result) => result.toolCallId)).toEqual(["slow", "fast"]);
    expect(results.map((result) => result.result)).toEqual([
      "read_slow:done",
      "list_fast:done",
    ]);
  });

  it("normalizes a thrown executor failure as that call's result", async () => {
    const results = await executeCompletionToolBatch({
      calls: [
        { toolCallId: "ok", toolName: "read_ok", input: {} },
        { toolCallId: "bad", toolName: "read_bad", input: {} },
      ],
      executor: async (name) => {
        if (name === "read_bad") throw new Error("provider unavailable");
        return "ok";
      },
    });

    expect(results).toMatchObject([
      { toolCallId: "ok", result: "ok", isError: false },
      { toolCallId: "bad", result: "Error: provider unavailable", isError: true },
    ]);
  });
});
