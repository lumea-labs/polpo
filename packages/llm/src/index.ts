/**
 * @polpo-ai/llm — Multi-provider LLM abstraction built on Vercel AI SDK + AI Gateway.
 *
 * Provides model resolution, streaming, cost tracking, provider cooldown/failover,
 * and API key resolution for all major LLM providers.
 */

// ─── Gateway Catalog ─���───────────────────────────────
export {
  fetchCatalog,
  getCatalogSync,
} from "./gateway-catalog.js";
export type { GatewayLanguageModelEntry, ModelInfo } from "./gateway-catalog.js";

// ─── Model Resolution ────────────────────────────────
export {
  // Core resolution
  parseModelSpec,
  resolveModel,
  resolveModelSpec,
  resolveModelWithFallback,
  resolveModelWithFallbackAsync,
  buildResolvedModelProviderOptions,
  getModelInfo,
  // Catalog listing (uses resolver state)
  listProviders,
  listModels,
  buildModelListingForPrompt,
  // Provider overrides
  setProviderOverrides,
  getProviderOverrides,
  // Model allowlist
  setModelAllowlist,
  getModelAllowlist,
  isModelAllowed,
  enforceModelAllowlist,
  // Provider validation
  validateProviderKeys,
  validateProviderKeysDetailed,
} from "./model-resolver.js";
export type { ResolvedModel, ParsedModelSpec, ProviderValidationResult } from "./model-resolver.js";

// ─── Gateway Config ─────────────────────────────────
export type { GatewayConfig } from "./gateway-config.js";
export type { ResolveModelOptions } from "./model-resolver.js";

// ─── Model Runtime Contracts ─────────────────────────
export {
  MODEL_RUNTIME_MODES,
  isModelRuntimeMode,
} from "./model-runtime.js";
export type {
  BillingOwner,
  CostSource,
  CreateModelInput,
  CredentialType,
  InvocationContext,
  ModelInvocationRecord,
  ModelInvocationStatus,
  ModelInvocationUsage,
  ModelOperation,
  ModelRef,
  ModelRuntimeAdapter,
  ModelRuntimeMode,
  NormalizedModelError,
  ProviderOptionInput,
  UsageExtractionInput,
} from "./model-runtime.js";

// ─── Gateway Runtime Adapter ─────────────────────────
export {
  classifyGatewayError,
  createGatewayRuntimeAdapter,
  extractGatewayInvocationDetails,
  extractGatewayModelNotFoundDetails,
  extractGatewayInvocationUsage,
  splitGatewayModelRef,
} from "./gateway-runtime-adapter.js";
export type { GatewayModelNotFoundDetails, GatewayRuntimeAdapterOptions } from "./gateway-runtime-adapter.js";

// ─── Provider Runtime Adapter ────────────────────────
export {
  classifyProviderRuntimeError,
  createProviderRuntimeAdapter,
  extractProviderInvocationDetails,
  extractProviderInvocationUsage,
  splitProviderModelRef,
} from "./provider-runtime-adapter.js";
export type { ProviderRuntimeAdapterOptions } from "./provider-runtime-adapter.js";

// ─── Runtime Normalization ───────────────────────────
export {
  classifyRuntimeError,
  extractGatewayMetadataDetails,
  extractGatewayReportedCost,
  extractLanguageModelUsage,
} from "./runtime-normalization.js";
export type { GatewayMetadataDetails, LanguageModelUsageExtractionOptions } from "./runtime-normalization.js";

// ─── Provider Factory ─────────────────────────────────
export {
  createCustomProviderModel,
  createGatewayModel,
  mapReasoningToProviderOptions,
  buildStreamOpts,
} from "./provider-factory.js";

// ─── API Keys ────────────────────────────────────────
export {
  resolveApiKey,
  resolveApiKeyAsync,
  hasOAuthProfiles,
  PROVIDER_ENV_MAP,
} from "./api-keys.js";

// ─── Cost ─���──────────────────────────────────────────
export { estimateCost } from "./cost.js";
export type { CostEstimate, LanguageModelUsage } from "./cost.js";

// ─── Cooldown ────────────────────────────────────────
export {
  isProviderInCooldown,
  markProviderCooldown,
  clearProviderCooldown,
  getProviderCooldowns,
  classifyProviderError,
} from "./cooldown.js";

// ─── Query Functions ──────────���──────────────────────
export {
  queryText,
  queryStream,
  queryTextWithFallback,
} from "./query.js";

// ─── Model Turn Primitive ───────────────────────────
export {
  streamModelTurn,
  normalizeResponseMessagesForHistory,
} from "./stream-turn.js";
export type {
  ModelTurnEvent,
  ModelTurnResult,
  StreamModelTurnInput,
} from "./stream-turn.js";

// ─── Portable Tool Schemas ──────────────────────────
export {
  toPortableToolInputSchema,
  toValidatedToolInputSchema,
} from "./tool-schema.js";

// ─── Model Policy Turn Primitive ────────────────────
export {
  ModelPolicyTurnError,
  isCommittingModelTurnEvent,
  runModelPolicyTurn,
} from "./model-policy-turn.js";
export type {
  ModelPolicyAttempt,
  ModelPolicyAttemptFailure,
  ModelPolicyAttemptResolution,
  ModelPolicyAttemptRunner,
  ModelPolicyEvent,
  ModelPolicyTurnResult,
  RunModelPolicyTurnInput,
} from "./model-policy-turn.js";

// ─── Model Route Classifier ─────────────────────────
export { createStructuredModelRouteClassifier } from "./model-route-classifier.js";
export type {
  StructuredModelRouteClassifierOptions,
  StructuredModelRouteGenerate,
  StructuredModelRouteGenerationResult,
} from "./model-route-classifier.js";
