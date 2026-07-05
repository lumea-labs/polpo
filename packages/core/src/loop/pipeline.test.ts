import { describe, expect, it } from "vitest";
import { LoopHookRegistry } from "./hooks.js";
import { normalizeProjectLoop } from "./normalize.js";
import { PipelineExecutor, type PipelineCheckpoint, type PipelineStepPosition } from "./pipeline.js";
import {
  LoopApprovalRequiredError,
  LoopPermissionApprovalRequiredError,
  LoopPermissionDeniedError,
  LoopPolicyDeniedError,
} from "./run-store.js";
import type { ProjectLoopConfig, Step } from "./types.js";

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
      pipeline: { steps: [{ parallel: [[{ loop: "test" }], [{ loop: "typecheck" }]], join: "all" }] },
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
    expect(result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "step.start", step: "parallel", status: "started" }),
      expect.objectContaining({ type: "step.end", step: "parallel", status: "completed" }),
      expect.objectContaining({ type: "step.end", step: "test", status: "completed" }),
      expect.objectContaining({ type: "step.end", step: "typecheck", status: "completed" }),
    ]));
  });

  it("keeps and completes every step in project-level parallel branch sequences", async () => {
    const projectLoop: ProjectLoopConfig = {
      name: "Simple Coding Loop",
      start: "clone_repo",
      steps: {
        clone_repo: {
          type: "tool",
          tool: "bash",
          input: { command: "git clone https://github.com/acme/app.git /tmp/app" },
          saveAs: "cloneResult",
          next: "parallel_work",
        },
        parallel_work: {
          type: "parallel",
          branches: ["implement", "install"],
          join: "all",
          next: "end",
        },
        implement: {
          type: "agent",
          systemPrompt: "Apply the requested changes.",
          next: "end",
        },
        install: {
          type: "tool",
          tool: "bash",
          input: { command: "cd /tmp/app && bun install" },
          saveAs: "installResult",
          next: "start_dev",
        },
        start_dev: {
          type: "tool",
          tool: "bash",
          input: { command: "cd /tmp/app && bun run dev" },
          saveAs: "devServer",
          next: "end",
        },
      },
    };
    const normalized = normalizeProjectLoop(projectLoop);
    const executor = new PipelineExecutor();
    const toolCalls: string[] = [];

    const result = await executor.execute({
      loops: normalized.loops,
      pipeline: normalized.pipeline!,
      runLoop: async (name) => ({ output: { changed: name === "implement" } }),
      runTool: async (_name, _input, _context, step) => {
        toolCalls.push(step.saveAs ?? _name);
        return { output: { ok: true, step: step.saveAs ?? _name } };
      },
    });

    expect(normalized.pipeline?.steps).toMatchObject([
      { tool: "bash", saveAs: "cloneResult" },
      {
        parallel: [
          [{ loop: "implement" }],
          [
            { tool: "bash", saveAs: "installResult" },
            { tool: "bash", saveAs: "devServer" },
          ],
        ],
      },
    ]);
    expect(toolCalls).toEqual(["cloneResult", "installResult", "devServer"]);
    expect(result.context).toMatchObject({
      cloneResult: { ok: true, step: "cloneResult" },
      implement: { changed: true },
      installResult: { ok: true, step: "installResult" },
      devServer: { ok: true, step: "devServer" },
    });
    expect(result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "step.end", step: "parallel", status: "completed" }),
      expect.objectContaining({ type: "tool.result", step: "devServer", status: "completed" }),
      expect.objectContaining({ type: "step.end", step: "implement", status: "completed" }),
    ]));
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

  it("runs while blocks until the exit condition is satisfied", async () => {
    const executor = new PipelineExecutor();
    let attempts = 0;
    const result = await executor.execute({
      loops: {},
      pipeline: {
        steps: [
          {
            while: {
              until: "build.passed == true",
              maxIterations: 3,
              steps: [{ tool: "build_check", saveAs: "build" }],
            },
          },
        ],
      },
      runLoop: async () => ({ output: {} }),
      runTool: async () => {
        attempts += 1;
        return { output: { passed: attempts >= 2 } };
      },
    });

    expect(attempts).toBe(2);
    expect(result.context.build).toEqual({ passed: true });
    expect(result.trace.filter((event) => event.type === "while" && event.matched)).toHaveLength(2);
  });

  it("fails while blocks when maxIterations is exhausted", async () => {
    const executor = new PipelineExecutor();
    await expect(executor.execute({
      loops: {},
      pipeline: {
        steps: [
          {
            while: {
              until: "build.passed == true",
              maxIterations: 2,
              steps: [{ tool: "build_check", saveAs: "build" }],
            },
          },
        ],
      },
      runLoop: async () => ({ output: {} }),
      runTool: async () => ({ output: { passed: false } }),
    })).rejects.toThrow("maxIterations");
  });

  it("throws typed errors for deny and approval policies", async () => {
    const executor = new PipelineExecutor();

    await expect(executor.execute({
      loops: {},
      pipeline: { steps: [{ tool: "deploy" }] },
      projectPolicies: [{ id: "no-deploy", hook: "tool:before", effect: "deny", when: "tool.name == 'deploy'" }],
      runLoop: async () => ({ output: {} }),
      runTool: async () => ({ output: "deployed" }),
    })).rejects.toBeInstanceOf(LoopPolicyDeniedError);

    await expect(executor.execute({
      loops: {},
      pipeline: { steps: [{ tool: "send_email" }] },
      projectPolicies: [{ id: "approve-send", hook: "tool:before", effect: "approval", when: "tool.name == 'send_email'" }],
      runLoop: async () => ({ output: {} }),
      runTool: async () => ({ output: "sent" }),
    })).rejects.toBeInstanceOf(LoopApprovalRequiredError);
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

  it("enforces project permissions before tool execution", async () => {
    const executor = new PipelineExecutor();
    const calls: string[] = [];

    const allowed = await executor.execute({
      loops: {},
      pipeline: { steps: [{ tool: "unix_time", saveAs: "time" }] },
      projectPermissions: [
        { id: "tool-allowlist", resource: "tool", action: "call", effect: "allow", match: { tool: ["unix_time"] } },
      ],
      runTool: async (name) => {
        calls.push(name);
        return { output: 123 };
      },
      runLoop: async () => ({ output: {} }),
    });

    expect(allowed.context.time).toBe(123);
    expect(calls).toEqual(["unix_time"]);
    expect(allowed.events.some((event) => event.type === "permission.result" && event.data?.permissionId === "tool-allowlist")).toBe(true);

    await expect(executor.execute({
      loops: {},
      pipeline: { steps: [{ tool: "bash" }] },
      projectPermissions: [
        { id: "tool-allowlist", resource: "tool", action: "call", effect: "allow", match: { tool: ["unix_time"] } },
      ],
      runTool: async () => ({ output: "nope" }),
      runLoop: async () => ({ output: {} }),
    })).rejects.toBeInstanceOf(LoopPermissionDeniedError);
  });

  it("distinguishes permission approval gates from policy approval gates", async () => {
    const executor = new PipelineExecutor();

    await expect(executor.execute({
      loops: {},
      pipeline: { steps: [{ tool: "send_email" }] },
      projectPermissions: [
        { id: "approve-email", resource: "tool", action: "call", effect: "approval", match: { tool: "send_email" } },
      ],
      runTool: async () => ({ output: "sent" }),
      runLoop: async () => ({ output: {} }),
    })).rejects.toBeInstanceOf(LoopPermissionApprovalRequiredError);
  });

  it("resumes from an approval checkpoint without rerunning completed steps", async () => {
    const executor = new PipelineExecutor();
    let planRuns = 0;
    let deployRuns = 0;
    let verifyRuns = 0;

    let approval: LoopApprovalRequiredError | undefined;
    try {
      await executor.execute({
        name: "deploy-flow",
        loops: { plan: {}, verify: {} },
        pipeline: {
          steps: [
            { loop: "plan" },
            { tool: "deploy", saveAs: "deploy" },
            { loop: "verify" },
          ],
        },
        projectPolicies: [
          { id: "approve-deploy", hook: "tool:before", effect: "approval", when: "tool.name == 'deploy'" },
        ],
        runLoop: async (name) => {
          if (name === "plan") planRuns += 1;
          if (name === "verify") verifyRuns += 1;
          return { output: { name } };
        },
        runTool: async () => {
          deployRuns += 1;
          return { output: { ok: true } };
        },
      });
    } catch (err) {
      approval = err as LoopApprovalRequiredError;
    }

    expect(approval).toBeInstanceOf(LoopApprovalRequiredError);
    expect(approval?.resume?.context).toMatchObject({ plan: { name: "plan" } });
    expect(approval?.resume?.steps).toEqual([
      { tool: "deploy", saveAs: "deploy" },
      { loop: "verify" },
    ]);
    expect(planRuns).toBe(1);
    expect(deployRuns).toBe(0);
    expect(verifyRuns).toBe(0);

    const resumed = await executor.execute({
      name: "deploy-flow",
      loops: { plan: {}, verify: {} },
      pipeline: { steps: approval!.resume!.steps },
      context: approval!.resume!.context,
      resume: {
        previousNode: approval!.resume!.previousNode,
        approvedGates: [{ type: "policy", id: "approve-deploy", hook: "tool:before" }],
      },
      projectPolicies: [
        { id: "approve-deploy", hook: "tool:before", effect: "approval", when: "tool.name == 'deploy'" },
      ],
      runLoop: async (name) => {
        if (name === "plan") planRuns += 1;
        if (name === "verify") verifyRuns += 1;
        return { output: { name } };
      },
      runTool: async () => {
        deployRuns += 1;
        return { output: { ok: true } };
      },
    });

    expect(planRuns).toBe(1);
    expect(deployRuns).toBe(1);
    expect(verifyRuns).toBe(1);
    expect(resumed.context).toMatchObject({
      plan: { name: "plan" },
      deploy: { ok: true },
      verify: { name: "verify" },
    });
    expect(resumed.events.map((event) => event.type)).toContain("loop.resume");
  });
});

