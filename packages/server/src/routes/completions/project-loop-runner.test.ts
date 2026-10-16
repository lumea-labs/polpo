import { describe, expect, it, vi } from "vitest";
import { createToolInvocationContext, MemoryLoopRunStore } from "@polpo-ai/core";
import { RuntimeHookEngine } from "@polpo-ai/core/runtime-hooks";
import type { CompletionRouteDeps } from "../completions.js";
import {
  buildLoopResumeState,
  resumeProjectLoopRun,
  runProjectLoopCompletion,
} from "./project-loop-runner.js";

describe("buildLoopResumeState", () => {
  const continuation = {
    context: { draft: { ready: true } },
    steps: [{ loop: "review" }],
    previousNode: "prepare",
    previousStepKey: "prepare_step",
  };

  it("pins enforced context trust across approval checkpoints", () => {
    const state = buildLoopResumeState(
      continuation,
      [{ role: "user", content: "Continue" }],
      ["Developer instruction"],
      [{ type: "policy", id: "approve-release", hook: "tool:before" }],
      "enforce",
    );

    expect(state).toEqual(expect.objectContaining({
      context: continuation.context,
      steps: continuation.steps,
      previousNode: "prepare",
      previousStepKey: "prepare_step",
      approvedGates: [{
        type: "policy",
        id: "approve-release",
        hook: "tool:before",
      }],
      runtime: {
        aiMessages: [{ role: "user", content: "Continue" }],
        extraSystemParts: ["Developer instruction"],
        contextTrust: "enforce",
      },
      attempts: 0,
    }));
  });

  it("keeps legacy checkpoints byte-compatible when context trust is off", () => {
    const state = buildLoopResumeState(
      continuation,
      [],
      [],
      undefined,
      "off",
    );

    expect(state?.runtime).toEqual({
      aiMessages: [],
      extraSystemParts: [],
    });
    expect(state?.runtime).not.toHaveProperty("contextTrust");
  });

  it("pins activated skills across approval checkpoints", () => {
    const state = buildLoopResumeState(
      continuation,
      [],
      [],
      undefined,
      "off",
      ["frontend-design"],
    );

    expect(state?.runtime).toEqual({
      aiMessages: [],
      extraSystemParts: [],
      activatedSkills: ["frontend-design"],
    });
  });

  it("pins the parallel tool preference across approval checkpoints", () => {
    const state = buildLoopResumeState(
      continuation,
      [],
      [],
      undefined,
      "off",
      [],
      true,
    );

    expect(state?.runtime).toEqual({
      aiMessages: [],
      extraSystemParts: [],
      parallelToolCalls: true,
    });
  });

  it("pins every temporary tool restriction across approval checkpoints", () => {
    const state = buildLoopResumeState(
      continuation,
      [],
      [],
      undefined,
      "off",
      [],
      false,
      ["site_*"],
      ["site_checkout"],
      ["site_checkout", "site_validate"],
    );

    expect(state?.runtime).toMatchObject({
      requestAllowedTools: ["site_*"],
      executionAllowedTools: ["site_checkout"],
      grantAllowedTools: ["site_checkout", "site_validate"],
    });
  });

  it("does not create a checkpoint without a continuation", () => {
    expect(buildLoopResumeState(undefined, [], [], undefined, "enforce"))
      .toBeUndefined();
  });

  it("rehydrates private tool identity through the host without persisting it", async () => {
    const store = new MemoryLoopRunStore();
    await store.createRun({
      id: "looprun-1",
      loop: { name: "resume-loop" },
      agentName: "assistant",
      sessionId: "session-1",
      user: "user-1",
      context: { request: { metadata: { publicRef: "project-1" } } },
      metadata: {
        runtimeInvocation: {
          surface: "channel",
          source: "channel",
          scope: { key: "workspace-1", version: "3" },
        },
      },
    });
    await store.updateRun("looprun-1", {
      status: "approval_approved",
      resume: {
        context: { request: { metadata: { publicRef: "project-1" } } },
        steps: [{ type: "tool", tool: "probe", next: "end" } as any],
        createdAt: new Date().toISOString(),
      },
    });
    const captured: unknown[] = [];
    const deps = {
      getAgents: async () => [{ name: "assistant", model: "test" }],
      getConfig: () => ({}),
      getMemoryStore: () => null,
      getSessionStore: () => null,
      getStore: () => null,
      emit: () => {},
      getLoopRunStore: () => store,
      getProjectLoop: async () => ({
        name: "resume-loop",
        start: "probe",
        steps: { probe: { type: "tool", tool: "probe", next: "end" } },
      }),
      resolveAgentTools: async (_agent: unknown, _scope: unknown, invocation: unknown) => {
        captured.push(invocation);
        return {
          tools: [{ name: "probe", parameters: { type: "object", properties: {} } }],
          executor: async () => "ok",
        };
      },
      resolveResumedToolInvocation: vi.fn(async () => createToolInvocationContext({
        requestId: "provider-event-1",
        runId: "looprun-1",
        sessionId: "session-1",
        user: "user-1",
        metadata: { grant: "secret-grant" },
        scope: { key: "workspace-1", version: "3" },
        surface: "channel",
      })),
      buildAgentPrompt: () => "",
      resolveAgentModel: async () => { throw new Error("model should not run"); },
    } as unknown as CompletionRouteDeps;

    await resumeProjectLoopRun({ deps, runId: "looprun-1" });

    expect(deps.resolveResumedToolInvocation).toHaveBeenCalledOnce();
    expect(captured[0]).toMatchObject({ metadata: { grant: "secret-grant" } });
    expect(captured[0]).toMatchObject({
      scope: { key: "workspace-1", version: "3" },
    });
    const updated = await store.getRun("looprun-1");
    expect(JSON.stringify(updated)).not.toContain("secret-grant");
  });

  it("fails closed when trusted scope changes across a loop resume", async () => {
    const store = new MemoryLoopRunStore();
    await store.createRun({
      id: "looprun-scope-drift",
      loop: { name: "resume-loop" },
      agentName: "assistant",
      sessionId: "session-1",
      user: "user-1",
      context: {},
      metadata: {
        runtimeInvocation: {
          surface: "channel",
          source: "channel",
          scope: { key: "personal", version: "1" },
        },
      },
    });
    await store.updateRun("looprun-scope-drift", {
      status: "approval_approved",
      resume: {
        context: {},
        steps: [{ type: "tool", tool: "probe", next: "end" } as any],
        createdAt: new Date().toISOString(),
      },
    });
    const deps = {
      getAgents: async () => [{ name: "assistant", model: "test" }],
      getConfig: () => ({}),
      getMemoryStore: () => null,
      getSessionStore: () => null,
      getStore: () => null,
      emit: () => {},
      getLoopRunStore: () => store,
      getProjectLoop: async () => ({
        name: "resume-loop",
        start: "probe",
        steps: { probe: { type: "tool", tool: "probe", next: "end" } },
      }),
      resolveResumedToolInvocation: async () => createToolInvocationContext({
        requestId: "provider-event-2",
        runId: "looprun-scope-drift",
        sessionId: "session-1",
        user: "user-1",
        scope: { key: "work", version: "1" },
        surface: "channel",
      }),
    } as unknown as CompletionRouteDeps;

    await expect(resumeProjectLoopRun({
      deps,
      runId: "looprun-scope-drift",
    })).rejects.toThrow(/scope does not match/i);
  });
});

