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
  classifyRuntimeError,
  extractGatewayMetadataDetails,
  extractLanguageModelUsage,
} from "./runtime-normalization.js";

export interface GatewayRuntimeAdapterOptions {
  config?: GatewayConfig;
  billingOwner?: BillingOwner;
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
      const { provider } = splitGatewayModelRef(input.ref);
      return mapReasoningToProviderOptions(provider, input.reasoning as any, input.maxOutputTokens ?? 8192);
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
  return classifyRuntimeError(error);
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
