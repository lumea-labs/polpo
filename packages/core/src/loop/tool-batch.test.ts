import { describe, expect, it } from "vitest";
import { executeToolBatch } from "./tool-batch.js";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("executeToolBatch", () => {
  it("executes serially when parallel execution is omitted", async () => {
    let active = 0;
    let maxActive = 0;

    const results = await executeToolBatch({
      calls: [{ name: "read_one" }, { name: "read_two" }],
      execute: async (call) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(5);
        active -= 1;
        return call.name;
      },
      onError: (error) => `Error: ${String(error)}`,
    });

    expect(results).toEqual(["read_one", "read_two"]);
    expect(maxActive).toBe(1);
  });

  it("executes read-only calls concurrently when explicitly enabled", async () => {
    let active = 0;
    let maxActive = 0;

    const results = await executeToolBatch({
      calls: [{ name: "read_one" }, { name: "list_two" }, { name: "fetch_three" }],
      parallel: true,
      execute: async (call) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(10);
        active -= 1;
        return call.name;
      },
      onError: (error) => `Error: ${String(error)}`,
    });

    expect(results).toEqual(["read_one", "list_two", "fetch_three"]);
    expect(maxActive).toBeGreaterThan(1);
  });

  it("falls back to serial execution when any call writes or is unknown", async () => {
    for (const calls of [
      [{ name: "read_one" }, { name: "write_two" }],
      [{ name: "read_one" }, { name: "opaque_two" }],
    ]) {
      let active = 0;
      let maxActive = 0;
      await executeToolBatch({
        calls,
        parallel: true,
        execute: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await delay(5);
          active -= 1;
          return "ok";
        },
        onError: (error) => `Error: ${String(error)}`,
      });
      expect(maxActive).toBe(1);
    }
  });

  it("bounds concurrency and preserves input order", async () => {
    let active = 0;
    let maxActive = 0;
    const calls = Array.from({ length: 7 }, (_, index) => ({
      name: `read_${index}`,
      index,
    }));

    const results = await executeToolBatch({
      calls,
      parallel: true,
      maxConcurrency: 2,
      execute: async (call) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay((calls.length - call.index) * 2);
        active -= 1;
        return call.index;
      },
      onError: () => -1,
    });

    expect(maxActive).toBe(2);
    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("normalizes each thrown error without dropping sibling results", async () => {
    const results = await executeToolBatch({
      calls: [{ name: "read_ok" }, { name: "read_bad" }, { name: "read_after" }],
      parallel: true,
      execute: async (call) => {
        if (call.name === "read_bad") throw new Error("boom");
        return call.name;
      },
      onError: (error, call) => `Error: ${call.name}: ${(error as Error).message}`,
    });

    expect(results).toEqual([
      "read_ok",
      "Error: read_bad: boom",
      "read_after",
    ]);
  });

  it("does not start queued calls after cancellation", async () => {
    const controller = new AbortController();
    const started: string[] = [];

    const results = await executeToolBatch({
      calls: [{ name: "read_one" }, { name: "read_two" }, { name: "read_three" }],
      parallel: true,
      maxConcurrency: 1,
      signal: controller.signal,
      execute: async (call) => {
        started.push(call.name);
        controller.abort(new Error("cancelled"));
        return "started";
      },
      onError: (error) => `Error: ${(error as Error).message}`,
    });

    expect(started).toEqual(["read_one"]);
    expect(results).toEqual([
      "started",
      "Error: cancelled",
      "Error: cancelled",
    ]);
  });

  it("rejects invalid concurrency limits before executing tools", async () => {
    await expect(executeToolBatch({
      calls: [{ name: "read_one" }],
      parallel: true,
      maxConcurrency: 0,
      execute: async () => "unused",
      onError: () => "unused",
    })).rejects.toThrow("maxConcurrency must be a positive safe integer");
  });
});
