import { createOpenAI } from "@ai-sdk/openai";
import type {
  BillingOwner,
  CreateModelInput,
  ModelInvocationUsage,
  ModelRef,
  ModelRuntimeAdapter,
  NormalizedModelError,
  UsageExtractionInput,
} from "./model-runtime.js";
import { resolveApiKey } from "./api-keys.js";
import { mapReasoningToProviderOptions } from "./provider-factory.js";
import {
  classifyRuntimeError,
  extractLanguageModelUsage,
} from "./runtime-normalization.js";

export interface ProviderRuntimeAdapterOptions {
  apiKeyResolver?: (provider: string) => string | undefined;
  billingOwner?: BillingOwner;
}

export function createProviderRuntimeAdapter(options: ProviderRuntimeAdapterOptions = {}): ModelRuntimeAdapter {
  const billingOwner = options.billingOwner ?? "external";

  return {
    mode: "provider",
    createLanguageModel(input: CreateModelInput) {
      const { provider, modelId } = splitProviderModelRef(input.ref);
      const apiKey = options.apiKeyResolver?.(provider) ?? resolveApiKey(provider);

      if (!apiKey) {
        throw new Error(`Missing API key for provider "${provider}"`);
      }

      if (provider === "openai") {
        const openai = createOpenAI({ apiKey });
        return openai(modelId);
      }

      throw new Error(`Direct provider execution is not implemented for provider "${provider}"`);
    },
    buildProviderOptions(input) {
      const { provider } = splitProviderModelRef(input.ref);
      return mapReasoningToProviderOptions(provider, input.reasoning as any, input.maxOutputTokens ?? 8192);
    },
    extractUsage(input: UsageExtractionInput): ModelInvocationUsage {
      return extractProviderInvocationUsage(input, billingOwner);
    },
    classifyError(error: unknown): NormalizedModelError {
      return classifyProviderRuntimeError(error);
    },
  };
}

export function splitProviderModelRef(ref: ModelRef): { provider: string; modelId: string } {
  if (ref.provider) {
    return { provider: ref.provider, modelId: ref.model };
  }

  const slash = ref.model.indexOf("/");
  if (slash > 0 && slash < ref.model.length - 1) {
    return {
      provider: ref.model.slice(0, slash),
      modelId: ref.model.slice(slash + 1),
    };
  }

  throw new Error(`Provider model references must include a provider prefix: ${ref.model}`);
}

export function extractProviderInvocationUsage(
  input: UsageExtractionInput,
  billingOwner: BillingOwner = "external",
): ModelInvocationUsage {
  return extractLanguageModelUsage(input, {
    billingOwner,
  });
}

export function classifyProviderRuntimeError(error: unknown): NormalizedModelError {
  return classifyRuntimeError(error);
}
