import { describe, expect, it, vi } from "vitest";
import {
  prepareChatCompletionExecution,
  type CompletionRouteDeps,
} from "../completions.js";

function deps(overrides: Partial<CompletionRouteDeps> = {}): CompletionRouteDeps {
  return {
    getAgents: async () => [{
      name: "builder",
      model: "mock",
      skills: ["frontend-design", "accessibility-audit"],
      assignedLoops: ["review"],
      loops: {
        review: {
          skills: ["accessibility-audit"],
        },
      },
    }],
    getConfig: () => ({ settings: {} }),
    getMemoryStore: () => null,
    getProjectLoop: async () => ({
      name: "review",
      start: "review",
      steps: {
        review: { type: "agent", next: "end" },
      },
    }),
    getSessionStore: () => null,
    getStore: () => null,
    emit: () => {},
    resolveAgentModel: async () => ({
      model: {
        id: "mock",
        provider: "mock",
        aiModel: {} as any,
        contextWindow: 200_000,
        maxTokens: 8_192,
      },
    }),
    buildRuntimePrompt: async () => "runtime prompt",
    buildAgentPrompt: async () => "legacy prompt",
    resolveAgentTools: async () => ({
      tools: [],
      executor: async () => "ok",
    }),
    ...overrides,
  };
}

const userMessage = [{ role: "user" as const, content: "Build the page" }];
const requestBase = { messages: userMessage, stream: false } as const;

describe("per-request skill activation", () => {
  it("passes explicitly requested skills to prompt assembly without narrowing agent skills", async () => {
    const buildRuntimePrompt = vi.fn(async () => "runtime prompt");
    const resolveAgentTools = vi.fn(async () => ({
      tools: [],
      executor: async () => "ok",
    }));

    const prepared = await prepareChatCompletionExecution(deps({
      buildRuntimePrompt,
      resolveAgentTools,
    }), {
      ...requestBase,
      agent: "builder",
      polpo: { skills: ["frontend-design"] },
    });

    expect(prepared.kind).toBe("chat");
    expect(buildRuntimePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "builder",
        skills: ["frontend-design", "accessibility-audit"],
      }),
      expect.objectContaining({
        activatedSkills: ["frontend-design"],
      }),
    );
    expect(resolveAgentTools).toHaveBeenCalledWith(
      expect.objectContaining({
        skills: ["frontend-design", "accessibility-audit"],
      }),
      undefined,
      expect.any(Object),
    );
  });

  it("rejects a skill that is not assigned to the effective agent", async () => {
    const buildRuntimePrompt = vi.fn(async () => "must not run");
    const prepared = await prepareChatCompletionExecution(deps({ buildRuntimePrompt }), {
      ...requestBase,
      agent: "builder",
      polpo: { skills: ["security-review"] },
    });

    expect(prepared).toEqual({
      kind: "error",
      status: 400,
      body: {
        error: {
          message: 'Skill "security-review" is not assigned to agent "builder"',
          type: "invalid_request_error",
          code: "skill_not_assigned",
        },
      },
    });
    expect(buildRuntimePrompt).not.toHaveBeenCalled();
  });

  it("requires agent-direct mode", async () => {
    const prepared = await prepareChatCompletionExecution(deps(), {
      ...requestBase,
      polpo: { skills: ["frontend-design"] },
    });

    expect(prepared).toEqual({
      kind: "error",
      status: 400,
      body: {
        error: {
          message: "Per-request skills require an explicit agent",
          type: "invalid_request_error",
          code: "skill_activation_requires_agent",
        },
      },
    });
  });

  it("validates against the loop's effective skill subset", async () => {
    const prepared = await prepareChatCompletionExecution(deps(), {
      ...requestBase,
      agent: "builder",
      loop: "review",
      polpo: { skills: ["frontend-design"] },
    });

    expect(prepared.kind).toBe("error");
    if (prepared.kind !== "error") throw new Error("Expected error");
    expect(prepared.body.error.code).toBe("skill_not_assigned");
  });

  it("carries an allowed activation into project-loop execution", async () => {
    const prepared = await prepareChatCompletionExecution(deps(), {
      ...requestBase,
      agent: "builder",
      loop: "review",
      polpo: { skills: ["accessibility-audit"] },
    });

    expect(prepared.kind).toBe("project-loop");
    if (prepared.kind !== "project-loop") throw new Error("Expected project loop");
    expect(prepared.activatedSkills).toEqual(["accessibility-audit"]);
  });

  it("does not infer skills from slash-prefixed message text", async () => {
    const buildRuntimePrompt = vi.fn(async () => "runtime prompt");
    const prepared = await prepareChatCompletionExecution(deps({ buildRuntimePrompt }), {
      ...requestBase,
      agent: "builder",
      messages: [{ role: "user", content: "/frontend-design Build the page" }],
    });

    expect(prepared.kind).toBe("chat");
    expect(buildRuntimePrompt).toHaveBeenCalledWith(
      expect.any(Object),
      expect.not.objectContaining({ activatedSkills: expect.anything() }),
    );
  });
});
