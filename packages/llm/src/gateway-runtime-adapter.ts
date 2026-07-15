import { createGatewayModel } from "./provider-factory.js";
import { mapReasoningToProviderOptions } from "./provider-factory.js";
import type { GatewayConfig } from "./gateway-config.js";
import type {
  BillingOwner,
  CreateModelInput,
  ModelInvocationUsage,
  ModelRef,
  ModelRuntimeAdapter,
  NormalizedModelError,
  UsageExtractionInput,
} from "./model-runtime.js";
import {
  classifyRuntimeError,
  extractGatewayReportedCost,
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
  return extractLanguageModelUsage(input, {
    billingOwner,
    reportedCostUsd: extractGatewayReportedCost(input),
    reportedCostSource: "gateway-metadata",
  });
}

export function classifyGatewayError(error: unknown): NormalizedModelError {
  return classifyRuntimeError(error);
}
