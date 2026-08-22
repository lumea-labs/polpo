import { describe, expect, it } from "vitest";
import {
  buildLoopStepAgent,
  LoopInteractiveToolUnsupportedError,
} from "./step-helpers.js";

describe("buildLoopStepAgent interactive tool boundary", () => {
  const agent = {
    name: "assistant",
    allowedTools: ["read", "ask_user_question", "write"],
  };

  it("removes implicitly inherited client interaction tools", () => {
    const stepAgent = buildLoopStepAgent(agent, "implement", {});

    expect(stepAgent.allowedTools).toEqual(["read", "write"]);
    expect(agent.allowedTools).toEqual(["read", "ask_user_question", "write"]);
  });

  it("rejects an explicitly configured client interaction tool", () => {
    expect(() => buildLoopStepAgent(agent, "implement", {
      tools: ["read", "ask_user_question"],
    })).toThrowError(expect.objectContaining({
      code: "loop_interactive_tool_not_supported",
      tool: "ask_user_question",
      stepName: "implement",
    }));
  });

  it("rejects a loop-level forced client interaction tool", () => {
    expect(() => buildLoopStepAgent(agent, "implement", {
      tools: ["read"],
      toolChoice: { mode: "required", tool: "ask_user_question" },
    })).toThrow(LoopInteractiveToolUnsupportedError);
  });

  it("rejects an inherited forced client interaction tool", () => {
    expect(() => buildLoopStepAgent({
      ...agent,
      toolChoice: { mode: "required", tool: "ask_user_question" },
    }, "implement", {})).toThrow(LoopInteractiveToolUnsupportedError);
  });

  it("preserves the agent ceiling while exposing ordinary step tool choice", () => {
    const stepAgent = buildLoopStepAgent(agent, "implement", {
      allowedTools: ["write"],
      toolChoice: { mode: "required", tool: "write" },
    });

    expect(stepAgent.allowedTools).toEqual(["read", "write"]);
    expect(stepAgent.toolChoice).toEqual({ mode: "required", tool: "write" });
  });
});
