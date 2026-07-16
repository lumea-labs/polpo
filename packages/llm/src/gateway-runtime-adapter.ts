import { createGatewayModel } from "./provider-factory.js";
import { mapReasoningToProviderOptions } from "./provider-factory.js";
import type { GatewayConfig } from "./gateway-config.js";
import type {
  BillingOwner,
  CredentialType,
  CreateModelInput,
  ModelInvocationDetails,
  ModelInvocationUsage,
  ModelRef,
  ModelRuntimeAdapter,
  NormalizedModelError,
  UsageExtractionInput,
} from "./model-runtime.js";
import {
  asRecord,
  classifyRuntimeError,
  extractGatewayMetadataDetails,
  extractLanguageModelUsage,
} from "./runtime-normalization.js";

export interface GatewayRuntimeAdapterOptions {
  config?: GatewayConfig;
  billingOwner?: BillingOwner;
}

export interface GatewayModelNotFoundDetails {
  modelId?: string;
  message?: string;
}

export function createGatewayRuntimeAdapter(options: GatewayRuntimeAdapterOptions = {}): ModelRuntimeAdapter {
  const billingOwner = options.billingOwner ?? "external";

  return {
    mode: "gateway",
    createLanguageModel(input: CreateModelInput) {
      const { provider, modelId } = splitGatewayModelRef(input.ref);
      return createGatewayModel(provider, modelId, options.config);
    },
    buildProviderOptions(input) {
      const { provider, modelId } = splitGatewayModelRef(input.ref);
      return mapReasoningToProviderOptions(provider, input.reasoning as any, input.maxOutputTokens ?? 8192, modelId);
    },
    extractUsage(input: UsageExtractionInput): ModelInvocationUsage {
      return extractGatewayInvocationUsage(input, billingOwner);
    },
    extractInvocationDetails(input: UsageExtractionInput): ModelInvocationDetails | undefined {
      return extractGatewayInvocationDetails(input);
    },
    classifyError(error: unknown): NormalizedModelError {
      return classifyGatewayError(error);
    },
  };
}

export function splitGatewayModelRef(ref: ModelRef): { provider: string; modelId: string } {
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

  throw new Error(`Gateway model references must include a provider prefix: ${ref.model}`);
}

export function extractGatewayInvocationUsage(
  input: UsageExtractionInput,
  billingOwner: BillingOwner = "external",
): ModelInvocationUsage {
  const details = extractGatewayInvocationDetails(input);
  return extractLanguageModelUsage(input, {
    billingOwner,
    reportedCostUsd: details?.reportedCostUsd,
    reportedCostSource: "gateway-metadata",
  });
}

export function extractGatewayInvocationDetails(input: UsageExtractionInput): ModelInvocationDetails | undefined {
  const details = extractGatewayMetadataDetails(input);
  if (!details) return undefined;

  return compactDetails({
    generationId: details.generationId,
    credentialType: normalizeGatewayCredentialType(details.credentialType),
    resolvedModel: details.resolvedModel,
    finalProvider: details.finalProvider,
    reportedCostUsd: details.reportedCostUsd,
    actualCostUsd: details.actualCostUsd,
    inputInferenceCostUsd: details.inputInferenceCostUsd,
    outputInferenceCostUsd: details.outputInferenceCostUsd,
    rawMetadata: { gateway: details.gatewayMetadata },
  });
}

export function classifyGatewayError(error: unknown): NormalizedModelError {
  const notFound = extractGatewayModelNotFoundDetails(error);
  if (notFound) {
    return {
      class: "model-not-found",
      retryable: false,
      providerCode: "model_not_found",
      message: notFound.message,
    };
  }
  return classifyRuntimeError(error);
}

export function extractGatewayModelNotFoundDetails(error: unknown): GatewayModelNotFoundDetails | undefined {
  for (const candidate of gatewayErrorObjects(error)) {
    const fromBody = parseGatewayErrorBody(candidate.responseBody);
    const code = stringFrom(
      candidate.type,
      candidate.code,
      asRecord(candidate.error)?.type,
      asRecord(candidate.error)?.code,
      fromBody?.type,
      fromBody?.code,
    );
    const statusCode = numberFrom(candidate.statusCode, candidate.status);
    const isTypedGatewayError =
      candidate.name === "GatewayModelNotFoundError" ||
      candidate.constructor?.name === "GatewayModelNotFoundError";
    const isModelNotFound =
      isTypedGatewayError ||
      code === "model_not_found" ||
      (statusCode === 404 && (fromBody?.code === "model_not_found" || fromBody?.type === "model_not_found"));

    if (!isModelNotFound) continue;

    return {
      modelId: stringFrom(
        candidate.modelId,
        asRecord(candidate.param)?.modelId,
        asRecord(candidate.error)?.modelId,
        asRecord(asRecord(candidate.error)?.param)?.modelId,
        fromBody?.modelId,
      ),
      message: stringFrom(candidate.message, fromBody?.message),
    };
  }

  return undefined;
}

function normalizeGatewayCredentialType(value: unknown): CredentialType | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const normalized = value.toLowerCase();
  if (normalized === "system") return "platform";
  if (normalized === "byok" || normalized === "user") return "project";
  if (normalized === "custom") return "external";
  if (normalized === "platform" || normalized === "project" || normalized === "external" || normalized === "none") {
    return normalized;
  }
  return undefined;
}

function compactDetails(details: ModelInvocationDetails): ModelInvocationDetails {
  return Object.fromEntries(
    Object.entries(details).filter(([, value]) => value !== undefined),
  ) as ModelInvocationDetails;
}

function gatewayErrorObjects(err: unknown): Record<string, any>[] {
  const queue: unknown[] = [err];
  const seen = new Set<unknown>();
  const objects: Record<string, any>[] = [];

  while (queue.length > 0 && objects.length < 16) {
    const current = queue.shift();
    if (!current || (typeof current !== "object" && typeof current !== "function") || seen.has(current)) continue;
    seen.add(current);
    const record = current as Record<string, any>;
    objects.push(record);
    for (const key of ["error", "cause", "data", "param", "sourceError"]) {
      if (record[key] !== undefined) queue.push(record[key]);
    }
  }

  return objects;
}

function parseGatewayErrorBody(value: unknown): GatewayModelNotFoundDetails & { type?: string; code?: string } | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value);
    const error = asRecord(asRecord(parsed)?.error) ?? asRecord(parsed);
    const param = asRecord(error?.param);
    return {
      code: stringFrom(error?.code, error?.type, param?.code, param?.type),
      type: stringFrom(error?.type, error?.code, param?.type, param?.code),
      modelId: stringFrom(error?.modelId, param?.modelId),
      message: stringFrom(error?.message, asRecord(parsed)?.message),
    };
  } catch {
    return value.includes("model_not_found") ? { code: "model_not_found", type: "model_not_found" } : undefined;
  }
}

function stringFrom(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function numberFrom(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number.parseFloat(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}
