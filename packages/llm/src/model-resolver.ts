/**
 * Model resolution — resolves model specs to AI SDK LanguageModel instances
 * with full metadata. Handles provider overrides, model allowlists,
 * fallback chains, and provider key validation.
 */

import type { LanguageModel } from "ai";
import type { ProviderConfig, ModelConfig, ModelAllowlistEntry } from "@polpo-ai/core";
import { parseModelSpec as _parseModelSpec } from "@polpo-ai/core";
export type { ParsedModelSpec } from "@polpo-ai/core";

import { getCatalogSync, type GatewayLanguageModelEntry, type ModelInfo } from "./gateway-catalog.js";
import { createCustomProviderModel, createGatewayModel } from "./provider-factory.js";
import { resolveApiKey, resolveApiKeyAsync, hasOAuthProfiles, PROVIDER_ENV_MAP } from "./api-keys.js";
import { getGatewayConfig } from "./gateway-config.js";

// ─── ResolvedModel ───────────────────────────────────

/**
 * A resolved model: metadata (from gateway catalog or custom provider config)
 * plus an AI SDK LanguageModel instance ready for generateText/streamText.
 */
export interface ResolvedModel {
  /** Model identifier (e.g. "claude-sonnet-4.5"). */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Provider name (e.g. "anthropic", "openai"). */
  provider: string;
  /** Whether the model supports reasoning/thinking. */
  reasoning: boolean;
  /** Supported input modalities. */
  input: string[];
  /** Context window size in tokens. */
  contextWindow: number;
  /** Max output tokens. */
  maxTokens: number;
  /** Cost per token (in USD). */
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** The AI SDK model instance to pass to generateText/streamText. */
  aiModel: LanguageModel;
}

// ─── Provider Override Management ────────────────────

/** Provider overrides from polpo.json — set by the orchestrator at init time. */
let providerOverrides: Record<string, ProviderConfig> = {};

export function setProviderOverrides(overrides: Record<string, ProviderConfig>): void {
  providerOverrides = overrides;
}

export function getProviderOverrides(): Record<string, ProviderConfig> {
  return { ...providerOverrides };
}

// ─── Model Allowlist ─────────────────────────────────

/** Model allowlist — when set, only these models can be used. Set by orchestrator at init. */
let modelAllowlist: Record<string, ModelAllowlistEntry> | undefined;

export function setModelAllowlist(allowlist: Record<string, ModelAllowlistEntry> | undefined): void {
  modelAllowlist = allowlist;
}

export function getModelAllowlist(): Record<string, ModelAllowlistEntry> | undefined {
  return modelAllowlist;
}

/**
 * Check if a model spec is allowed by the allowlist.
 * Returns true if no allowlist is set (everything allowed) or the model is in the list.
 */
export function isModelAllowed(spec: string): boolean {
  if (!modelAllowlist) return true;
  // Check exact match
  if (spec in modelAllowlist) return true;
  // Check without provider prefix (e.g. "claude-opus-4.6" matches "anthropic:claude-opus-4.6")
  const { provider, modelId } = parseModelSpec(spec);
  const fullSpec = `${provider}:${modelId}`;
  return fullSpec in modelAllowlist;
}

/**
 * Enforce model allowlist. Throws if the model is not allowed.
 */
export function enforceModelAllowlist(spec: string): void {
  if (!isModelAllowed(spec)) {
    const allowed = Object.keys(modelAllowlist!).join(", ");
    throw new Error(`Model "${spec}" is not in the allowlist. Allowed models: ${allowed}`);
  }
}

// ─── Model Spec Parsing ──────────────────────────────

/**
 * Parse a model spec string into provider + modelId.
 * Falls back to POLPO_MODEL env var. Throws if no model is available.
 */
export function parseModelSpec(spec?: string): { provider: string; modelId: string } {
  return _parseModelSpec(spec, process.env.POLPO_MODEL);
}

// ─── Model Resolution ────────────────────────────────

/**
 * Resolve a model spec to a ResolvedModel with metadata + AI SDK model instance.
 *
 * Resolution order:
 * 1. If provider has an override with custom baseUrl -> create OpenAI-compatible model
 * 2. Otherwise -> use AI Gateway (provider/modelId format)
 *
 * This ensures custom providers (Ollama, vLLM, etc.) work without being in the gateway.
 */
