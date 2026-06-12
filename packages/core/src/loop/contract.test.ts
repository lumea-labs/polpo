import { describe, expect, it } from "vitest";
import { agentLoopConfigSchema } from "../schemas.js";

describe("agentLoopConfigSchema", () => {
  it("accepts a loop collection with a deterministic pipeline", () => {
    const parsed = agentLoopConfigSchema.parse({
      name: "router-agent",
      runtime: "polpo-runner",
      loops: {
        classify: {
          systemPrompt: "Classify the request.",
          tools: ["read"],
          output: {
            schema: {
              type: "object",
              properties: { route: { type: "string" } },
            },
          },
          stopWhen: { expression: "output.route != null" },
        },
        answer: {
          systemPrompt: "Answer the request.",
          tools: ["write"],
        },
      },
      pipeline: {
        context: "shared",
        steps: [
          { loop: "classify" },
          {
            switch: {
              cases: [
                { when: "output.route == 'answer'", steps: [{ loop: "answer" }] },
              ],
            },
          },
        ],
      },
    });

    expect(Object.keys(parsed.loops)).toEqual(["classify", "answer"]);
    expect(parsed.pipeline?.steps).toHaveLength(2);
  });

  it("rejects pipelines that reference unknown loops", () => {
    const parsed = agentLoopConfigSchema.safeParse({
      loops: {
        classify: {},
      },
      pipeline: {
        steps: [{ loop: "missing" }],
      },
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain('unknown loop "missing"');
  });
});
