import type { LanguageModel } from "ai";
import type {
  ModelInvocationContext,
  ModelInvocationUsage,
  ModelRef,
  ModelRuntimeMode,
  NormalizedModelError,
  UsageExtractionInput,
} from "@polpo-ai/core/model-runtime";
export {
  MODEL_RUNTIME_MODES,
  isModelRuntimeMode,
} from "@polpo-ai/core/model-runtime";
export type {
  BillingOwner,
  CostSource,
  CredentialType,
  ModelInvocationContext,
  ModelInvocationRecord,
  ModelInvocationStatus,
  ModelInvocationUsage,
  ModelOperation,
  ModelRef,
  ModelRuntimeMode,
  NormalizedModelError,
  UsageExtractionInput,
} from "@polpo-ai/core/model-runtime";

export interface InvocationContext extends ModelInvocationContext {
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
