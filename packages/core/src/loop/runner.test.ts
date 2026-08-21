import { describe, expect, it } from "vitest";
import { LoopHookRegistry } from "./hooks.js";
import { LoopRunner } from "./runner.js";
import { InMemorySteeringController, SteeringClosedError } from "../steering.js";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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

  it("executes eligible tool bodies concurrently while preserving hook and checkpoint order", async () => {
    const events: string[] = [];
    let active = 0;
    let maxActive = 0;
    const hooks = new LoopHookRegistry();
    hooks.register({
      hook: "tool:before",
      phase: "before",
      handler: ({ data }) => { events.push(`before:${data.toolCall.name}`); },
    });
    hooks.register({
      hook: "tool:after",
      phase: "after",
      handler: ({ data }) => { events.push(`after:${data.toolCall.name}`); },
    });

    const result = await new LoopRunner(hooks).run({
      loop: { name: "parallel" },
      maxTurns: 1,
      parallelToolCalls: true,
      model: async () => ({
        text: "",
        toolCalls: [
          { id: "a", name: "read_alpha", args: {} },
          { id: "b", name: "list_beta", args: {} },
        ],
      }),
      executeTool: async (call) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(10);
        active -= 1;
        events.push(`execute:${call.name}`);
        return call.name;
      },
      onTurnCheckpoint: ({ toolResults }) => {
        events.push(`checkpoint:${toolResults.map((item) => item.toolCall.name).join(",")}`);
      },
    });

    expect(maxActive).toBe(2);
    expect(result.toolResults.map((item) => item.result)).toEqual(["read_alpha", "list_beta"]);
    expect(events.slice(0, 2)).toEqual(["before:read_alpha", "before:list_beta"]);
    expect(events.slice(-3)).toEqual([
      "after:read_alpha",
      "after:list_beta",
      "checkpoint:read_alpha,list_beta",
    ]);
  });

  it("keeps the complete batch serial when one tool is not read-only", async () => {
    let active = 0;
    let maxActive = 0;

    await new LoopRunner().run({
      loop: { name: "safe" },
      maxTurns: 1,
      parallelToolCalls: true,
      model: async () => ({
        text: "",
        toolCalls: [
          { id: "a", name: "read_alpha", args: {} },
          { id: "b", name: "write_beta", args: {} },
        ],
      }),
      executeTool: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(5);
        active -= 1;
        return "ok";
      },
    });

    expect(maxActive).toBe(1);
  });

  it("turns a thrown tool failure into one ordered error result", async () => {
    const result = await new LoopRunner().run({
      loop: { name: "errors" },
      maxTurns: 1,
      parallelToolCalls: true,
      model: async () => ({
        text: "",
        toolCalls: [
          { id: "a", name: "read_alpha", args: {} },
          { id: "b", name: "read_beta", args: {} },
        ],
      }),
      executeTool: async (call) => {
        if (call.id === "a") throw new Error("unavailable");
        return "ok";
      },
    });

    expect(result.toolResults).toMatchObject([
      { result: "Error: unavailable", isError: true, skipped: false },
      { result: "ok", isError: false, skipped: false },
    ]);
  });

  it("settles and exposes the complete ordered batch before surfacing a steering abort", async () => {
    const steering = new InMemorySteeringController();
    const observed: string[][] = [];

    await expect(new LoopRunner().run({
      loop: { name: "abort" },
      maxTurns: 1,
      parallelToolCalls: true,
      steering,
      onSteering: () => {},
      model: async () => ({
        text: "",
        toolCalls: [
          { id: "a", name: "read_alpha", args: {} },
          { id: "b", name: "read_beta", args: {} },
        ],
      }),
      executeTool: async (call) => {
        if (call.id === "a") steering.abort("stop");
        await delay(2);
        return call.name;
      },
      onToolResults: (results) => {
        observed.push(results.map((item) => item.toolCall.id));
      },
    })).rejects.toThrow("stop");

    expect(observed).toEqual([["a", "b"]]);
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

describe("LoopRunner steering", () => {
  it("delivers steering queued before the run ahead of the first model turn", async () => {
    const steering = new InMemorySteeringController();
    steering.enqueue({ id: "s1", mode: "steer", content: { text: "start here" } });
    const events: string[] = [];

    const result = await new LoopRunner().run({
      loop: { name: "default" },
      steering,
      onSteering: (messages) => { events.push(`steering:${messages.map((message) => message.id).join(",")}`); },
      model: async () => {
        events.push("model");
        return { text: "done" };
      },
      executeTool: async () => "unused",
    });

    expect(result.status).toBe("completed");
    expect(events).toEqual(["steering:s1", "model"]);
  });

  it("injects steering enqueued during a model turn at the next safe boundary", async () => {
    const steering = new InMemorySteeringController();
    const events: string[] = [];
    let modelCalls = 0;

    const result = await new LoopRunner().run({
      loop: { name: "default" },
      maxTurns: 3,
      steering,
      onSteering: (messages) => { events.push(`steering:${messages[0].id}`); },
      model: async () => {
        modelCalls++;
        events.push(`model:${modelCalls}`);
        if (modelCalls === 1) {
          steering.enqueue({ id: "mid-turn", mode: "steer", content: { text: "continue with this" } });
        }
        return { text: modelCalls === 1 ? "first" : "second" };
      },
      executeTool: async () => "unused",
    });

    expect(result.text).toBe("firstsecond");
    expect(events).toEqual(["model:1", "steering:mid-turn", "model:2"]);
  });

  it("waits to deliver follow-ups until the run would otherwise stop", async () => {
    const steering = new InMemorySteeringController();
    steering.enqueue({ id: "follow", mode: "follow_up", content: { text: "one more thing" } });
    const deliveredAt: number[] = [];
    let modelCalls = 0;

    const result = await new LoopRunner().run({
      loop: { name: "default" },
      maxTurns: 4,
      steering,
      onSteering: () => { deliveredAt.push(modelCalls); },
      model: async ({ turn }) => {
        modelCalls++;
        return turn === 0
          ? { text: "working", toolCalls: [{ id: "c1", name: "read", args: {} }] }
          : { text: turn === 1 ? "done" : "followed up" };
      },
      executeTool: async () => "ok",
    });

    expect(deliveredAt).toEqual([2]);
    expect(result.turns).toBe(3);
    expect(result.text).toBe("workingdonefollowed up");
  });

  it("does not consume messages when the max-turn budget cannot execute them", async () => {
    const steering = new InMemorySteeringController();

    await new LoopRunner().run({
      loop: { name: "default" },
      maxTurns: 1,
      steering,
      onSteering: () => undefined,
      model: async () => {
        steering.enqueue({ id: "late", mode: "steer", content: { text: "too late for this run" } });
        return { text: "done" };
      },
      executeTool: async () => "unused",
    });

    expect(steering.snapshot().pending.map((message) => message.id)).toEqual(["late"]);
  });

  it("includes the steering snapshot in durable turn checkpoints", async () => {
    const steering = new InMemorySteeringController();
    steering.enqueue({ id: "later", mode: "follow_up", content: { text: "after completion" } });
    const snapshots: unknown[] = [];

    await new LoopRunner().run({
      loop: { name: "default" },
      maxTurns: 1,
      steering,
      onSteering: () => undefined,
      model: async () => ({ text: "done" }),
      executeTool: async () => "unused",
      onTurnCheckpoint: (checkpoint) => { snapshots.push(checkpoint.steering); },
    });

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ pending: [{ id: "later", mode: "follow_up" }] });
  });

  it("stops before model or tool work when steering is aborted", async () => {
    const steering = new InMemorySteeringController();
    steering.abort("cancelled by caller");
    let called = false;

    await expect(new LoopRunner().run({
      loop: { name: "default" },
      steering,
      onSteering: () => undefined,
      model: async () => {
        called = true;
        return { text: "never" };
      },
      executeTool: async () => "unused",
    })).rejects.toMatchObject({
      name: "SteeringAbortError",
      reason: "cancelled by caller",
    });
    expect(called).toBe(false);
  });

  it("delivers a message accepted by the final stop hook instead of losing it", async () => {
    const steering = new InMemorySteeringController();
    const hooks = new LoopHookRegistry();
    const events: string[] = [];
    let modelCalls = 0;

    hooks.register({
      hook: "loop:stop",
      phase: "before",
      handler: (context) => {
        if (context.data.turn === 0) {
          steering.enqueue({
            id: "at-final-boundary",
            mode: "steer",
            content: { text: "include this before finishing" },
          });
        }
      },
    });

    const result = await new LoopRunner(hooks).run({
      loop: { name: "default" },
      maxTurns: 3,
      steering,
      onSteering: (messages) => { events.push(`steering:${messages[0].id}`); },
      model: async () => {
        modelCalls++;
        events.push(`model:${modelCalls}`);
        return { text: modelCalls === 1 ? "first" : "second" };
      },
      executeTool: async () => "unused",
    });

    expect(result.text).toBe("firstsecond");
    expect(events).toEqual(["model:1", "steering:at-final-boundary", "model:2"]);
    expect(() => steering.enqueue({ id: "after", mode: "steer", content: { text: "late" } }))
      .toThrow(SteeringClosedError);
  });
});
