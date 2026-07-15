import { describe, expect, it } from "vitest";
import {
  extractGatewayMetadataDetails,
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

  it("extracts gateway metadata details for host and tool ledgers", () => {
    expect(extractGatewayMetadataDetails({
      mode: "gateway",
      operation: "image.generate",
      requested: { provider: "bfl", model: "flux-pro-1.1" },
      context: {},
      result: {
        providerMetadata: {
          gateway: {
            generationId: "gen_img_1",
            marketCost: { total: "0.03" },
            cost: "0.01",
            inputInferenceCost: "0.004",
            outputInferenceCost: "0.006",
            routing: {
              canonicalSlug: "bfl/flux-pro-1.1",
              finalProvider: "bfl",
              modelAttempts: [
                {
                  providerAttempts: [{ credentialType: "system" }],
                },
              ],
            },
          },
        },
      },
    })).toMatchObject({
      generationId: "gen_img_1",
      reportedCostUsd: 0.03,
      actualCostUsd: 0.01,
      inputInferenceCostUsd: 0.004,
      outputInferenceCostUsd: 0.006,
      resolvedModel: "bfl/flux-pro-1.1",
      finalProvider: "bfl",
      credentialType: "system",
    });
  });

  it("does not return gateway metadata details for non-gateway results", () => {
    expect(extractGatewayMetadataDetails({
      mode: "provider",
      operation: "chat",
      requested: { provider: "openai", model: "gpt-4o" },
      context: {},
      result: {
        providerMetadata: { openai: { responseId: "resp_123" } },
      },
    })).toBeUndefined();
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
