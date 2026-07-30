import { describe, expect, it } from "vitest";
import { buildLoopResumeState } from "./project-loop-runner.js";

describe("buildLoopResumeState", () => {
  const continuation = {
    context: { draft: { ready: true } },
    steps: [{ loop: "review" }],
    previousNode: "prepare",
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

  it("does not create a checkpoint without a continuation", () => {
    expect(buildLoopResumeState(undefined, [], [], undefined, "enforce"))
      .toBeUndefined();
  });
});
