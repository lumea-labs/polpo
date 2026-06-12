import { describe, expect, it } from "vitest";
import { resolveLoopSelection } from "./selector.js";

describe("resolveLoopSelection", () => {
  it("keeps current agent behavior when no loop is requested", () => {
    const agent = { name: "agent", model: "base", allowedTools: ["read"], systemPrompt: "base" };
    const selected = resolveLoopSelection(agent);

    expect(selected.name).toBe("default");
    expect(selected.agent).toBe(agent);
  });

  it("applies requested loop overrides to the effective agent", () => {
    const selected = resolveLoopSelection({
      name: "agent",
      model: "base",
      reasoning: "low",
      allowedTools: ["read", "write"],
      systemPrompt: "base prompt",
      loops: {
        plan: {
          systemPrompt: "plan prompt",
          tools: ["read"],
          model: "planner",
          reasoning: "high",
          maxTurns: 3,
        },
      },
    }, "plan");

    expect(selected.loop.name).toBe("plan");
    expect(selected.agent).toMatchObject({
      model: "planner",
      reasoning: "high",
      allowedTools: ["read"],
      maxTurns: 3,
    });
    expect(selected.agent.systemPrompt).toContain("base prompt");
    expect(selected.agent.systemPrompt).toContain("## Active loop: plan");
    expect(selected.agent.systemPrompt).toContain("plan prompt");
  });

  it("throws a clear error for unknown requested loops", () => {
    expect(() => resolveLoopSelection({
      name: "agent",
      loops: { plan: {} },
    }, "build")).toThrow('Unknown loop "build". Available loops: plan');
  });
});
