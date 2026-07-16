import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAI } from "@ai-sdk/openai";
import { createXai } from "@ai-sdk/xai";
import type { LanguageModel } from "ai";
import type {
  BillingOwner,
  CreateModelInput,
  ModelInvocationDetails,
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

export const SUPPORTED_DIRECT_LANGUAGE_PROVIDERS = [
  "openai",
  "anthropic",
  "google",
  "xai",
  "groq",
  "mistral",
] as const;

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
        return openai(modelId) as unknown as LanguageModel;
      }

      if (provider === "anthropic") {
        const anthropic = createAnthropic({ apiKey });
        return anthropic(modelId) as unknown as LanguageModel;
      }

      if (provider === "google") {
        const google = createGoogleGenerativeAI({ apiKey });
        return google(modelId) as unknown as LanguageModel;
      }

      if (provider === "xai") {
        const xai = createXai({ apiKey });
        return xai(modelId) as unknown as LanguageModel;
      }

      if (provider === "groq") {
        const groq = createGroq({ apiKey });
        return groq(modelId) as unknown as LanguageModel;
      }

      if (provider === "mistral") {
        const mistral = createMistral({ apiKey });
        return mistral(modelId) as unknown as LanguageModel;
      }

      throw new Error(`Direct provider execution is not implemented for provider "${provider}"`);
    },
    buildProviderOptions(input) {
      const { provider, modelId } = splitProviderModelRef(input.ref);
      return mapReasoningToProviderOptions(provider, input.reasoning as any, input.maxOutputTokens ?? 8192, modelId);
    },
    extractUsage(input: UsageExtractionInput): ModelInvocationUsage {
      return extractProviderInvocationUsage(input, billingOwner);
    },
    extractInvocationDetails(input: UsageExtractionInput): ModelInvocationDetails | undefined {
      return extractProviderInvocationDetails(input);
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

export function extractProviderInvocationDetails(input: UsageExtractionInput): ModelInvocationDetails | undefined {
  const result = asRecord(input.result);
  const providerMetadata = asRecord(result?.providerMetadata);
  const response = asRecord(result?.response);
  if (!providerMetadata && !response) return undefined;

  return {
    ...(providerMetadata ? { rawMetadata: { providerMetadata } } : {}),
    ...(typeof response?.id === "string" && response.id.trim() ? { generationId: response.id } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
