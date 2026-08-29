import { describe, expect, it } from "vitest";
import { mapReasoningToProviderOptions } from "./provider-factory.js";

describe("mapReasoningToProviderOptions", () => {
  it.each([
    ["minimal", "low"],
    ["low", "low"],
    ["medium", "medium"],
    ["high", "high"],
    ["xhigh", "high"],
  ] as const)(
    "requests an OpenAI reasoning summary for %s effort",
    (level, effort) => {
      expect(mapReasoningToProviderOptions("openai", level, 8192, "gpt-5"))
        .toEqual({
          openai: {
            reasoningEffort: effort,
            reasoningSummary: "auto",
          },
        });
    },
  );

  it.each([undefined, "off"] as const)(
    "does not request OpenAI reasoning or summaries when level is %s",
    (level) => {
      expect(mapReasoningToProviderOptions("openai", level, 8192, "gpt-5"))
        .toBeUndefined();
    },
  );

  it("does not add OpenAI summary options to other providers", () => {
    expect(mapReasoningToProviderOptions("google", "medium", 1000, "gemini-2.5-pro"))
      .toEqual({
        google: {
          thinkingConfig: {
            thinkingBudget: 500,
          },
        },
      });
  });
});