export function resolveModel(spec?: string): ResolvedModel {
  const { provider, modelId } = parseModelSpec(spec);
  const override = providerOverrides[provider];

  // Custom provider with baseUrl override -> use @ai-sdk/openai with custom endpoint
  if (override?.baseUrl) {
    const customDef = override.models?.find(m => m.id === modelId);
    const aiModel = createCustomProviderModel(provider, modelId, override);

    if (customDef) {
      return {
        id: customDef.id,
        name: customDef.name,
        provider,
        reasoning: customDef.reasoning ?? false,
        input: customDef.input ?? ["text"],
        cost: customDef.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: customDef.contextWindow ?? 200_000,
        maxTokens: customDef.maxTokens ?? 8192,
        aiModel,
      };
    }

    // No custom def — construct minimal metadata
    return {
      id: modelId,
      name: modelId,
      provider,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 8192,
      aiModel,
    };
  }

  // Validate that some gateway or provider key is available
  const hasGateway = !!getGatewayConfig();
  const hasVercelGatewayKey = !!process.env.AI_GATEWAY_API_KEY;
  const hasProviderKey = !!resolveApiKey(provider) || hasOAuthProfiles(provider);

  if (!hasGateway && !hasVercelGatewayKey && !hasProviderKey) {
    throw new Error(
      `No LLM gateway configured and no API key found for provider "${provider}". ` +
      `Set settings.gateway in polpo.json, ` +
      `or set AI_GATEWAY_API_KEY env var for Vercel AI Gateway, ` +
      `or set ${PROVIDER_ENV_MAP[provider] ?? `the API key env var for "${provider}"`} for direct provider access. ` +
      `See: https://docs.polpo.sh/docs/quickstart`,
    );
  }

  // Standard provider -> route through configured gateway (or Vercel AI Gateway fallback)
  const aiModel = createGatewayModel(provider, modelId);

  // Try to get metadata from cached catalog
  const catalog = getCatalogSync();
  const gatewayModelId = `${provider}/${modelId}`;
  const entry = catalog.find(m => m.id === gatewayModelId);

  if (entry) {
    const pricing = entry.pricing;
    return {
      id: modelId,
      name: entry.name || modelId,
      provider,
      reasoning: false, // Gateway catalog doesn't expose this directly
      input: ["text"],
      contextWindow: 200_000, // Gateway doesn't expose this; use sensible default
      maxTokens: 8192,
      cost: {
        input: pricing ? parseFloat(pricing.input) : 0,
        output: pricing ? parseFloat(pricing.output) : 0,
        cacheRead: pricing?.cachedInputTokens ? parseFloat(pricing.cachedInputTokens) : 0,
        cacheWrite: pricing?.cacheCreationInputTokens ? parseFloat(pricing.cacheCreationInputTokens) : 0,
      },
      aiModel,
    };
  }

  // Not in catalog (yet) — return with defaults. The model may still work via gateway.
  return {
    id: modelId,
    name: modelId,
    provider,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8192,
    aiModel,
  };
}

// ─── Model Catalog Queries ───────────────────────────

/**
 * Get detailed model info for a specific model spec.
 */
export function getModelInfo(spec: string): ModelInfo | undefined {
  try {
    const model = resolveModel(spec);
    return {
      id: model.id,
      name: model.name,
      provider: model.provider,
      reasoning: model.reasoning,
      input: model.input,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      cost: model.cost,
    };
  } catch {
    return undefined;
  }
}

/**
 * List all available providers from the AI Gateway catalog.
 * Returns synchronously from the cache; triggers background refresh if stale.
 */
export function listProviders(): string[] {
  const catalog = getCatalogSync();
  const providers = new Set<string>();
  for (const entry of catalog) {
    const slashIdx = entry.id.indexOf("/");
    if (slashIdx > 0) {
      providers.add(entry.id.slice(0, slashIdx));
    }
  }
  // Also include custom provider overrides
  for (const p of Object.keys(providerOverrides)) {
    providers.add(p);
  }
  return Array.from(providers).sort();
}

