import type {
  BillingOwner,
  CostSource,
  ModelInvocationUsage,
  NormalizedModelError,
  UsageExtractionInput,
} from "./model-runtime.js";
import {
  APICallError,
  InvalidToolInputError,
  MissingToolResultsError,
  NoSuchToolError,
  RetryError,
  TypeValidationError,
} from "ai";

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
  const facts = collectErrorFacts(error);
  const invalidProviderStreamEvent = providerStreamEventType(error);
  const message = facts.message;
  const lower = message.toLowerCase();
  const statusCode = facts.statusCode;
  const providerCode = facts.providerCode;
  const diagnostic = `${lower} ${(providerCode ?? "").toLowerCase()}`;
  const base = {
    message,
    ...(providerCode ? { providerCode } : {}),
    ...(statusCode !== undefined ? { statusCode } : {}),
    raw: error,
  };

  if (invalidProviderStreamEvent) {
    return {
      ...base,
      class: "unavailable",
      retryable: true,
      retryScope: "model-turn",
      providerCode: "provider_stream_event_invalid",
      message: `Provider stream event ${JSON.stringify(invalidProviderStreamEvent)} failed validation.`,
    };
  }

  if (diagnostic.includes("cancel") || diagnostic.includes("abort")) {
    return { ...base, class: "cancelled", retryable: false, retryScope: "none" };
  }
  if (statusCode === 429 || diagnostic.includes("rate limit") || diagnostic.includes("429")) {
    return { ...base, class: "rate-limit", retryable: true, retryScope: "model-turn" };
  }
  if (diagnostic.includes("timeout") || diagnostic.includes("timed out") || diagnostic.includes("etimedout")) {
    return { ...base, class: "timeout", retryable: true, retryScope: "model-turn" };
  }
  if (statusCode === 503 || diagnostic.includes("overload") || diagnostic.includes("temporarily unavailable") || diagnostic.includes("503")) {
    return { ...base, class: "overloaded", retryable: true, retryScope: "model-turn" };
  }
  if (statusCode === 401 || statusCode === 403 || diagnostic.includes("unauthorized") || diagnostic.includes("forbidden") || diagnostic.includes("api key") || diagnostic.includes("401") || diagnostic.includes("403")) {
    return { ...base, class: "auth", retryable: false, retryScope: "none" };
  }
  if (diagnostic.includes("context") && diagnostic.includes("length")) {
    return { ...base, class: "context-length", retryable: false, retryScope: "none" };
  }
  if (statusCode === 404 || (diagnostic.includes("model") && diagnostic.includes("not found"))) {
    return { ...base, class: "model-not-found", retryable: false, retryScope: "none" };
  }
  if (
    statusCode === 400
    || facts.invalidInput
    || diagnostic.includes("invalid")
    || diagnostic.includes("400")
    || diagnostic.includes("must be non-empty")
  ) {
    return { ...base, class: "invalid-request", retryable: false, retryScope: "none" };
  }
  if ((statusCode !== undefined && statusCode >= 500) || facts.retryable === true) {
    return { ...base, class: "unavailable", retryable: true, retryScope: "model-turn" };
  }
  if (/econnreset|enotfound|enetunreach|eai_again|fetch failed/.test(diagnostic)) {
    return { ...base, class: "unavailable", retryable: true, retryScope: "model-turn" };
  }

  return { ...base, class: "unknown", retryable: false, retryScope: "none" };
}

