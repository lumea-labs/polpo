import { describe, expect, it } from "vitest";
import { LoopHookRegistry } from "./hooks.js";
import { LoopRunner } from "./runner.js";

describe("LoopRunner", () => {
  it("runs the implicit loop with ordered lifecycle hooks", async () => {
    const events: string[] = [];
    const hooks = new LoopHookRegistry();
    hooks.register({ hook: "loop:start", phase: "before", handler: () => { events.push("loop:start"); } });
    hooks.register({ hook: "step:before", phase: "before", handler: () => { events.push("step:before"); } });
    hooks.register({ hook: "model:before", phase: "before", handler: () => { events.push("model:before"); } });
    hooks.register({ hook: "step:after", phase: "after", handler: () => { events.push("step:after"); } });
    hooks.register({ hook: "loop:stop", phase: "before", handler: () => { events.push("loop:stop"); } });
    hooks.register({ hook: "loop:end", phase: "after", handler: () => { events.push("loop:end"); } });

    const runner = new LoopRunner(hooks);
    const result = await runner.run({
      loop: { name: "default" },
      model: async () => ({ text: "done" }),
      executeTool: async () => "unused",
    });

    expect(result).toMatchObject({ status: "completed", reason: "completed", turns: 1, text: "done" });
    expect(events).toEqual(["loop:start", "step:before", "model:before", "step:after", "loop:stop", "loop:end"]);
  });

  it("lets step hooks constrain active tools before the model call", async () => {
    const hooks = new LoopHookRegistry();
    hooks.register({
      hook: "step:before",
      phase: "before",
      handler: (ctx) => {
        ctx.data.activeTools = ["read"];
      },
    });

    const seenTools: unknown[] = [];
    const runner = new LoopRunner(hooks);
    await runner.run({
      loop: { name: "plan", tools: ["read", "write"] },
      model: async (input) => {
        seenTools.push(input.activeTools);
        return { text: "planned" };
      },
      executeTool: async () => "unused",
    });

    expect(seenTools).toEqual([["read"]]);
  });

  it("allows tool:before hooks to deny a tool call without invoking the executor", async () => {
    const hooks = new LoopHookRegistry();
    hooks.register({
      hook: "tool:before",
      phase: "before",
      handler: (ctx) => {
        if (ctx.data.toolCall.name === "write") ctx.cancel("read-only loop");
      },
    });

    let executed = false;
    const runner = new LoopRunner(hooks);
    const result = await runner.run({
      loop: { name: "plan", tools: ["read"] },
      maxTurns: 1,
      model: async () => ({
        text: "I will write.",
        toolCalls: [{ id: "call-1", name: "write", args: { path: "x.txt" } }],
      }),
      executeTool: async () => {
        executed = true;
        return "should not run";
      },
    });

    expect(executed).toBe(false);
    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0]).toMatchObject({
      skipped: true,
      isError: true,
      result: 'Error: Tool call "write" denied: read-only loop',
    });
  });

  it("continues when loop:stop mutates shouldStop to false", async () => {
    const hooks = new LoopHookRegistry();
    hooks.register({
      hook: "loop:stop",
      phase: "before",
      handler: (ctx) => {
        if (ctx.data.turn === 0) ctx.data.shouldStop = false;
      },
    });

    let calls = 0;
    const runner = new LoopRunner(hooks);
    const result = await runner.run({
      loop: { name: "review" },
      maxTurns: 2,
      model: async () => {
        calls++;
        return { text: String(calls) };
      },
      executeTool: async () => "unused",
    });

    expect(result.text).toBe("12");
    expect(result.turns).toBe(2);
    expect(result.reason).toBe("completed");
  });
});