/**
 * List all models for a given provider (or all providers if none specified).
 */
export function listModels(provider?: string): ModelInfo[] {
  const catalog = getCatalogSync();
  const models: ModelInfo[] = [];

  for (const entry of catalog) {
    const slashIdx = entry.id.indexOf("/");
    if (slashIdx <= 0) continue;

    const entryProvider = entry.id.slice(0, slashIdx);
    const entryModelId = entry.id.slice(slashIdx + 1);

    if (provider && entryProvider !== provider) continue;

    const pricing = entry.pricing;
    models.push({
      id: entryModelId,
      name: entry.name || entryModelId,
      provider: entryProvider,
      reasoning: false,
      input: ["text"],
      contextWindow: 200_000,
      maxTokens: 8192,
      cost: {
        input: pricing ? parseFloat(pricing.input) : 0,
        output: pricing ? parseFloat(pricing.output) : 0,
        cacheRead: pricing?.cachedInputTokens ? parseFloat(pricing.cachedInputTokens) : 0,
        cacheWrite: pricing?.cacheCreationInputTokens ? parseFloat(pricing.cacheCreationInputTokens) : 0,
      },
    });
  }

  // Append custom models from provider overrides
  const overrideProviders = provider ? [provider] : Object.keys(providerOverrides);
  for (const p of overrideProviders) {
    const override = providerOverrides[p];
    if (!override?.models) continue;
    for (const m of override.models) {
      models.push({
        id: m.id,
        name: m.name,
        provider: p,
        reasoning: m.reasoning ?? false,
        input: m.input ?? ["text"],
        contextWindow: m.contextWindow ?? 200_000,
        maxTokens: m.maxTokens ?? 8192,
        cost: m.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      });
    }
  }

  return models;
}

/**
 * Build a dynamic model listing string for system prompts.
 * Uses the gateway catalog instead of hardcoded lists.
 */
export function buildModelListingForPrompt(): string {
  const lines: string[] = [
    `Format: "provider:model" (e.g. "anthropic:claude-opus-4.6") or just "model" (auto-inferred from prefix).`,
  ];

  const catalog = getCatalogSync();

  // Group models by provider
  const byProvider = new Map<string, GatewayLanguageModelEntry[]>();
  for (const entry of catalog) {
    const slashIdx = entry.id.indexOf("/");
    if (slashIdx <= 0) continue;
    const provider = entry.id.slice(0, slashIdx);
    if (!byProvider.has(provider)) byProvider.set(provider, []);
    byProvider.get(provider)!.push(entry);
  }

  // Show the most relevant providers with their top models
  const FEATURED_PROVIDERS: { provider: string; picks: number }[] = [
    { provider: "anthropic", picks: 3 },
    { provider: "openai", picks: 4 },
    { provider: "google", picks: 3 },
    { provider: "mistral", picks: 2 },
    { provider: "groq", picks: 2 },
    { provider: "xai", picks: 1 },
  ];

  for (const { provider, picks } of FEATURED_PROVIDERS) {
    const models = byProvider.get(provider);
    if (!models || models.length === 0) continue;

    const top = models.slice(0, picks);
    const modelStr = top.map(m => {
      const modelId = m.id.slice(m.id.indexOf("/") + 1);
      const tags: string[] = [];
      if (m.pricing && parseFloat(m.pricing.input) === 0 && parseFloat(m.pricing.output) === 0) {
        tags.push("FREE");
      }
      const tagStr = tags.length > 0 ? ` (${tags.join(", ")})` : "";
      return `${modelId}${tagStr}`;
    }).join(", ");
    lines.push(`- ${provider}: ${modelStr}`);
  }

  // Count totals
  const totalProviders = byProvider.size + Object.keys(providerOverrides).length;
  const totalModels = catalog.length;
  lines.push(`- ... and ${totalProviders} total providers with ${totalModels}+ models (use "provider:model" format)`);
  lines.push(`Configure your default model in .polpo/polpo.json or via the POLPO_MODEL env var.`);

  return lines.join("\n");
}

