export const MODEL_RUNTIME_MODES = ["provider", "gateway"] as const;

export type ModelRuntimeMode = (typeof MODEL_RUNTIME_MODES)[number];

export type ModelOperation =
  | "chat"
  | "embed"
  | "image.generate"
  | "image.analyze"
  | "video.generate"
  | "audio.transcribe"
  | "audio.speak"
  | "realtime";

export type CostSource =
  | "gateway-metadata"
  | "provider-metadata"
  | "catalog-estimate"
  | "configured-rate"
  | "none"
  | "unknown";

export type BillingOwner = "platform" | "external" | "none";

export type CredentialType = "platform" | "project" | "external" | "none";

export type ModelInvocationStatus = "succeeded" | "failed" | "cancelled";

export interface ModelRef {
  provider?: string;
  model: string;
}

export interface ModelInvocationContext {
  projectId?: string;
  orgId?: string;
  runId?: string;
  sessionId?: string;
  turnId?: string;
  agentName?: string;
  externalUser?: string;
  metadata?: Record<string, unknown>;
}

export interface UsageExtractionInput {
  mode: ModelRuntimeMode;
  operation: ModelOperation;
  requested: ModelRef;
  resolved?: ModelRef;
  result?: unknown;
  error?: unknown;
  context: ModelInvocationContext;
  startedAt?: Date;
  finishedAt?: Date;
}

export interface NormalizedModelError {
  class:
    | "auth"
    | "rate-limit"
    | "overloaded"
    | "timeout"
    | "unavailable"
    | "model-not-found"
    | "invalid-request"
    | "context-length"
    | "cancelled"
    | "unknown";
  retryable: boolean;
  message?: string;
  providerCode?: string;
  statusCode?: number;
  phase?: "request" | "stream" | "tool-input" | "finalize" | "tool-execution";
  retryScope?: "none" | "model-turn" | "tool-call";
  raw?: unknown;
}

export interface ModelInvocationUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedTokens?: number;
  audioInputSeconds?: number;
  audioOutputSeconds?: number;
  imageCount?: number;
  videoSeconds?: number;
  estimatedCostUsd?: number;
  billableCostUsd?: number;
  costSource: CostSource;
  billingOwner: BillingOwner;
}

export interface ModelInvocationDetails {
  resolvedProvider?: string;
  resolvedModel?: string;
  finalProvider?: string;
  generationId?: string;
  credentialType?: CredentialType;
  reportedCostUsd?: number;
  actualCostUsd?: number;
  inputInferenceCostUsd?: number;
  outputInferenceCostUsd?: number;
  rawMetadata?: unknown;
}

export interface ModelInvocationRecord extends ModelInvocationUsage {
  id?: string;
  projectId?: string;
  orgId?: string;
  runId?: string;
  sessionId?: string;
  turnId?: string;
  agentName?: string;
  externalUser?: string;
  mode: ModelRuntimeMode;
  operation: ModelOperation;
  requestedProvider?: string;
  requestedModel: string;
  resolvedProvider?: string;
  resolvedModel?: string;
  finalProvider?: string;
  attemptIndex?: number;
  attemptCount?: number;
  generationId?: string;
  credentialType?: CredentialType;
  status: ModelInvocationStatus;
  errorClass?: NormalizedModelError["class"];
  errorMessage?: string;
  rawMetadata?: unknown;
  createdAt?: Date;
}

export function isModelRuntimeMode(value: unknown): value is ModelRuntimeMode {
  return typeof value === "string" && (MODEL_RUNTIME_MODES as readonly string[]).includes(value);
}
