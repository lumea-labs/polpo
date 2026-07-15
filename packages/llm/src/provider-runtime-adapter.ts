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
  const result = asRecord(input.result);
  const usage = asRecord(result?.totalUsage) ?? asRecord(result?.usage);
  const inputTokens = numberFrom(usage?.inputTokens);
  const outputTokens = numberFrom(usage?.outputTokens);
  const reasoningTokens = numberFrom(asRecord(usage?.outputTokenDetails)?.reasoningTokens);
  const cachedTokens = numberFrom(asRecord(usage?.inputTokenDetails)?.cacheReadTokens);

  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(cachedTokens !== undefined ? { cachedTokens } : {}),
    costSource: "unknown",
    billingOwner,
  };
}

export function classifyProviderRuntimeError(error: unknown): NormalizedModelError {
  const message = getErrorMessage(error);
  const lower = message.toLowerCase();

  if (lower.includes("cancel") || lower.includes("abort")) {
    return { class: "cancelled", retryable: false, message };
  }
  if (lower.includes("rate limit") || lower.includes("429")) {
    return { class: "rate-limit", retryable: true, message };
  }
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("etimedout")) {
    return { class: "timeout", retryable: true, message };
  }
  if (lower.includes("overload") || lower.includes("temporarily unavailable") || lower.includes("503")) {
    return { class: "overloaded", retryable: true, message };
  }
  if (lower.includes("unauthorized") || lower.includes("forbidden") || lower.includes("api key") || lower.includes("401") || lower.includes("403")) {
    return { class: "auth", retryable: false, message };
  }
  if (lower.includes("context") && lower.includes("length")) {
    return { class: "context-length", retryable: false, message };
  }
  if (lower.includes("invalid") || lower.includes("400") || lower.includes("must be non-empty")) {
    return { class: "invalid-request", retryable: false, message };
  }

  return { class: "unknown", retryable: false, message, raw: error };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function numberFrom(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number.parseFloat(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    const record = asRecord(value);
    if (record) {
      const nested = numberFrom(record.total);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  const record = asRecord(error);
  if (typeof record?.message === "string") return record.message;
  return "";
}
