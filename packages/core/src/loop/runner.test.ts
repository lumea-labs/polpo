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

  it("uses stopWhen as the deterministic stop condition when configured", async () => {
    const hooks = new LoopHookRegistry();
    hooks.register({
      hook: "step:after",
      phase: "after",
      handler: (ctx) => {
        if (ctx.data.turn === 1) ctx.data.context.done = true;
      },
    });

    const runner = new LoopRunner(hooks);
    const result = await runner.run({
      loop: { name: "build", stopWhen: { expression: "done == true" } },
      maxTurns: 3,
      model: async () => ({ text: "tick" }),
      executeTool: async () => "unused",
    });

    expect(result.text).toBe("ticktick");
    expect(result.turns).toBe(2);
    expect(result.reason).toBe("completed");
    expect(result.context.done).toBe(true);
  });
});

describe("LoopRunner durable turns", () => {
  it("emits a checkpoint after every completed turn, after tool execution", async () => {
    const events: string[] = [];
    const checkpoints: Array<{ turn: number; turns: number; text: string; toolResults: unknown[] }> = [];

    const runner = new LoopRunner();
    const result = await runner.run({
      loop: { name: "default" },
      maxTurns: 5,
      model: async ({ turn }) => {
        if (turn === 0) {
          return {
            text: "working",
            toolCalls: [{ id: "call-1", name: "bash", args: { command: "true" } }],
          };
        }
        return { text: "done" };
      },
      executeTool: async (toolCall) => {
        events.push(`tool:${toolCall.name}`);
        return "ok";
      },
      onTurnCheckpoint: async (cp) => {
        events.push(`checkpoint:${cp.turn}`);
        checkpoints.push({
          turn: cp.turn,
          turns: cp.turns,
          text: cp.text,
          toolResults: cp.toolResults,
        });
      },
    });

    expect(result.status).toBe("completed");
    // One checkpoint per turn; the turn-0 checkpoint fires AFTER its tools ran.
    expect(events).toEqual(["tool:bash", "checkpoint:0", "checkpoint:1"]);
    expect(checkpoints).toHaveLength(2);
    expect(checkpoints[0]).toMatchObject({ turn: 0, turns: 1, text: "working" });
    expect(checkpoints[0].toolResults).toHaveLength(1);
    expect(checkpoints[0].toolResults[0]).toMatchObject({ result: "ok", isError: false });
    expect(checkpoints[1]).toMatchObject({ turn: 1, turns: 2, text: "done" });
    expect(checkpoints[1].toolResults).toHaveLength(0);
  });

  it("resumes from startTurn: earlier turns are never re-executed", async () => {
    const modelTurns: number[] = [];
    let toolCalls = 0;

    const runner = new LoopRunner();
    const result = await runner.run({
      loop: { name: "default" },
      maxTurns: 4,
      startTurn: 2,
      model: async ({ turn }) => {
        modelTurns.push(turn);
        return { text: `t${turn}` };
      },
      executeTool: async () => {
        toolCalls++;
        return "unused";
      },
    });

    // The model is first invoked at the resumed turn — turns 0 and 1 are
    // history, never replayed; no tool from a completed turn re-executes.
    expect(modelTurns).toEqual([2]);
    expect(toolCalls).toBe(0);
    expect(result.status).toBe("completed");
    // Turn accounting stays cumulative across the logical run.
    expect(result.turns).toBe(3);
  });

  it("startTurn preserves the maxTurns budget", async () => {
    const modelTurns: number[] = [];
    const runner = new LoopRunner();
    const result = await runner.run({
      loop: { name: "default" },
      maxTurns: 4,
      startTurn: 2,
      model: async ({ turn }) => {
        modelTurns.push(turn);
        return {
          text: "loop",
          toolCalls: [{ id: `c${turn}`, name: "bash", args: {} }],
        };
      },
      executeTool: async () => "ok",
    });

    // Only turns 2 and 3 run — the budget counts completed history too.
    expect(modelTurns).toEqual([2, 3]);
    expect(result.reason).toBe("max_turns");
    expect(result.turns).toBe(4);
  });

  it("a throwing checkpoint sink never fails the run", async () => {
    const runner = new LoopRunner();
    const result = await runner.run({
      loop: { name: "default" },
      maxTurns: 2,
      model: async () => ({ text: "fine" }),
      executeTool: async () => "unused",
      onTurnCheckpoint: async () => {
        throw new Error("store unavailable");
      },
    });

    expect(result.status).toBe("completed");
    expect(result.text).toBe("fine");
  });
});