// ─── ModelConfig Helpers ─────────────────────────────

/**
 * Normalize a model spec that may be string or ModelConfig into a plain string.
 * Useful for APIs that only accept a string model spec.
 */
export function resolveModelSpec(spec: string | ModelConfig | undefined): string | undefined {
  if (spec === undefined) return undefined;
  if (typeof spec === "string") return spec;
  return spec.primary;
}

// ─── Model Fallback Chain ────────────────────────────

/**
 * Resolve a model from a fallback chain (synchronous).
 * Tries primary first, then each fallback in order.
 * Returns the first model that has a valid API key.
 */
export function resolveModelWithFallback(config: ModelConfig): { model: ResolvedModel; spec: string } {
  const primary = config.primary;
  if (!primary) {
    throw new Error("No primary model configured. Run 'polpo setup' or set POLPO_MODEL env var.");
  }
  const { provider: primaryProvider } = parseModelSpec(primary);
  if (resolveApiKey(primaryProvider)) {
    try {
      return { model: resolveModel(primary), spec: primary };
    } catch {
      // Primary model not found — try fallbacks
    }
  }

  if (config.fallbacks) {
    for (const fallback of config.fallbacks) {
      const { provider: fbProvider } = parseModelSpec(fallback);
      if (resolveApiKey(fbProvider)) {
        try {
          return { model: resolveModel(fallback), spec: fallback };
        } catch {
          // Model not found — try next
        }
      }
    }
  }

  // Last resort: try primary anyway (will fail at call time with a clear error)
  return { model: resolveModel(primary), spec: primary };
}

/**
 * Resolve a model from a fallback chain (async).
 * Tries primary first, then each fallback in order.
 * Checks the FULL API key resolution chain including OAuth profiles with auto-refresh.
 */
export async function resolveModelWithFallbackAsync(config: ModelConfig): Promise<{ model: ResolvedModel; spec: string }> {
  const primary = config.primary;
  if (!primary) {
    throw new Error("No primary model configured. Run 'polpo setup' or set POLPO_MODEL env var.");
  }
  const { provider: primaryProvider } = parseModelSpec(primary);
  if (await resolveApiKeyAsync(primaryProvider)) {
    try {
      return { model: resolveModel(primary), spec: primary };
    } catch {
      // Primary model not found — try fallbacks
    }
  }

  if (config.fallbacks) {
    for (const fallback of config.fallbacks) {
      const { provider: fbProvider } = parseModelSpec(fallback);
      if (await resolveApiKeyAsync(fbProvider)) {
        try {
          return { model: resolveModel(fallback), spec: fallback };
        } catch {
          // Model not found — try next
        }
      }
    }
  }

  return { model: resolveModel(primary), spec: primary };
}

// ─── Provider Validation ─────────────────────────────

export interface ProviderValidationResult {
  provider: string;
  modelSpec: string;
  hasKey: boolean;
  envVar?: string;
}

/**
 * Validate that all required providers have API keys available.
 * Returns detailed validation results for all model specs.
 */
export function validateProviderKeys(
  modelSpecs: string[]
): { provider: string; modelSpec: string }[] {
  const missing: { provider: string; modelSpec: string }[] = [];
  const seen = new Set<string>();

  for (const spec of modelSpecs) {
    const { provider } = parseModelSpec(spec);
    if (seen.has(provider)) continue;
    seen.add(provider);

    if (!resolveApiKey(provider) && !hasOAuthProfiles(provider)) {
      missing.push({ provider, modelSpec: spec });
    }
  }
  return missing;
}

/**
 * Get detailed validation for a set of model specs — including which env var to set.
 */
export function validateProviderKeysDetailed(
  modelSpecs: string[]
): ProviderValidationResult[] {
  const results: ProviderValidationResult[] = [];
  const seen = new Set<string>();

  for (const spec of modelSpecs) {
    const { provider } = parseModelSpec(spec);
    if (seen.has(provider)) continue;
    seen.add(provider);

    results.push({
      provider,
      modelSpec: spec,
      hasKey: !!resolveApiKey(provider),
      envVar: PROVIDER_ENV_MAP[provider],
    });
  }
  return results;
}
