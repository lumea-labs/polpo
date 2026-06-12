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
});
