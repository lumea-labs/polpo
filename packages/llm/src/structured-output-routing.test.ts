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

  it("keeps Anthropic Gateway thinking on native structured-output turns", () => {
    expect(needsSeparateStructuredOutputReasoningPass(gatewayAnthropic, "medium", reasoning)).toBe(false);
    expect(providerOptionsForStructuredOutputPass(
      gatewayAnthropic,
      "medium",
      reasoning,
    )).toBe(reasoning);
  });

  it("keeps effective provider thinking when reasoning was defaulted by the host", () => {
    expect(needsSeparateStructuredOutputReasoningPass(
      gatewayAnthropic,
      undefined,
      reasoning,
    )).toBe(false);
    expect(providerOptionsForStructuredOutputPass(
      gatewayAnthropic,
      undefined,
      reasoning,
    )).toBe(reasoning);
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
