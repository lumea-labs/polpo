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