function providerStreamEventType(error: unknown): string | undefined {
  const queue: unknown[] = [error];
  const seen = new Set<object>();

  for (let index = 0; index < queue.length && index < 16; index += 1) {
    const candidate = queue[index];
    if (!candidate || typeof candidate !== "object" || seen.has(candidate)) continue;
    seen.add(candidate);

    if (isAiSdkError(TypeValidationError, candidate)) {
      const value = asRecord(candidate.value);
      const type = stringFrom(value?.type);
      if (type && /^(?:response\.|event\.)/u.test(type)) return type;
    }

    const record = candidate as Record<string, unknown>;
    queue.push(record.cause, record.error, record.reason);
  }

  return undefined;
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

interface ErrorFacts {
  message: string;
  statusCode?: number;
  providerCode?: string;
  retryable?: boolean;
  invalidInput: boolean;
}

function collectErrorFacts(error: unknown): ErrorFacts {
  const queue: unknown[] = [error];
  const seen = new Set<object>();
  let message: string | undefined;
  let messageScore = -1;
  let statusCode: number | undefined;
  let providerCode: string | undefined;
  let retryable: boolean | undefined;
  let invalidInput = false;

  for (let index = 0; index < queue.length && index < 32; index += 1) {
    const candidate = queue[index];
    if (typeof candidate === "string") {
      ({ message, score: messageScore } = preferErrorMessage(candidate, message, messageScore));
      continue;
    }
    if (!candidate || typeof candidate !== "object") continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);

    invalidInput ||= isAiSdkError(InvalidToolInputError, candidate)
      || isAiSdkError(MissingToolResultsError, candidate)
      || isAiSdkError(NoSuchToolError, candidate)
      || isAiSdkError(TypeValidationError, candidate);

    if (isAiSdkError(APICallError, candidate)) {
      statusCode ??= candidate.statusCode;
      retryable ??= candidate.isRetryable;
    }
    if (isAiSdkError(RetryError, candidate)) {
      queue.push(candidate.lastError, ...candidate.errors);
    }

    const record = candidate as Record<string, unknown>;
    ({ message, score: messageScore } = preferErrorMessage(record.message, message, messageScore));
    ({ message, score: messageScore } = preferErrorMessage(
      typeof record.error === "string" ? record.error : undefined,
      message,
      messageScore,
    ));
    statusCode ??= integerFrom(record.statusCode, record.status, asRecord(record.response)?.status);
    providerCode ??= stringFrom(record.code, asRecord(record.error)?.code);
    if (retryable === undefined) {
      retryable = booleanFrom(record.isRetryable, record.retryable);
    }

    const responseBody = parseJsonRecord(record.responseBody);
    if (responseBody) queue.push(responseBody);
    queue.push(record.cause, record.error, record.data, record.details, record.reason);
    if (Array.isArray(record.errors)) queue.push(...record.errors);
  }

  return {
    message: message ?? "Unknown model runtime error",
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(providerCode ? { providerCode } : {}),
    ...(retryable !== undefined ? { retryable } : {}),
    invalidInput,
  };
}

function isAiSdkError<T>(
  constructor: { isInstance?: (value: unknown) => value is T } | undefined,
  value: unknown,
): value is T {
  return constructor?.isInstance?.(value) === true;
}

function cleanErrorMessage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const message = value.trim();
  if (!message || message === "[object Object]") return undefined;
  return message;
}

function preferErrorMessage(
  candidate: unknown,
  current: string | undefined,
  currentScore: number,
): { message: string | undefined; score: number } {
  const message = cleanErrorMessage(candidate);
  if (!message) return { message: current, score: currentScore };
  const lower = message.toLowerCase();
  const score = lower.includes("[object object]")
    ? 0
    : lower === "internal server error"
      || lower === "model returned an error"
      || lower.startsWith("no output generated")
      ? 1
      : /missing|required|invalid|timeout|timed out|rate limit|unavailable|failed|denied|forbidden|not found/.test(lower)
        ? 4
        : 3;
  return score > currentScore
    ? { message, score }
    : { message: current, score: currentScore };
}

function integerFrom(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isInteger(value)) return value;
    if (typeof value === "string" && /^\d{3}$/.test(value.trim())) return Number(value);
  }
  return undefined;
}

function booleanFrom(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function parseJsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string" || !value.trim().startsWith("{")) return undefined;
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}
