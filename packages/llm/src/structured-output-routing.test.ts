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
    expect(needsSeparateStructuredOutputReasoningPass(gatewayAnthropic, "medium", reasoning)).toBe(true);
    expect(providerOptionsForStructuredOutputPass(
      gatewayAnthropic,
      "medium",
      reasoning,
    )).toEqual({
      anthropic: { structuredOutputMode: "auto" },
      gateway: { order: ["anthropic"] },
    });
  });

  it("uses the effective provider thinking when reasoning was defaulted by the host", () => {
    expect(needsSeparateStructuredOutputReasoningPass(
      gatewayAnthropic,
      undefined,
      reasoning,
    )).toBe(true);
    expect(providerOptionsForStructuredOutputPass(
      gatewayAnthropic,
      undefined,
      reasoning,
    )).toEqual({
      anthropic: { structuredOutputMode: "auto" },
      gateway: { order: ["anthropic"] },
    });
  });

  it.each([
    [{ provider: "anthropic", runtimeMode: "provider" as const }, "medium", reasoning],
    [gatewayAnthropic, "off", { anthropic: { structuredOutputMode: "auto" } }],
    [{ provider: "openai", runtimeMode: "gateway" as const }, "medium", reasoning],
    [gatewayAnthropic, undefined, { anthropic: { structuredOutputMode: "auto" } }],
  ])("preserves provider options when the route does not conflict: %#", (route, level, options) => {
    expect(needsSeparateStructuredOutputReasoningPass(route, level, options)).toBe(false);
    expect(providerOptionsForStructuredOutputPass(route, level, options)).toBe(options);
  });
});
