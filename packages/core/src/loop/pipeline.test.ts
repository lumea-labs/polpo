import { describe, expect, it } from "vitest";
import { LoopHookRegistry } from "./hooks.js";
import { PipelineExecutor } from "./pipeline.js";

describe("PipelineExecutor", () => {
  it("runs sequential loop steps and accumulates context by loop name", async () => {
    const executor = new PipelineExecutor();
    const result = await executor.execute({
      loops: { plan: {}, build: {} },
      pipeline: { steps: [{ loop: "plan" }, { loop: "build", when: "plan.ready == true" }] },
      runLoop: async (name) => ({ output: { ready: true, name } }),
    });

    expect(result.context).toMatchObject({
      plan: { ready: true, name: "plan" },
      build: { ready: true, name: "build" },
    });
    expect(result.trace.map(e => e.type)).toEqual(["loop", "loop"]);
    expect(result.events.map(e => e.type)).toEqual([
      "loop.start",
      "step.start",
      "step.end",
      "transition",
      "step.start",
      "step.end",
      "loop.end",
    ]);
    expect(result.events.every(e => typeof e.ts === "string" && e.id.startsWith("trace-"))).toBe(true);
  });

  it("routes switch branches deterministically from context", async () => {
    const executor = new PipelineExecutor();
    const result = await executor.execute({
      loops: { review: {}, fix: {}, ship: {} },
      context: { review: { passed: false } },
      pipeline: {
        steps: [{
          switch: {
            cases: [
              { when: "review.passed == true", steps: [{ loop: "ship" }] },
              { when: "review.passed == false", steps: [{ loop: "fix" }] },
            ],
          },
        }],
      },
      runLoop: async (name) => ({ output: { ran: name } }),
    });

    expect(result.context.fix).toEqual({ ran: "fix" });
    expect(result.context.ship).toBeUndefined();
  });

  it("runs parallel branches against a frozen snapshot and merges by branch output", async () => {
    const executor = new PipelineExecutor();
    const result = await executor.execute({
      loops: { test: {}, typecheck: {} },
      context: { build: { done: true } },
      pipeline: { steps: [{ parallel: [{ loop: "test" }, { loop: "typecheck" }], join: "all" }] },
      runLoop: async (name, _loop, context) => {
        expect(() => ((context as any).mutated = true)).toThrow();
        return { output: { passed: name === "test" || name === "typecheck" } };
      },
    });

    expect(result.context).toMatchObject({
      test: { passed: true },
      typecheck: { passed: true },
    });
    expect((result.context as any).mutated).toBeUndefined();
  });

  it("supports human nodes through an injected handler", async () => {
    const executor = new PipelineExecutor();
    const result = await executor.execute({
      loops: {},
      pipeline: { steps: [{ human: "underwriter" }] },
      runLoop: async () => ({ output: {} }),
      handleHuman: async () => ({ output: { decision: "approve" } }),
    });

    expect(result.context.underwriter).toEqual({ decision: "approve" });
  });

  it("runs deterministic tool steps and stores output at saveAs path", async () => {
    const executor = new PipelineExecutor();
    const result = await executor.execute({
      loops: { plan: {} },
      pipeline: {
        steps: [
          { tool: "clone_repository", input: { repoUrl: "https://github.com/acme/app.git" }, saveAs: "repo.clone" },
          { loop: "plan", when: "repo.clone.ok == true" },
        ],
      },
      runTool: async (name, input, context) => {
        expect(name).toBe("clone_repository");
        expect(input).toEqual({ repoUrl: "https://github.com/acme/app.git" });
        expect(() => ((context as any).mutated = true)).toThrow();
        return { output: { ok: true, path: "workspace/app" } };
      },
      runLoop: async (name) => ({ output: { planned: name } }),
    });

    expect(result.context).toMatchObject({
      repo: { clone: { ok: true, path: "workspace/app" } },
      plan: { planned: "plan" },
    });
    expect(result.trace.map(e => e.type)).toEqual(["tool", "loop"]);
    expect(result.events.map(e => e.type)).toContain("tool.call");
    expect(result.events.map(e => e.type)).toContain("tool.result");
  });

  it("streams structured trace events through onTrace", async () => {
    const executor = new PipelineExecutor();
    const events: string[] = [];
    const result = await executor.execute({
      name: "observed-flow",
      loops: { plan: {} },
      pipeline: { steps: [{ loop: "plan" }] },
      onTrace: async (event) => {
        events.push(`${event.loop}:${event.type}`);
      },
      runLoop: async (name) => ({ output: { name } }),
    });

    expect(events).toEqual([
      "observed-flow:loop.start",
      "observed-flow:step.start",
      "observed-flow:step.end",
      "observed-flow:loop.end",
    ]);
    expect(result.events[0]).toMatchObject({ loop: "observed-flow", type: "loop.start" });
  });

  it("fires loop:transition hooks between sequential loop nodes", async () => {
    const hooks = new LoopHookRegistry();
    const transitions: string[] = [];
    hooks.register({
      hook: "loop:transition",
      phase: "before",
      handler: (ctx) => {
        transitions.push(`${ctx.data.from}->${ctx.data.to}`);
      },
    });

    const executor = new PipelineExecutor();
    await executor.execute({
      hooks,
      loops: { plan: {}, build: {} },
      pipeline: { steps: [{ loop: "plan" }, { loop: "build" }] },
      runLoop: async (name) => ({ output: { name } }),
    });

    expect(transitions).toEqual(["plan->build"]);
  });

  it("blocks a transition when loop:transition is cancelled", async () => {
    const hooks = new LoopHookRegistry();
    hooks.register({
      hook: "loop:transition",
      phase: "before",
      handler: (ctx) => {
        if (ctx.data.from === "plan" && ctx.data.to === "build") ctx.cancel("approval required");
      },
    });

    const executor = new PipelineExecutor();
    await expect(executor.execute({
      hooks,
      loops: { plan: {}, build: {} },
      pipeline: { steps: [{ loop: "plan" }, { loop: "build" }] },
      runLoop: async (name) => ({ output: { name } }),
    })).rejects.toThrow('Loop transition from "plan" to "build" cancelled: approval required');
  });

  it("runs project hook tool actions and saves their output into context", async () => {
    const executor = new PipelineExecutor();
    const calls: Array<{ name: string; input: unknown }> = [];

    const result = await executor.execute({
      name: "audited-flow",
      loops: { plan: {} },
      pipeline: { steps: [{ loop: "plan" }] },
      projectHooks: {
        "loop:start": [{ tool: "unix_time", saveAs: "timing.start" }],
        "step:after": [{ tool: "audit_step", input: { level: "info" }, saveAs: "audit.lastStep" }],
        "loop:end": [{ tool: "unix_time", saveAs: "timing.end" }],
      },
      runTool: async (name, input) => {
        calls.push({ name, input });
        return { output: name === "unix_time" ? 123 : { ok: true } };
      },
      runLoop: async (name) => ({ output: { name } }),
    });

    expect(calls).toEqual([
      { name: "unix_time", input: undefined },
      { name: "audit_step", input: { level: "info" } },
      { name: "unix_time", input: undefined },
    ]);
    expect(result.context).toMatchObject({
      timing: { start: 123, end: 123 },
      audit: { lastStep: { ok: true } },
    });
    expect(result.events.filter((event) => event.data?.hook).map((event) => event.type)).toEqual([
      "tool.call",
      "tool.result",
      "tool.call",
      "tool.result",
      "tool.call",
      "tool.result",
    ]);
  });

  it("skips project hook actions when their guard does not match", async () => {
    const executor = new PipelineExecutor();
    const calls: string[] = [];

    const result = await executor.execute({
      loops: { plan: {} },
      pipeline: { steps: [{ loop: "plan" }] },
      context: { enabled: false },
      projectHooks: {
        "loop:start": [{ tool: "should_not_run", when: "enabled == true", saveAs: "hook" }],
      },
      runTool: async (name) => {
        calls.push(name);
        return { output: { ok: true } };
      },
      runLoop: async (name) => ({ output: { name } }),
    });

    expect(calls).toEqual([]);
    expect(result.context.hook).toBeUndefined();
  });

  it("continues project hook execution when onError is continue", async () => {
    const executor = new PipelineExecutor();

    const result = await executor.execute({
      loops: {},
      pipeline: { steps: [{ tool: "work", saveAs: "work" }] },
      projectHooks: {
        "tool:before": [{ tool: "flaky_audit", onError: "continue", saveAs: "audit" }],
      },
      runTool: async (name) => {
        if (name === "flaky_audit") throw new Error("audit unavailable");
        return { output: { ok: true } };
      },
      runLoop: async () => ({ output: {} }),
    });

    expect(result.context).toMatchObject({ work: { ok: true } });
    expect(result.events.some((event) => event.type === "tool.result" && event.status === "failed" && event.tool === "flaky_audit")).toBe(true);
  });

  it("fails project hook execution by default when a hook tool fails", async () => {
    const executor = new PipelineExecutor();

    await expect(executor.execute({
      loops: {},
      pipeline: { steps: [{ tool: "work" }] },
      projectHooks: {
        "tool:before": [{ tool: "policy_check" }],
      },
      runTool: async (name) => {
        if (name === "policy_check") throw new Error("blocked");
        return { output: { ok: true } };
      },
      runLoop: async () => ({ output: {} }),
    })).rejects.toThrow('Loop hook "tool:before" action "policy_check" failed: blocked');
  });

  it("enforces deny and approval project policies at lifecycle points", async () => {
    const executor = new PipelineExecutor();

    await expect(executor.execute({
      loops: {},
      pipeline: { steps: [{ tool: "bash", input: { command: "rm -rf /" } }] },
      projectPolicies: [
        { id: "dangerous-bash", effect: "deny", hook: "tool:before", when: "tool.name == 'bash'", message: "bash is restricted" },
      ],
      runTool: async () => ({ output: { ok: true } }),
      runLoop: async () => ({ output: {} }),
    })).rejects.toThrow('Loop policy "dangerous-bash" denied tool:before: bash is restricted');

    await expect(executor.execute({
      loops: { deploy: {} },
      pipeline: { steps: [{ loop: "deploy" }] },
      projectPolicies: [
        { id: "deploy-approval", effect: "approval", hook: "step:before", when: "step.name == 'deploy'", message: "deployment requires approval" },
      ],
      runLoop: async () => ({ output: {} }),
    })).rejects.toThrow('Loop policy "deploy-approval" requires approval at step:before: deployment requires approval');
  });

  it("treats allow policies as an allow-list when present for a lifecycle point", async () => {
    const executor = new PipelineExecutor();

    const result = await executor.execute({
      loops: {},
      pipeline: { steps: [{ tool: "unix_time", saveAs: "time" }] },
      projectPolicies: [
        { id: "only-unix-time", effect: "allow", hook: "tool:before", when: "tool.name == 'unix_time'" },
      ],
      runTool: async () => ({ output: 123 }),
      runLoop: async () => ({ output: {} }),
    });
    expect(result.context.time).toBe(123);

    await expect(executor.execute({
      loops: {},
      pipeline: { steps: [{ tool: "bash" }] },
      projectPolicies: [
        { id: "only-unix-time", effect: "allow", hook: "tool:before", when: "tool.name == 'unix_time'" },
      ],
      runTool: async () => ({ output: "nope" }),
      runLoop: async () => ({ output: {} }),
    })).rejects.toThrow('Loop policy allow-list blocked tool:before: no allow policy matched');
  });
});
