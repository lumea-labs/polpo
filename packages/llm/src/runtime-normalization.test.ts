import { TypeValidationError } from "ai";
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

  it("extracts actionable diagnostics from plain and nested provider errors", () => {
    expect(classifyRuntimeError({
      code: "Client specified an invalid argument",
      error: "Invalid arguments passed to the model.",
      statusCode: 400,
      isRetryable: true,
    })).toMatchObject({
      class: "invalid-request",
      retryable: false,
      message: "Invalid arguments passed to the model.",
      providerCode: "Client specified an invalid argument",
      statusCode: 400,
    });

    expect(classifyRuntimeError({
      cause: {
        message: "Provider temporarily unavailable",
        statusCode: 503,
        isRetryable: true,
      },
    })).toMatchObject({
      class: "overloaded",
      retryable: true,
      message: "Provider temporarily unavailable",
      statusCode: 503,
    });
  });

  it("treats an unrecognized provider stream event as a recoverable protocol failure", () => {
    const error = new TypeValidationError({
      value: {
        type: "response.rate_limits.updated",
        sequence_number: 250,
      },
      cause: new Error("Invalid union"),
    });

    expect(classifyRuntimeError(error)).toMatchObject({
      class: "unavailable",
      retryable: true,
      retryScope: "model-turn",
      providerCode: "provider_stream_event_invalid",
      message: 'Provider stream event "response.rate_limits.updated" failed validation.',
    });
  });

  it("keeps ordinary structured-output validation failures non-retryable", () => {
    const error = new TypeValidationError({
      value: { summary: "missing response" },
      cause: new Error("Invalid structured output"),
    });

    expect(classifyRuntimeError(error)).toMatchObject({
      class: "invalid-request",
      retryable: false,
    });
  });

  it("always returns a non-empty safe message for unknown thrown values", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(classifyRuntimeError(circular)).toMatchObject({
      class: "unknown",
      retryable: false,
      message: "Unknown model runtime error",
    });
  });

  it("prefers nested provider diagnostics over generic wrapper messages", () => {
    expect(classifyRuntimeError({
      message: "No output generated. Check the stream for errors.",
      statusCode: 400,
      cause: {
        responseBody: JSON.stringify({
          error: { message: "Missing required parameter: input[10].arguments." },
        }),
      },
    })).toMatchObject({
      class: "invalid-request",
      retryable: false,
      message: "Missing required parameter: input[10].arguments.",
      statusCode: 400,
    });

    expect(classifyRuntimeError({ message: "provider failed", statusCode: 500 })).toMatchObject({
      class: "unavailable",
      retryable: true,
      retryScope: "model-turn",
    });
  });

  it("classifies nested network failures using provider codes", () => {
    expect(classifyRuntimeError({
      message: "fetch failed",
      cause: new AggregateError([
        Object.assign(new Error("connect failed"), { code: "ENETUNREACH" }),
      ]),
    })).toMatchObject({
      class: "unavailable",
      retryable: true,
      providerCode: "ENETUNREACH",
    });
  });
});
