import { describe, expect, it } from "vitest";
import { AddAgentSchema, UpdateAgentSchema } from "./schemas.js";

describe("agent loop API contract", () => {
  it("accepts loops on agent create/update payloads", () => {
    const loops = {
      classify: {
        systemPrompt: "Classify the incoming request.",
        tools: ["read"],
        output: { schema: { type: "object" } },
      },
      answer: {
        systemPrompt: "Answer the request.",
      },
    };
    const pipeline = {
      mode: "sequential" as const,
      context: "shared" as const,
      steps: [{ loop: "classify" }, { loop: "answer", when: "output.route == 'answer'" }],
    };

    expect(AddAgentSchema.parse({
      name: "loop-agent",
      runtime: "polpo-runner",
      loops,
      pipeline,
    })).toMatchObject({ runtime: "polpo-runner", loops, pipeline });

    expect(UpdateAgentSchema.parse({
      loops,
      pipeline,
    })).toMatchObject({ loops, pipeline });
  });

  it("rejects create payloads whose pipeline points at a missing loop", () => {
    const parsed = AddAgentSchema.safeParse({
      name: "loop-agent",
      loops: { classify: {} },
      pipeline: { steps: [{ loop: "missing" }] },
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain('unknown loop "missing"');
  });
});