describe("project-loop Runtime Hooks lifecycle", () => {
  function deterministicDeps(options: {
    hooks: RuntimeHookEngine;
    execute?: (name: string) => Promise<string>;
  }): CompletionRouteDeps {
    return {
      getAgents: async () => [],
      getConfig: () => ({}),
      getMemoryStore: () => null,
      getSessionStore: () => null,
      getStore: () => null,
      emit: () => {},
      resolveRuntimeHooks: async () => options.hooks,
      resolveAgentTools: async () => ({
        tools: [
          { name: "prepare", parameters: { type: "object", properties: {} } },
          { name: "publish", parameters: { type: "object", properties: {} } },
        ],
        executor: async (name: string) => options.execute?.(name) ?? JSON.stringify({ ok: true }),
      }),
    } as unknown as CompletionRouteDeps;
  }

  it("emits outer lifecycle events for deterministic and agent-independent steps", async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const hooks = new RuntimeHookEngine({
      definitions: [
        "loop:start",
        "step:before",
        "loop:transition",
        "step:after",
        "loop:end",
      ].map((event, index) => ({
        id: `observe-${index}`,
        event: event as any,
        mode: "observe" as const,
        handler: { type: "tool" as const, tool: "audit" },
      })),
      host: {
        execute: async ({ envelope }) => {
          events.push({ event: envelope.event, data: envelope.data });
        },
      },
    });

    await runProjectLoopCompletion({
      deps: deterministicDeps({ hooks }),
      agentConfig: { name: "support", model: "test" },
      projectLoop: {
        name: "site",
        start: "prepare",
        steps: {
          prepare: { type: "tool", tool: "prepare", next: "publish" },
          publish: { type: "tool", tool: "publish", next: "end" },
        },
      } as any,
      aiMessages: [],
      extraSystemParts: [],
    });

    expect(events.map(({ event }) => event)).toEqual([
      "loop:start",
      "step:before",
      "step:after",
      "loop:transition",
      "step:before",
      "step:after",
      "loop:end",
    ]);
    expect(events[4]?.data).toMatchObject({ loop: "site", step: "publish", kind: "tool" });
  });

  it("blocks a deterministic step before its tool side effect", async () => {
    const executed: string[] = [];
    const hooks = new RuntimeHookEngine({
      definitions: [{
        id: "protect-publish",
        event: "step:before",
        handler: { type: "tool", tool: "policy" },
      }],
      host: {
        execute: async ({ envelope }) => envelope.data.step === "publish"
          ? { decision: { action: "deny", reason: "publish disabled" } }
          : { decision: { action: "allow" } },
      },
    });

    await expect(runProjectLoopCompletion({
      deps: deterministicDeps({
        hooks,
        execute: async (name) => {
          executed.push(name);
          return JSON.stringify({ ok: true });
        },
      }),
      agentConfig: { name: "support", model: "test" },
      projectLoop: {
        name: "site",
        start: "prepare",
        steps: {
          prepare: { type: "tool", tool: "prepare", next: "publish" },
          publish: { type: "tool", tool: "publish", next: "end" },
        },
      } as any,
      aiMessages: [],
      extraSystemParts: [],
    })).rejects.toThrow("Runtime hook deny: publish disabled");

    expect(executed).toEqual(["prepare"]);
  });
});
