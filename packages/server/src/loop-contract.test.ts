import { describe, expect, it } from "vitest";
import {
  AddAgentSchema,
  CreateTaskSchema,
  UpdateAgentSchema,
  UpdateTaskSchema,
} from "./schemas.js";

describe("agent loop API contract", () => {
  it("accepts explicit model profiles without reinterpreting legacy strings", () => {
    expect(AddAgentSchema.parse({
      name: "profiled",
      model: { profile: "balanced" },
      allowedModelProfiles: ["balanced", "fast"],
    })).toMatchObject({
      model: { profile: "balanced" },
      allowedModelProfiles: ["balanced", "fast"],
    });

    expect(UpdateAgentSchema.parse({
      model: "openai",
      allowedModelProfiles: [],
    })).toEqual({
      model: "openai",
      allowedModelProfiles: [],
    });
  });

  it("keeps direct and alias models pinned unless automatic routing is explicit", () => {
    expect(AddAgentSchema.parse({
      name: "pinned-direct",
      model: "openai/gpt-4o-mini",
    })).not.toHaveProperty("modelRouting");
    expect(UpdateAgentSchema.parse({
      model: { profile: "balanced" },
      modelRouting: { mode: "off" },
    })).toMatchObject({
      model: { profile: "balanced" },
      modelRouting: { mode: "off" },
    });
    expect(UpdateAgentSchema.parse({
      allowedModelProfiles: ["fast", "balanced"],
      modelRouting: { mode: "auto" },
    })).toMatchObject({
      allowedModelProfiles: ["fast", "balanced"],
      modelRouting: { mode: "auto" },
    });
  });

  it.each([
    {},
    { mode: "future" },
    { mode: "auto", hidden: true },
  ])("rejects unsafe agent model routing config %#", (modelRouting) => {
    expect(UpdateAgentSchema.safeParse({ modelRouting }).success).toBe(false);
  });

  it("rejects ambiguous profile references and model policies instead of stripping fields", () => {
    expect(AddAgentSchema.safeParse({
      name: "ambiguous-profile",
      model: {
        profile: "fast",
        primary: "openai/gpt-4o-mini",
      },
    }).success).toBe(false);

    expect(UpdateAgentSchema.safeParse({
      model: {
        primary: "openai/gpt-4o-mini",
        providerOptions: { temperature: 0 },
      },
    }).success).toBe(false);
  });

  it("accepts project-level loop assignments on agents", () => {
    expect(AddAgentSchema.parse({
      name: "loop-agent",
      assignedLoops: ["coding-flow"],
    })).toMatchObject({ assignedLoops: ["coding-flow"] });

    expect(UpdateAgentSchema.parse({
      assignedLoops: ["coding-flow", "support-flow"],
    })).toMatchObject({ assignedLoops: ["coding-flow", "support-flow"] });
  });

  it("accepts a bounded, explicitly enabled execution router", () => {
    const executionRouter = {
      mode: "auto" as const,
      allowedLoops: ["coding-flow", "support-flow"],
      minConfidence: 0.82,
      timeoutMs: 750,
      maxInputChars: 2_048,
      rules: [{
        id: "paid-coding",
        mode: "loop" as const,
        loop: "coding-flow",
        when: {
          surfaces: ["agent"],
          allLabels: ["plan:paid"],
        },
      }],
      loopHints: {
        "coding-flow": "Use for deterministic coding workflows.",
      },
      guidance: "Prefer direct execution for simple questions.",
    };

    expect(AddAgentSchema.parse({
      name: "router-agent",
      assignedLoops: ["coding-flow", "support-flow"],
      executionRouter,
    })).toMatchObject({ executionRouter });
    expect(UpdateAgentSchema.parse({
      executionRouter: { mode: "off" },
    })).toMatchObject({ executionRouter: { mode: "off" } });
  });

  it.each([
    { mode: "auto" },
    { mode: "auto", allowedLoops: [] },
    { mode: "auto", allowedLoops: ["ok"], minConfidence: -0.1 },
    { mode: "auto", allowedLoops: ["ok"], timeoutMs: 0 },
    { mode: "auto", allowedLoops: ["ok"], timeoutMs: 60_001 },
    { mode: "auto", allowedLoops: ["ok"], maxInputChars: 16_385 },
    { mode: "auto", allowedLoops: ["ok"], unknown: true },
    { mode: "auto", allowedLoops: [" whitespace "] },
    { mode: "auto", allowedLoops: ["control\nname"] },
    {
      mode: "auto",
      allowedLoops: ["ok"],
      rules: [{ id: "empty", mode: "direct", when: {} }],
    },
    {
      mode: "auto",
      allowedLoops: ["ok"],
      rules: [{
        id: "widen",
        mode: "loop",
        loop: "other",
        when: { sources: ["request"] },
      }],
    },
    {
      mode: "auto",
      allowedLoops: ["ok"],
      rules: [
        { id: "duplicate", mode: "direct", when: { sources: ["request"] } },
        { id: "duplicate", mode: "direct", when: { sources: ["task"] } },
      ],
    },
    {
      mode: "auto",
      allowedLoops: ["ok"],
      loopHints: { other: "Not allowed" },
    },
    {
      mode: "auto",
      allowedLoops: ["ok"],
      guidance: "x".repeat(2_001),
    },
  ])("rejects unsafe execution router config %#", (executionRouter) => {
    expect(UpdateAgentSchema.safeParse({ executionRouter }).success).toBe(false);
  });

  it("accepts bounded routing labels on task create and update payloads", () => {
    expect(CreateTaskSchema.parse({
      title: "Paid export",
      description: "Build the export",
      assignTo: "agent-1",
      routing: { labels: ["plan:paid", "request:export"] },
    })).toMatchObject({
      routing: { labels: ["plan:paid", "request:export"] },
    });
    expect(UpdateTaskSchema.parse({
      routing: { labels: ["plan:free"] },
    })).toEqual({
      routing: { labels: ["plan:free"] },
    });
  });

  it("rejects unbounded or malformed task routing labels", () => {
    expect(CreateTaskSchema.safeParse({
      title: "Too many labels",
      description: "Invalid",
      assignTo: "agent-1",
      routing: {
        labels: Array.from({ length: 17 }, (_, index) => `label:${index}`),
      },
    }).success).toBe(false);
    expect(UpdateTaskSchema.safeParse({
      routing: { labels: ["x".repeat(65)] },
    }).success).toBe(false);
    expect(UpdateTaskSchema.safeParse({
      routing: { labels: ["ok"], secret: "must-not-pass" },
    }).success).toBe(false);
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
