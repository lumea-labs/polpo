import { describe, expect, it, vi } from "vitest";
import type { CompletionRouteDeps } from "../completions.js";
import {
  buildRuntimeAgentPrompt,
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
