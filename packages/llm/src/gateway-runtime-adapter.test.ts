import { describe, expect, it } from "vitest";
import {
  classifyGatewayError,
  createGatewayRuntimeAdapter,
  extractGatewayInvocationUsage,
  splitGatewayModelRef,
} from "./gateway-runtime-adapter.js";

describe("gateway runtime adapter", () => {
  it("is exposed as the generic gateway runtime mode", () => {
    const adapter = createGatewayRuntimeAdapter();
    expect(adapter.mode).toBe("gateway");
  });

  it("splits provider/model refs for gateway model ids", () => {
    expect(splitGatewayModelRef({ model: "openai/gpt-4o" })).toEqual({
      provider: "openai",
      modelId: "gpt-4o",
    });
    expect(splitGatewayModelRef({ provider: "anthropic", model: "claude-sonnet-5" })).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-5",
    });
  });

  it("requires a provider prefix when one is not supplied separately", () => {
    expect(() => splitGatewayModelRef({ model: "gpt-4o" })).toThrow(/provider prefix/);
  });

  it("extracts gateway usage as external by default", () => {
    const usage = extractGatewayInvocationUsage({
      mode: "gateway",
      operation: "chat",
      requested: { model: "openai/gpt-4o" },
      context: {},
      result: {
        totalUsage: {
          inputTokens: 12,
          outputTokens: 7,
          inputTokenDetails: { cacheReadTokens: 3 },
          outputTokenDetails: { reasoningTokens: 2 },
        },
        providerMetadata: {
          gateway: { marketCost: "0.0012" },
        },
      },
    });

    expect(usage).toEqual({
      inputTokens: 12,
      outputTokens: 7,
      reasoningTokens: 2,
      cachedTokens: 3,
      estimatedCostUsd: 0.0012,
      costSource: "gateway-metadata",
      billingOwner: "external",
    });
  });

  it("only marks billable cost when the host decorates billing ownership as platform", () => {
    const usage = extractGatewayInvocationUsage({
      mode: "gateway",
      operation: "chat",
      requested: { model: "openai/gpt-4o" },
      context: {},
      result: {
        providerMetadata: {
          gateway: { marketCost: 0.01 },
        },
      },
    }, "platform");

    expect(usage.estimatedCostUsd).toBe(0.01);
    expect(usage.billableCostUsd).toBe(0.01);
    expect(usage.billingOwner).toBe("platform");
  });

  it("classifies common retryable gateway failures without changing runtime mode", () => {
    expect(classifyGatewayError(new Error("upstream rate limit 429"))).toMatchObject({
      class: "rate-limit",
      retryable: true,
    });
    expect(classifyGatewayError(new Error("messages: text content blocks must be non-empty"))).toMatchObject({
      class: "invalid-request",
      retryable: false,
    });
  });
});
