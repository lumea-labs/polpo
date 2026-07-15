import type { LanguageModel } from "ai";

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

export interface InvocationContext {
  projectId?: string;
  orgId?: string;
  runId?: string;
  sessionId?: string;
  turnId?: string;
  agentName?: string;
  externalUser?: string;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
}

export interface CreateModelInput {
  ref: ModelRef;
  context: InvocationContext;
}

export interface ProviderOptionInput extends CreateModelInput {
  reasoning?: string;
  maxOutputTokens?: number;
}

export interface UsageExtractionInput {
  mode: ModelRuntimeMode;
  operation: ModelOperation;
  requested: ModelRef;
  resolved?: ModelRef;
  result?: unknown;
  error?: unknown;
  context: InvocationContext;
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
    | "invalid-request"
    | "context-length"
    | "cancelled"
    | "unknown";
  retryable: boolean;
  message?: string;
  providerCode?: string;
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

export interface ModelRuntimeAdapter {
  mode: ModelRuntimeMode;
  createLanguageModel(input: CreateModelInput): Promise<LanguageModel> | LanguageModel;
  createEmbeddingModel?(input: CreateModelInput): Promise<unknown> | unknown;
  createImageModel?(input: CreateModelInput): Promise<unknown> | unknown;
  createVideoModel?(input: CreateModelInput): Promise<unknown> | unknown;
  createTranscriptionModel?(input: CreateModelInput): Promise<unknown> | unknown;
  createSpeechModel?(input: CreateModelInput): Promise<unknown> | unknown;
  buildProviderOptions?(input: ProviderOptionInput): Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined;
  extractUsage(input: UsageExtractionInput): Promise<ModelInvocationUsage> | ModelInvocationUsage;
  classifyError(error: unknown): NormalizedModelError;
}

export function isModelRuntimeMode(value: unknown): value is ModelRuntimeMode {
  return typeof value === "string" && (MODEL_RUNTIME_MODES as readonly string[]).includes(value);
}

