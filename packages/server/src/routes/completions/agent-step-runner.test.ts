import { describe, expect, it, vi } from "vitest";
import type { CompletionRouteDeps } from "../completions.js";
import { buildRuntimeAgentPrompt } from "./agent-step-runner.js";

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
