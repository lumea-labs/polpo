import { describe, expect, it } from "vitest";
import { AddAgentSchema, UpdateAgentSchema } from "./schemas.js";

describe("agent loop API contract", () => {
  it("accepts project-level loop assignments on agents", () => {
    expect(AddAgentSchema.parse({
      name: "loop-agent",
      assignedLoops: ["coding-flow"],
    })).toMatchObject({ assignedLoops: ["coding-flow"] });

    expect(UpdateAgentSchema.parse({
      assignedLoops: ["coding-flow", "support-flow"],
    })).toMatchObject({ assignedLoops: ["coding-flow", "support-flow"] });
  });

  it("accepts structured model policies on agent create/update payloads", () => {
    const model = {
      primary: "anthropic/claude-sonnet-4",
      fallbacks: ["openai/gpt-4o-mini", "xai/grok-4.1-fast-reasoning"],
    };

    expect(AddAgentSchema.parse({
      name: "fallback-agent",
      model,
    })).toMatchObject({ model });

    expect(UpdateAgentSchema.parse({
      model,
    })).toMatchObject({ model });
  });

  it("rejects malformed structured model policies", () => {
    expect(UpdateAgentSchema.safeParse({
      model: { primary: "", fallbacks: ["openai/gpt-4o-mini"] },
    }).success).toBe(false);

    expect(UpdateAgentSchema.safeParse({
      model: {
        primary: "anthropic/claude-sonnet-4",
        fallbacks: [
          "openai/gpt-4o-mini",
          "xai/grok-4.1-fast-reasoning",
          "google/gemini-2.5-pro",
          "groq/llama-3.3-70b-versatile",
        ],
      },
    }).success).toBe(false);
  });

  it("strips legacy inline loops from agent create/update payloads", () => {
    const loops = {
      classify: {
        systemPrompt: "Classify the incoming request.",
        tools: ["read"],
        skills: ["classification"],
        toolChoice: { mode: "required", tool: "read" },
        output: { schema: { type: "object" } },
      },
      answer: {
        systemPrompt: "Answer the request.",
      },
    };
    const pipeline = {
      mode: "sequential" as const,
      context: "shared" as const,
      steps: [
        { tool: "clone_repository", input: { repoUrl: "https://github.com/acme/app.git" }, saveAs: "repo.clone" },
        { loop: "classify" },
        { loop: "answer", when: "output.route == 'answer'" },
      ],
    };

    expect(AddAgentSchema.parse({
      name: "loop-agent",
      runtime: "polpo-runner",
      loops,
      pipeline,
    })).toEqual({ name: "loop-agent", runtime: "polpo-runner" });

    expect(UpdateAgentSchema.parse({
      loops,
      pipeline,
    })).toEqual({});
  });
});
