import { describe, expect, it } from "vitest";
import {
  ToolCapabilityUnsupportedError,
  createEffectiveTurnPlan,
  directProviderRuntimeCapabilities,
  markToolStrictness,
  prepareToolsForRuntimeCapabilities,
} from "./model-runtime-capabilities.js";
import { toValidatedToolInputSchema } from "./tool-schema.js";

const declaration = () => ({ inputSchema: { type: "object" } }) as any;

describe("model runtime capabilities", () => {
  it.each(["openai", "google", "xai"])(
    "declares verified provider strict tools for direct %s routes",
    (provider) => {
      expect(directProviderRuntimeCapabilities(provider).providerStrictTools).toBe("supported");
    },
  );

  it.each(["groq", "mistral", "custom"])(
    "keeps unverified provider strictness conservative for %s",
    (provider) => {
      expect(directProviderRuntimeCapabilities(provider).providerStrictTools).toBe("unknown");
    },
  );

  it("does not claim Anthropic strict-tool support that its installed adapter cannot transmit", () => {
    expect(directProviderRuntimeCapabilities("anthropic")).toMatchObject({
      providerStrictTools: "unsupported",
      structuredOutput: "emulated",
    });
  });

  it("enables provider strictness only on a route declaring support", () => {
    const preferred = markToolStrictness(declaration(), "provider-preferred");
    const prepared = prepareToolsForRuntimeCapabilities(
      { lookup: preferred },
      directProviderRuntimeCapabilities("openai"),
    );
    expect(prepared.tools?.lookup).toMatchObject({ strict: true });
    expect(prepared.warnings).toEqual([]);
  });

  it("downgrades preferred strictness with a typed warning on unknown routes", () => {
    const preferred = markToolStrictness(
      { ...declaration(), strict: true },
      "provider-preferred",
    );
    const prepared = prepareToolsForRuntimeCapabilities({ lookup: preferred }, undefined);
    expect(prepared.tools?.lookup).not.toHaveProperty("strict");
    expect(prepared.warnings).toEqual([{
      type: "tool-strictness-unavailable",
      toolName: "lookup",
      requested: "provider-preferred",
      capability: "unknown",
    }]);
  });

  it("rejects required provider strictness before inference on an unproved route", () => {
    const required = markToolStrictness(declaration(), "provider-required");
    expect(() => prepareToolsForRuntimeCapabilities({ write: required }, undefined))
      .toThrow(ToolCapabilityUnsupportedError);
  });

  it("preserves the canonical provider schema on a verified direct route", () => {
    const inputSchema = toValidatedToolInputSchema({
      type: "object",
      properties: { count: { type: "integer", minimum: 2 } },
      required: ["count"],
      additionalProperties: false,
    });
    const prepared = prepareToolsForRuntimeCapabilities(
      { lookup: { inputSchema } } as any,
      directProviderRuntimeCapabilities("openai"),
    );

    expect((prepared.tools?.lookup as any).inputSchema.jsonSchema)
      .toMatchObject({ properties: { count: { minimum: 2 } } });
    expect(prepared.warnings).toEqual([]);
  });

  it("reports constraints kept local on an unproved compatible route", () => {
    const inputSchema = toValidatedToolInputSchema({
      type: "object",
      properties: { count: { type: "integer", minimum: 2 } },
      required: ["count"],
    });
    const prepared = prepareToolsForRuntimeCapabilities(
      { lookup: { inputSchema } } as any,
      undefined,
    );

    expect((prepared.tools?.lookup as any).inputSchema.jsonSchema.properties.count)
      .not.toHaveProperty("minimum");
    expect(prepared.warnings).toContainEqual({
      type: "tool-schema-constraint-local-only",
      toolName: "lookup",
      capability: "unknown",
    });
  });

  it("freezes an exact operational and terminal plan", () => {
    const capabilities = directProviderRuntimeCapabilities("openai");
    const operational = createEffectiveTurnPlan({
      tools: {
        first: { inputSchema: toValidatedToolInputSchema({ type: "object" }) },
        second: { inputSchema: toValidatedToolInputSchema({ type: "object" }) },
      } as any,
      activeTools: ["second"] as any,
      toolChoice: { type: "tool", toolName: "second" } as any,
      capabilities,
    });
    expect(operational.plan).toMatchObject({
      phase: "operational",
      activeTools: ["second"],
      toolChoice: { tool: "second" },
      tools: [{ name: "second" }],
    });
    expect(Object.isFrozen(operational.plan)).toBe(true);
    expect(Object.isFrozen(operational.plan.tools)).toBe(true);

    const terminal = createEffectiveTurnPlan({
      tools: {} as any,
      activeTools: [] as any,
      toolChoice: "none" as any,
      output: { type: "json" },
      capabilities,
    });
    expect(terminal.plan).toMatchObject({
      phase: "terminal-output",
      activeTools: [],
      toolChoice: "none",
      hasOutputContract: true,
    });
  });
});