// ─── Durable pipeline checkpoints (Phase B) ──────────────────────────────
//
// The executor emits a PipelineCheckpoint after every completed step: the
// composed remaining-steps list (same shape the human-gate resume format
// already replays), the live context bag, and the last completed node.
// Resume = re-execute with `pipeline.steps = checkpoint.steps` and
// `context = checkpoint.context` — completed steps are never in the list,
// their outputs replay from the bag (Temporal semantics).

describe("PipelineExecutor — durable checkpoints", () => {
  /** Checkpoints always cross a store boundary — pin JSON fidelity. */
  function collectInto(checkpoints: PipelineCheckpoint[]) {
    return async (checkpoint: PipelineCheckpoint) => {
      checkpoints.push(JSON.parse(JSON.stringify(checkpoint)) as PipelineCheckpoint);
    };
  }

  it("emits a checkpoint after every completed step: remaining steps, context, previousNode", async () => {
    const executor = new PipelineExecutor();
    const checkpoints: PipelineCheckpoint[] = [];

    await executor.execute({
      loops: { a: {}, b: {} },
      pipeline: {
        steps: [
          { loop: "a" },
          { tool: "probe", saveAs: "probe" },
          { loop: "b" },
        ],
      },
      onCheckpoint: collectInto(checkpoints),
      runLoop: async (name) => ({ output: { ran: name } }),
      runTool: async () => ({ output: { ok: true } }),
    });

    expect(checkpoints).toHaveLength(3);

    // After "a": the tool and "b" are still pending, a's output is in the bag.
    expect(checkpoints[0].steps).toEqual([
      { tool: "probe", saveAs: "probe" },
      { loop: "b" },
    ]);
    expect(checkpoints[0].previousNode).toBe("a");
    expect(checkpoints[0].context).toMatchObject({ a: { ran: "a" } });

    // After the tool step.
    expect(checkpoints[1].steps).toEqual([{ loop: "b" }]);
    expect(checkpoints[1].previousNode).toBe("probe");
    expect(checkpoints[1].context).toMatchObject({ a: { ran: "a" }, probe: { ok: true } });

    // After "b": nothing left to execute.
    expect(checkpoints[2].steps).toEqual([]);
    expect(checkpoints[2].previousNode).toBe("b");
  });

  it("resuming from a boundary checkpoint re-executes only the remaining steps", async () => {
    const runs: string[] = [];
    const runLoop = async (name: string) => {
      runs.push(name);
      return { output: { ran: name } };
    };

    const executor = new PipelineExecutor();
    const checkpoints: PipelineCheckpoint[] = [];
    await executor.execute({
      loops: { a: {}, b: {}, c: {} },
      pipeline: { steps: [{ loop: "a" }, { loop: "b" }, { loop: "c" }] },
      onCheckpoint: collectInto(checkpoints),
      runLoop,
    });
    expect(runs).toEqual(["a", "b", "c"]);

    // "Crash" between b and c: replay the after-b checkpoint.
    const afterB = checkpoints[1];
    runs.length = 0;
    const resumed = await executor.execute({
      loops: { a: {}, b: {}, c: {} },
      pipeline: { steps: afterB.steps },
      context: afterB.context,
      resume: { previousNode: afterB.previousNode },
      onCheckpoint: collectInto(checkpoints),
      runLoop,
    });

    expect(runs).toEqual(["c"]);
    expect(resumed.context).toMatchObject({
      a: { ran: "a" },
      b: { ran: "b" },
      c: { ran: "c" },
    });
    expect(resumed.events.map((event) => event.type)).toContain("loop.resume");
  });

  it("pins the switch choice at selection time: the chosen branch is inlined, the switch step is gone", async () => {
    const executor = new PipelineExecutor();
    const checkpoints: PipelineCheckpoint[] = [];

    await executor.execute({
      loops: { pre: {}, x1: {}, x2: {}, y: {}, post: {} },
      context: { route: { x: true } },
      pipeline: {
        steps: [
          { loop: "pre" },
          {
            switch: {
              cases: [{ when: "route.x == true", steps: [{ loop: "x1" }, { loop: "x2" }] }],
              default: { steps: [{ loop: "y" }] },
            },
          },
          { loop: "post" },
        ],
      },
      onCheckpoint: collectInto(checkpoints),
      runLoop: async (name) => ({ output: { ran: name } }),
    });

    // The selection checkpoint records the choice as a historical fact:
    // branch steps inlined ahead of the rest, no switch step to re-evaluate.
    const selection = checkpoints.find((cp) => (cp.steps[0] as any)?.loop === "x1");
    expect(selection).toBeDefined();
    expect(selection!.steps).toEqual([{ loop: "x1" }, { loop: "x2" }, { loop: "post" }]);
    expect(selection!.previousNode).toBe("pre");

    // From the selection onward no checkpoint ever contains a switch step.
    const fromSelection = checkpoints.slice(checkpoints.indexOf(selection!));
    for (const cp of fromSelection) {
      expect(cp.steps.some((step) => "switch" in step)).toBe(false);
    }

    // Mid-branch boundary: x2 then post remain.
    expect(checkpoints.some((cp) => JSON.stringify(cp.steps) === JSON.stringify([{ loop: "x2" }, { loop: "post" }]))).toBe(true);
  });

  it("while: body checkpoints carry a continuation step with completedIterations", async () => {
    const executor = new PipelineExecutor();
    const checkpoints: PipelineCheckpoint[] = [];
    let attempts = 0;

    await executor.execute({
      loops: { after: {} },
      pipeline: {
        steps: [
          {
            while: {
              until: "build.passed == true",
              maxIterations: 5,
              steps: [{ tool: "build_check", saveAs: "build" }],
            },
          },
          { loop: "after" },
        ],
      },
      onCheckpoint: collectInto(checkpoints),
      runLoop: async (name) => ({ output: { ran: name } }),
      runTool: async () => {
        attempts += 1;
        return { output: { passed: attempts >= 2 } };
      },
    });

    // The iteration-1 boundary points at a continuation that has already
    // done 1 iteration — never back at iteration 0.
    const iteration1 = checkpoints.find((cp) => (cp.steps[0] as any)?.while?.completedIterations === 1);
    expect(iteration1).toBeDefined();
    expect((iteration1!.steps[0] as any).while).toMatchObject({
      until: "build.passed == true",
      maxIterations: 5,
      completedIterations: 1,
    });
    expect(iteration1!.steps[1]).toEqual({ loop: "after" });
    expect(iteration1!.context).toMatchObject({ build: { passed: false } });

    // Iteration-2 boundary exists too (the loop exited after it).
    expect(checkpoints.some((cp) => (cp.steps[0] as any)?.while?.completedIterations === 2)).toBe(true);
  });

  it("while: resuming from a continuation restarts at the saved iteration, absolute maxIterations accounting", async () => {
    const executor = new PipelineExecutor();
    let attempts = 0;

    // Resume from "2 iterations already done" with maxIterations 4:
    // only iterations 3 and 4 may run before the guard trips.
    const continuation: Step = {
      while: {
        until: "build.passed == true",
        maxIterations: 4,
        completedIterations: 2,
        steps: [{ tool: "build_check", saveAs: "build" }],
      },
    };

    const resumed = await executor.execute({
      loops: {},
      pipeline: { steps: [continuation] },
      context: { build: { passed: false } },
      resume: { previousNode: "build_check" },
      runLoop: async () => ({ output: {} }),
      runTool: async () => {
        attempts += 1;
        return { output: { passed: attempts >= 2 } };
      },
    });

    // Two more iterations ran (3 and 4), not four.
    expect(attempts).toBe(2);
    expect(resumed.trace.filter((event) => event.type === "while" && event.matched).map((event) => event.iteration)).toEqual([3, 4]);

    // Same continuation but the exit condition never satisfies: the
    // absolute budget (4) trips after 2 more iterations, not after 4.
    let failedAttempts = 0;
    await expect(executor.execute({
      loops: {},
      pipeline: { steps: [JSON.parse(JSON.stringify(continuation)) as Step] },
      context: { build: { passed: false } },
      resume: { previousNode: "build_check" },
      runLoop: async () => ({ output: {} }),
      runTool: async () => {
        failedAttempts += 1;
        return { output: { passed: false } };
      },
    })).rejects.toThrow("maxIterations");
    expect(failedAttempts).toBe(2);
  });

  it("parallel: no checkpoints inside the block — one boundary after the whole block (v1 cut)", async () => {
    const executor = new PipelineExecutor();
    const checkpoints: PipelineCheckpoint[] = [];
    const positions: Array<PipelineStepPosition | undefined> = [];

    await executor.execute({
      loops: { pre: {}, p1: {}, p2: {}, post: {} },
      pipeline: {
        steps: [
          { loop: "pre" },
          { parallel: [[{ loop: "p1" }, { loop: "p2" }], [{ tool: "t", saveAs: "t" }]] },
          { loop: "post" },
        ],
      },
      onCheckpoint: collectInto(checkpoints),
      runLoop: async (name, _loop, _context, position) => {
        positions.push(position);
        return { output: { ran: name } };
      },
      runTool: async () => ({ output: { ok: true } }),
    });

    // Exactly three checkpoints: after pre, after the parallel block, after
    // post. Nothing from inside the branches — a crash mid-parallel resumes
    // from BEFORE the block and re-executes every branch.
    expect(checkpoints.map((cp) => cp.steps.length)).toEqual([2, 1, 0]);
    expect(checkpoints[0].steps[0]).toHaveProperty("parallel");
    expect(checkpoints[1].steps).toEqual([{ loop: "post" }]);
    expect(checkpoints[1].previousNode).toBe("parallel");
    expect(checkpoints[1].context).toMatchObject({
      p1: { ran: "p1" },
      p2: { ran: "p2" },
      t: { ok: true },
    });

    // Agent steps inside parallel get NO position (turn-level checkpoint
    // composition is suppressed there too); pre/post do.
    const byIndex = Object.fromEntries(positions.map((p, i) => [i, p]));
    expect(positions).toHaveLength(4); // pre, p1, p2, post
    expect(byIndex[0]).toBeDefined();
    expect(byIndex[3]).toBeDefined();
    expect(positions.filter((p) => p === undefined)).toHaveLength(2);
  });

  it("hands runLoop its position: the in-flight step first, then the composed tail", async () => {
    const executor = new PipelineExecutor();
    const positions: Array<PipelineStepPosition | undefined> = [];

    await executor.execute({
      loops: { a: {}, b: {} },
      pipeline: { steps: [{ loop: "a" }, { loop: "b" }] },
      onCheckpoint: async () => {},
      runLoop: async (_name, _loop, _context, position) => {
        positions.push(position);
        return { output: {} };
      },
    });

    expect(positions[0]?.steps).toEqual([{ loop: "a" }, { loop: "b" }]);
    expect(positions[0]?.previousNode).toBeUndefined();
    expect(positions[1]?.steps).toEqual([{ loop: "b" }]);
    expect(positions[1]?.previousNode).toBe("a");
  });

  it("without onCheckpoint nothing changes: no position, no checkpoint machinery", async () => {
    const executor = new PipelineExecutor();
    const positions: Array<PipelineStepPosition | undefined> = [];

    await executor.execute({
      loops: { a: {} },
      pipeline: { steps: [{ loop: "a" }] },
      runLoop: async (_name, _loop, _context, position) => {
        positions.push(position);
        return { output: {} };
      },
    });

    expect(positions).toEqual([undefined]);
  });

  it("a throwing checkpoint sink never fails the pipeline", async () => {
    const executor = new PipelineExecutor();
    const result = await executor.execute({
      loops: { a: {}, b: {} },
      pipeline: { steps: [{ loop: "a" }, { loop: "b" }] },
      onCheckpoint: async () => {
        throw new Error("store went away");
      },
      runLoop: async (name) => ({ output: { ran: name } }),
    });

    expect(result.context).toMatchObject({ a: { ran: "a" }, b: { ran: "b" } });
  });
});
