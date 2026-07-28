import { describe, expect, it, vi } from "vitest";
import type { CompletionRouteDeps } from "../completions.js";
import {
  agentConfigForModelPrimary,
  buildRuntimeAgentPrompt,
  modelSelectionForAgent,
  modelSelectionForResolvedModel,
} from "./agent-step-runner.js";

describe("buildRuntimeAgentPrompt", () => {
  it("delegates loop prompt assembly to the host when available", async () => {
    const buildRuntimePrompt = vi.fn(async () => "host loop prompt");
    const deps = {
      buildRuntimePrompt,
      buildAgentPrompt: vi.fn(() => "legacy prompt"),
    } as unknown as CompletionRouteDeps;

    const prompt = await buildRuntimeAgentPrompt(
      deps,
      { name: "agent-1" },
      ["caller context"],
      "loop context",
    );

    expect(prompt).toBe("host loop prompt");
    expect(buildRuntimePrompt).toHaveBeenCalledWith(
      { name: "agent-1" },
      {
        mode: "loop-step",
        extraSystemParts: ["caller context"],
        loopContextPart: "loop context",
        includeAgentMemory: true,
      },
    );
    expect(deps.buildAgentPrompt).not.toHaveBeenCalled();
  });
});

describe("modelSelectionForResolvedModel", () => {
  it("keeps the provider prefix on model policy selections", () => {
    expect(modelSelectionForResolvedModel({
      id: "claude-sonnet-5",
      aiModel: {} as any,
      provider: "anthropic",
      contextWindow: 200_000,
      maxTokens: 8192,
    })).toBe("anthropic/claude-sonnet-5");
  });
});

describe("agent model profile resolution", () => {
  const settings = {
    modelProfiles: {
      fast: "openai/gpt-4o-mini",
      balanced: {
        primary: "anthropic/claude-sonnet-4",
        fallbacks: [{ profile: "fast" as const }],
      },
    },
  };

  it("resolves the same concrete policy for primary adaptation and fallback execution", () => {
    const agent = {
      name: "agent-1",
      model: { profile: "balanced" },
      allowedModelProfiles: ["balanced", "fast"],
    };

    expect(agentConfigForModelPrimary(agent, settings).model).toBe(
      "anthropic/claude-sonnet-4",
    );
    expect(modelSelectionForAgent(agent, "fallback/default", settings)).toEqual({
      primary: "anthropic/claude-sonnet-4",
      fallbacks: ["openai/gpt-4o-mini"],
    });
  });

  it("preserves legacy direct model ids when profile names collide", () => {
    const collisionSettings = {
      modelProfiles: { openai: "openai/gpt-4o-mini" },
    };

    expect(modelSelectionForAgent(
      { model: "openai" },
      "fallback/default",
      collisionSettings,
    )).toBe("openai");
  });

  it("fails before provider adaptation when an agent references a disallowed profile", () => {
    expect(() => agentConfigForModelPrimary({
      model: { profile: "balanced" },
      allowedModelProfiles: ["fast"],
    }, settings)).toThrowError(expect.objectContaining({
      code: "DISALLOWED_PROFILE",
      profile: "balanced",
    }));
  });
});
