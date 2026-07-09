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

  it("selects an assigned project-level loop only when requested explicitly (no default)", () => {
    const agent = {
      name: "agent",
      model: "base",
      assignedLoops: ["coding-flow"],
    };

    // No implicit default: nothing runs unless the loop is requested.
    expect(resolveLoopSelection(agent)).toBeUndefined();
    // Explicit request resolves the assigned loop without inline definitions.
    const selected = resolveLoopSelection(agent, "coding-flow")!;
    expect(selected.name).toBe("coding-flow");
    expect(selected.agent).toBe(agent);
  });

  it("throws a clear error for unknown requested loops", () => {
    expect(() => resolveLoopSelection({
      name: "agent",
      loops: { plan: {} },
    }, "build")).toThrow('Unknown loop "build". Available loops: plan');
  });
});
