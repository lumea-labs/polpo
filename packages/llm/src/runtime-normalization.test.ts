import { describe, expect, it } from "vitest";
import {
  classifyRuntimeError,
  extractGatewayReportedCost,
  extractLanguageModelUsage,
} from "./runtime-normalization.js";

describe("runtime normalization", () => {
  it("extracts token usage without making cost billable by default", () => {
    expect(extractLanguageModelUsage({
      mode: "provider",
      operation: "chat",
      requested: { provider: "openai", model: "gpt-4o" },
      context: {},
      result: {
        usage: {
          inputTokens: 3,
          outputTokens: 4,
          inputTokenDetails: { cacheReadTokens: 2 },
          outputTokenDetails: { reasoningTokens: 1 },
        },
      },
    })).toEqual({
      inputTokens: 3,
      outputTokens: 4,
      cachedTokens: 2,
      reasoningTokens: 1,
      costSource: "unknown",
      billingOwner: "external",
    });
  });

  it("keeps billable cost as an explicit billing-owner decoration", () => {
    expect(extractLanguageModelUsage({
      mode: "gateway",
      operation: "chat",
      requested: { provider: "openai", model: "gpt-4o" },
      context: {},
      result: {},
    }, {
      billingOwner: "platform",
      reportedCostUsd: 0.12,
      reportedCostSource: "gateway-metadata",
    })).toMatchObject({
      estimatedCostUsd: 0.12,
      billableCostUsd: 0.12,
      costSource: "gateway-metadata",
      billingOwner: "platform",
    });
  });

  it("extracts gateway-reported costs from known metadata shapes", () => {
    expect(extractGatewayReportedCost({
      mode: "gateway",
      operation: "chat",
      requested: { model: "openai/gpt-4o" },
      context: {},
      result: {
        providerMetadata: {
          gateway: {
            marketCost: { total: "0.0042" },
          },
        },
      },
    })).toBe(0.0042);
  });

  it("classifies common runtime errors once for provider and gateway adapters", () => {
    expect(classifyRuntimeError(new Error("upstream rate limit 429"))).toMatchObject({
      class: "rate-limit",
      retryable: true,
    });
    expect(classifyRuntimeError(new Error("messages: text content blocks must be non-empty"))).toMatchObject({
      class: "invalid-request",
      retryable: false,
    });
  });
});
