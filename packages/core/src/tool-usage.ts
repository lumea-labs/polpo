import type { ToolUsageRecord } from "./types/agent.js";

/**
 * Extract the model invocation fact emitted by a tool.
 *
 * Backwards compatibility:
 * - `details.usage` is the existing gateway media shape used by image/video.
 *
 * Normalized shape:
 * - `details.modelUsage` is the billing-neutral runtime fact used by direct
 *   provider/local tools such as speech-to-text and text-to-speech.
 */
export function extractToolUsageRecord(
  toolName: string,
  details: unknown,
): ToolUsageRecord | undefined {
  const detailsRecord = asRecord(details);
  if (!detailsRecord) return undefined;

  const modelUsage = asRecord(detailsRecord.modelUsage);
  if (modelUsage) {
    const requestedModel = stringFrom(modelUsage.requestedModel);
    const resolvedModel = stringFrom(modelUsage.resolvedModel, requestedModel);
    const operation = stringFrom(modelUsage.operation);
    if (!requestedModel && !resolvedModel && !operation) return undefined;

    return compactRecord({
      toolName,
      mode: stringFrom(modelUsage.mode),
      operation,
      requestedProvider: stringFrom(modelUsage.requestedProvider),
      requestedModel,
      resolvedProvider: stringFrom(modelUsage.resolvedProvider),
      resolvedModel,
      finalProvider: stringFrom(modelUsage.finalProvider, modelUsage.resolvedProvider, modelUsage.requestedProvider),
      generationId: stringFrom(modelUsage.generationId),
      credentialType: stringFrom(modelUsage.credentialType),
      status: stringFrom(modelUsage.status, "succeeded"),
      inputTokens: numberFrom(modelUsage.inputTokens),
      outputTokens: numberFrom(modelUsage.outputTokens),
      reasoningTokens: numberFrom(modelUsage.reasoningTokens),
      cachedTokens: numberFrom(modelUsage.cachedTokens),
      audioInputSeconds: numberFrom(modelUsage.audioInputSeconds),
      audioOutputSeconds: numberFrom(modelUsage.audioOutputSeconds),
      imageCount: numberFrom(modelUsage.imageCount),
      videoSeconds: numberFrom(modelUsage.videoSeconds),
      estimatedCostUsd: numberFrom(modelUsage.estimatedCostUsd),
      billableCostUsd: numberFrom(modelUsage.billableCostUsd),
      marketCostUsd: numberFrom(modelUsage.marketCostUsd),
      actualCostUsd: numberFrom(modelUsage.actualCostUsd),
      costSource: stringFrom(modelUsage.costSource, "unknown"),
      billingOwner: stringFrom(modelUsage.billingOwner, "external"),
      rawMetadata: asRecord(modelUsage.rawMetadata),
    }) as unknown as ToolUsageRecord;
  }

  const gatewayUsage = asRecord(detailsRecord.usage);
  if (!gatewayUsage) return undefined;
  const generationId = stringFrom(gatewayUsage.generationId);
  const marketCostUsd = numberFrom(gatewayUsage.marketCostUsd);
  if (!generationId && marketCostUsd === undefined) return undefined;

  return compactRecord({
    toolName,
    mode: "gateway",
    generationId,
    marketCostUsd,
    actualCostUsd: numberFrom(gatewayUsage.actualCostUsd),
    resolvedModel: stringFrom(gatewayUsage.resolvedModel),
    finalProvider: stringFrom(gatewayUsage.finalProvider),
    credentialType: normalizeGatewayCredentialType(gatewayUsage.credentialType),
    billingOwner: "platform",
    costSource: marketCostUsd === undefined ? "unknown" : "gateway-metadata",
    status: "succeeded",
    rawMetadata: { usage: gatewayUsage },
  }) as unknown as ToolUsageRecord;
}

function normalizeGatewayCredentialType(value: unknown): string | undefined {
  const raw = stringFrom(value)?.toLowerCase();
  if (!raw) return undefined;
  if (raw === "system") return "platform";
  if (raw === "byok" || raw === "user") return "project";
  if (raw === "custom") return "external";
  return raw;
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringFrom(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function numberFrom(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}
