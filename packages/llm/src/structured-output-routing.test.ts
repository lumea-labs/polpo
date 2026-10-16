import { describe, expect, it } from "vitest";
import {
  needsSeparateStructuredOutputReasoningPass,
  providerOptionsForStructuredOutputPass,
} from "./structured-output-routing.js";

describe("structured output runtime routing", () => {
  const gatewayAnthropic = { provider: "anthropic", runtimeMode: "gateway" as const };
  const reasoning = {
    anthropic: {
      structuredOutputMode: "auto",
      thinking: { type: "enabled", budgetTokens: 4096 },
      effort: "medium",
    },
    gateway: { order: ["anthropic"] },
  };

  it("separates Anthropic Gateway reasoning from the terminal schema pass", () => {
    expect(needsSeparateStructuredOutputReasoningPass(gatewayAnthropic, "medium")).toBe(true);
    expect(providerOptionsForStructuredOutputPass(
      gatewayAnthropic,
      "medium",
      reasoning,
    )).toEqual({
      anthropic: { structuredOutputMode: "auto" },
      gateway: { order: ["anthropic"] },
    });
  });

  it.each([
    [{ provider: "anthropic", runtimeMode: "provider" as const }, "medium"],
    [gatewayAnthropic, "off"],
    [{ provider: "openai", runtimeMode: "gateway" as const }, "medium"],
    [gatewayAnthropic, undefined],
  ])("preserves provider options when the route does not conflict: %#", (route, level) => {
    expect(needsSeparateStructuredOutputReasoningPass(route, level)).toBe(false);
    expect(providerOptionsForStructuredOutputPass(route, level, reasoning)).toBe(reasoning);
  });
});
