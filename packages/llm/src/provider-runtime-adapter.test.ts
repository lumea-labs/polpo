import { describe, expect, it } from "vitest";
import {
  classifyProviderRuntimeError,
  createProviderRuntimeAdapter,
  extractProviderInvocationDetails,
  extractProviderInvocationUsage,
  splitProviderModelRef,
} from "./provider-runtime-adapter.js";

describe("provider runtime adapter", () => {
  it("is exposed as the direct provider runtime mode", () => {
    const adapter = createProviderRuntimeAdapter({
      apiKeyResolver: () => "test-key",
    });
    expect(adapter.mode).toBe("provider");
  });

  it("splits provider/model refs for direct provider model ids", () => {
    expect(splitProviderModelRef({ model: "openai/gpt-4o" })).toEqual({
      provider: "openai",
      modelId: "gpt-4o",
    });
    expect(splitProviderModelRef({ provider: "openai", model: "gpt-4o" })).toEqual({
      provider: "openai",
      modelId: "gpt-4o",
    });
  });

  it("requires a provider prefix when one is not supplied separately", () => {
    expect(() => splitProviderModelRef({ model: "gpt-4o" })).toThrow(/provider prefix/);
  });

  it("creates OpenAI language models through the provider adapter", () => {
    const adapter = createProviderRuntimeAdapter({
      apiKeyResolver: () => "test-key",
    });

    const model = adapter.createLanguageModel({
      ref: { provider: "openai", model: "gpt-4o" },
      context: {},
    });

    expect(model).toBeTruthy();
  });

  it("creates Anthropic language models through the provider adapter", () => {
    const adapter = createProviderRuntimeAdapter({
      apiKeyResolver: () => "test-key",
    });

    const model = adapter.createLanguageModel({
      ref: { provider: "anthropic", model: "claude-sonnet-4-5" },
      context: {},
    });

    expect(model).toBeTruthy();
  });

  it("fails explicitly for unsupported direct providers", () => {
    const adapter = createProviderRuntimeAdapter({
      apiKeyResolver: () => "test-key",
    });

    expect(() => adapter.createLanguageModel({
      ref: { provider: "google", model: "gemini-2.5-pro" },
      context: {},
    })).toThrow(/not implemented/);
  });

  it("builds provider options through the provider adapter boundary", () => {
    const adapter = createProviderRuntimeAdapter({
      apiKeyResolver: () => "test-key",
    });

    const options = adapter.buildProviderOptions?.({
      ref: { provider: "openai", model: "gpt-4o" },
      context: {},
      reasoning: "high",
      maxOutputTokens: 1000,
    });

    expect(options).toEqual({
      openai: {
        reasoningEffort: "high",
      },
    });
  });

  it("extracts provider usage without claiming platform spend", () => {
    const usage = extractProviderInvocationUsage({
      mode: "provider",
      operation: "chat",
      requested: { provider: "openai", model: "gpt-4o" },
      context: {},
      result: {
        totalUsage: {
          inputTokens: 5,
          outputTokens: 8,
          inputTokenDetails: { cacheReadTokens: 1 },
        },
      },
    });

    expect(usage).toEqual({
      inputTokens: 5,
      outputTokens: 8,
      cachedTokens: 1,
      costSource: "unknown",
      billingOwner: "external",
    });
  });

  it("extracts provider invocation details without gateway assumptions", () => {
    const details = extractProviderInvocationDetails({
      mode: "provider",
      operation: "chat",
      requested: { provider: "openai", model: "gpt-4o" },
      context: {},
      result: {
        response: { id: "resp_123" },
        providerMetadata: { openai: { systemFingerprint: "fp_1" } },
      },
    });

    expect(details).toEqual({
      generationId: "resp_123",
      rawMetadata: {
        providerMetadata: { openai: { systemFingerprint: "fp_1" } },
      },
    });

    const adapter = createProviderRuntimeAdapter({
      apiKeyResolver: () => "test-key",
    });
    expect(adapter.extractInvocationDetails?.({
      mode: "provider",
      operation: "chat",
      requested: { provider: "openai", model: "gpt-4o" },
      context: {},
      result: { response: { id: "resp_123" } },
    })).toEqual({ generationId: "resp_123" });
  });

  it("classifies common provider failures", () => {
    expect(classifyProviderRuntimeError(new Error("request timeout"))).toMatchObject({
      class: "timeout",
      retryable: true,
    });
    expect(classifyProviderRuntimeError(new Error("invalid message 400"))).toMatchObject({
      class: "invalid-request",
      retryable: false,
    });
  });
});
