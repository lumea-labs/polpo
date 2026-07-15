import type {
  BillingOwner,
  CostSource,
  ModelInvocationUsage,
  NormalizedModelError,
  UsageExtractionInput,
} from "./model-runtime.js";

export interface LanguageModelUsageExtractionOptions {
  billingOwner?: BillingOwner;
  reportedCostUsd?: number;
  reportedCostSource?: CostSource;
  defaultCostSource?: CostSource;
}

export interface GatewayMetadataDetails {
  gatewayMetadata: Record<string, unknown>;
  generationId?: string;
  reportedCostUsd?: number;
  actualCostUsd?: number;
  inputInferenceCostUsd?: number;
  outputInferenceCostUsd?: number;
  resolvedModel?: string;
  finalProvider?: string;
  credentialType?: string;
}

export function extractLanguageModelUsage(
  input: UsageExtractionInput,
  options: LanguageModelUsageExtractionOptions = {},
): ModelInvocationUsage {
  const result = asRecord(input.result);
  const usage = asRecord(result?.totalUsage) ?? asRecord(result?.usage);
  const inputTokens = numberFrom(usage?.inputTokens);
  const outputTokens = numberFrom(usage?.outputTokens);
  const reasoningTokens = numberFrom(asRecord(usage?.outputTokenDetails)?.reasoningTokens);
  const cachedTokens = numberFrom(asRecord(usage?.inputTokenDetails)?.cacheReadTokens);
  const billingOwner = options.billingOwner ?? "external";
  const reportedCost = options.reportedCostUsd;
  const costSource = reportedCost === undefined
    ? options.defaultCostSource ?? "unknown"
    : options.reportedCostSource ?? "unknown";

  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(cachedTokens !== undefined ? { cachedTokens } : {}),
    ...(reportedCost !== undefined ? { estimatedCostUsd: reportedCost } : {}),
    ...(billingOwner === "platform" && reportedCost !== undefined ? { billableCostUsd: reportedCost } : {}),
    costSource,
    billingOwner,
  };
}

export function extractGatewayReportedCost(input: UsageExtractionInput): number | undefined {
  return extractGatewayMetadataDetails(input)?.reportedCostUsd;
}

export function extractGatewayMetadataDetails(input: UsageExtractionInput): GatewayMetadataDetails | undefined {
  const result = asRecord(input.result);
  const providerMetadata = asRecord(result?.providerMetadata);
  const gatewayMetadata = asRecord(providerMetadata?.gateway);
  if (!gatewayMetadata) return undefined;

  const routing = asRecord(gatewayMetadata.routing);
  const details: GatewayMetadataDetails = { gatewayMetadata };
  const generationId = stringFrom(gatewayMetadata.generationId);
  const reportedCostUsd = numberFrom(gatewayMetadata.marketCost, gatewayMetadata.cost, gatewayMetadata.actualCost);
  const actualCostUsd = numberFrom(gatewayMetadata.cost, gatewayMetadata.actualCost);
  const inputInferenceCostUsd = numberFrom(gatewayMetadata.inputInferenceCost);
  const outputInferenceCostUsd = numberFrom(gatewayMetadata.outputInferenceCost);
  const resolvedModel = stringFrom(routing?.canonicalSlug, routing?.originalModelId);
  const finalProvider = stringFrom(routing?.finalProvider);
  const credentialType = firstAttemptCredentialType(routing);

  if (generationId) details.generationId = generationId;
  if (reportedCostUsd !== undefined) details.reportedCostUsd = reportedCostUsd;
  if (actualCostUsd !== undefined) details.actualCostUsd = actualCostUsd;
  if (inputInferenceCostUsd !== undefined) details.inputInferenceCostUsd = inputInferenceCostUsd;
  if (outputInferenceCostUsd !== undefined) details.outputInferenceCostUsd = outputInferenceCostUsd;
  if (resolvedModel) details.resolvedModel = resolvedModel;
  if (finalProvider) details.finalProvider = finalProvider;
  if (credentialType) details.credentialType = credentialType;

  return details;
}

export function classifyRuntimeError(error: unknown): NormalizedModelError {
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

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function firstAttemptCredentialType(routing: Record<string, unknown> | undefined): string | undefined {
  const modelAttempts = Array.isArray(routing?.modelAttempts) ? routing.modelAttempts : [];
  const firstModelAttempt = asRecord(modelAttempts[0]);
  const providerAttempts = Array.isArray(firstModelAttempt?.providerAttempts)
    ? firstModelAttempt.providerAttempts
    : [];
  return stringFrom(asRecord(providerAttempts[0])?.credentialType);
}

function stringFrom(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

export function numberFrom(...values: unknown[]): number | undefined {
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
