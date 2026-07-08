import { describe, expect, it } from "vitest";
import { resolveLoopSelection } from "./selector.js";

describe("resolveLoopSelection", () => {
  it("returns undefined when no loop is requested or configured (agent runs as-is, no synthesized default)", () => {
    const agent = { name: "agent", model: "base", allowedTools: ["read"], systemPrompt: "base" };
    expect(resolveLoopSelection(agent)).toBeUndefined();
  });

  it("applies requested loop overrides to the effective agent", () => {
    const selected = resolveLoopSelection({
      name: "agent",
      model: "base",
      reasoning: "low",
      allowedTools: ["read", "write"],
      skills: ["general"],
      systemPrompt: "base prompt",
      loops: {
        plan: {
          systemPrompt: "plan prompt",
          tools: ["read"],
          skills: ["planning"],
          model: "planner",
          reasoning: "high",
          maxTurns: 3,
        },
      },
    }, "plan")!;

    expect(selected.loop.name).toBe("plan");
    expect(selected.agent).toMatchObject({
      model: "planner",
      reasoning: "high",
      allowedTools: ["read"],
      skills: ["planning"],
      maxTurns: 3,
    });
    expect(selected.agent.systemPrompt).toContain("base prompt");
    expect(selected.agent.systemPrompt).toContain("## Active loop: plan");
    expect(selected.agent.systemPrompt).toContain("plan prompt");
  });

  it("inherits agent skills when a requested loop does not narrow them", () => {
    const selected = resolveLoopSelection({
      name: "agent",
      skills: ["general", "testing"],
      loops: {
        verify: {
          tools: ["read", "bash"],
        },
      },
    }, "verify")!;

    expect(selected.agent.skills).toEqual(["general", "testing"]);
  });

  it("selects an assigned project-level loop without requiring inline definitions", () => {
    const agent = {
      name: "agent",
      model: "base",
      assignedLoops: ["coding-flow"],
      defaultLoop: "coding-flow",
    };

    expect(resolveLoopSelection(agent)!.name).toBe("coding-flow");
    expect(resolveLoopSelection(agent, "coding-flow")!.agent).toBe(agent);
  });

  it("throws a clear error for unknown requested loops", () => {
    expect(() => resolveLoopSelection({
      name: "agent",
      loops: { plan: {} },
    }, "build")).toThrow('Unknown loop "build". Available loops: plan');
  });
});
