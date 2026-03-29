/**
 * Polpo LLM abstraction — multi-provider model resolution, streaming, cost tracking,
 * and provider-level failover built on Vercel AI SDK + AI Gateway.
 *
 * Replaces pi-ai with:
 * - AI Gateway for model catalog, routing, and built-in provider support
 * - AI SDK generateText/streamText for completions
 * - @ai-sdk/openai for custom OpenAI-compatible endpoints (Ollama, vLLM, etc.)
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getGlobalPolpoDir } from "../core/constants.js";
import {
  generateText,
  streamText,
  gateway,
  type LanguageModelUsage,
} from "ai";
import type { LanguageModel } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import type { GatewayLanguageModelEntry } from "@ai-sdk/gateway";
import type { ProviderConfig, ModelConfig, ModelAllowlistEntry, ReasoningLevel } from "../core/types.js";

// ─── Constants ──────────────────────────────────────

// Re-export the canonical env map from @polpo-ai/core.
// It's duplicated here for backward compat (other files import PROVIDER_ENV_MAP from pi-client).
export { PROVIDER_ENV_MAP } from "@polpo-ai/core";
import { PROVIDER_ENV_MAP } from "@polpo-ai/core";

// ─── Re-exported AI SDK types ───────────────────────

/** Re-export for consumers that need usage info. */
export type { LanguageModelUsage };

// ─── ResolvedModel ──────────────────────────────────

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

// ─── Gateway Model Catalog (lazy, cached) ───────────

/** Cached gateway catalog. */
let catalogCache: GatewayLanguageModelEntry[] | null = null;
let catalogFetchPromise: Promise<GatewayLanguageModelEntry[]> | null = null;
let catalogFetchedAt = 0;
const CATALOG_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Fetch and cache the AI Gateway model catalog.
 * Uses the public endpoint (no auth required for listing).
 */
async function fetchCatalog(): Promise<GatewayLanguageModelEntry[]> {
  const now = Date.now();
  if (catalogCache && now - catalogFetchedAt < CATALOG_TTL_MS) {
    return catalogCache;
  }

  if (catalogFetchPromise && now - catalogFetchedAt < CATALOG_TTL_MS) {
    return catalogFetchPromise;
  }

  catalogFetchPromise = (async () => {
    try {
      const resp = await fetch("https://ai-gateway.vercel.sh/v1/models");
      if (!resp.ok) {
        throw new Error(`Gateway catalog fetch failed: ${resp.status}`);
      }
      const data = (await resp.json()) as { data?: GatewayLanguageModelEntry[] };
      const models = data.data ?? [];
      catalogCache = models;
      catalogFetchedAt = Date.now();
      return models;
    } catch (err) {
      // On failure, return stale cache if available
      if (catalogCache) return catalogCache;
      throw err;
    }
  })();

  return catalogFetchPromise;
}

/**
 * Get the cached catalog synchronously (returns empty array if not yet fetched).
 * Triggers a background fetch if cache is stale.
 */
function getCatalogSync(): GatewayLanguageModelEntry[] {
  const now = Date.now();
  if (!catalogCache || now - catalogFetchedAt > CATALOG_TTL_MS) {
    // Trigger background refresh — don't block
    fetchCatalog().catch(() => {});
  }
  return catalogCache ?? [];
}

// ─── Provider override management ───────────────────

/** Provider overrides from polpo.json — set by the orchestrator at init time. */
let providerOverrides: Record<string, ProviderConfig> = {};

export function setProviderOverrides(overrides: Record<string, ProviderConfig>): void {
  providerOverrides = overrides;
}

export function getProviderOverrides(): Record<string, ProviderConfig> {
  return { ...providerOverrides };
}

// ─── Model Allowlist ────────────────────────────────

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

// ─── API Key Resolution ─────────────────────────────

/**
 * Resolve API key for a provider (synchronous).
 * Reads from process.env using the PROVIDER_ENV_MAP.
 *
 * Also checks .polpo/.env via dotenv-style parsing if the env var isn't set.
 */
export function resolveApiKey(provider: string): string | undefined {
  const envVar = PROVIDER_ENV_MAP[provider];
  if (!envVar) return undefined;
  return process.env[envVar] || undefined;
}

/**
 * Resolve API key for a provider (async, full resolution chain).
 * Priority: 1) polpo.json overrides (if they had apiKey), 2) env var lookup, 3) stored OAuth profiles.
 *
 * Returns the API key from env vars or provider config.
 */
export async function resolveApiKeyAsync(provider: string): Promise<string | undefined> {
  return resolveApiKey(provider);
}

// ─── Model Spec Parsing ─────────────────────────────
// Core logic lives in @polpo-ai/core. Re-exported here for backward compat.

import { parseModelSpec as _parseModelSpec } from "@polpo-ai/core";
export type { ParsedModelSpec } from "@polpo-ai/core";

/**
 * Parse a model spec string into provider + modelId.
 * Falls back to POLPO_MODEL env var. Throws if no model is available.
 */
export function parseModelSpec(spec?: string): { provider: string; modelId: string } {
  return _parseModelSpec(spec, process.env.POLPO_MODEL);
}

// ─── Reasoning Level Mapping ────────────────────────

/**
 * Map Polpo's ReasoningLevel to AI SDK providerOptions for reasoning/thinking.
 *
 * Each provider has its own way of enabling extended thinking:
 * - Anthropic: thinking.type + thinking.budgetTokens
 * - OpenAI: reasoningEffort
 * - Google: thinkingConfig.thinkingBudget
 */
export function mapReasoningToProviderOptions(
  provider: string,
  level: ReasoningLevel | undefined,
  maxTokens: number,
): Record<string, Record<string, unknown>> | undefined {
  if (!level || level === "off") return undefined;

  // Budget tokens as a fraction of maxTokens, scaling with reasoning level
  const budgetMap: Record<string, number> = {
    minimal: 0.1,
    low: 0.25,
    medium: 0.5,
    high: 0.75,
    xhigh: 1.0,
  };
  const fraction = budgetMap[level] ?? 0.5;
  const budgetTokens = Math.round(maxTokens * fraction);

  // OpenAI reasoning effort mapping
  const effortMap: Record<string, string> = {
    minimal: "low",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "high",
  };

  if (provider === "anthropic") {
    return {
      anthropic: {
        thinking: { type: "enabled", budgetTokens },
      },
    };
  }

  if (provider === "openai") {
    return {
      openai: {
        reasoningEffort: effortMap[level] ?? "medium",
      },
    };
  }

  if (provider === "google") {
    return {
      google: {
        thinkingConfig: {
          thinkingBudget: budgetTokens,
        },
      },
    };
  }

  // Unknown provider — return anthropic-style as best effort
  return undefined;
}

// ─── Model Resolution ───────────────────────────────

/**
 * Create an AI SDK LanguageModel for a custom (non-gateway) provider.
 * Uses @ai-sdk/openai with a custom baseURL for OpenAI-compatible endpoints.
 */
function createCustomProviderModel(
  provider: string,
  modelId: string,
  override: ProviderConfig,
): LanguageModel {
  const baseURL = override.baseUrl || "http://localhost:11434/v1";
  const apiKey = resolveApiKey(provider) || "ollama"; // Ollama doesn't need a real key

  // For anthropic-messages API, we'd need @ai-sdk/anthropic — but custom providers
  // are typically Ollama/vLLM/LM Studio which all speak OpenAI-compatible.
  const openaiProvider = createOpenAI({
    baseURL,
    apiKey,
    name: provider,
  });

  return openaiProvider(modelId) as unknown as LanguageModel;
}

/**
 * Resolve a model spec to a ResolvedModel with metadata + AI SDK model instance.
 *
 * Resolution order:
 * 1. If provider has an override with custom baseUrl → create OpenAI-compatible model
 * 2. Otherwise → use AI Gateway (provider/modelId format)
 *
 * This ensures custom providers (Ollama, vLLM, etc.) work without being in the gateway.
 */
export function resolveModel(spec?: string): ResolvedModel {
  const { provider, modelId } = parseModelSpec(spec);
  const override = providerOverrides[provider];

  // Custom provider with baseUrl override → use @ai-sdk/openai with custom endpoint
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

  // Standard provider → route through AI Gateway
  // The gateway expects "provider/modelId" format
  const gatewayModelId = `${provider}/${modelId}`;
  const aiModel = gateway(gatewayModelId as any) as unknown as LanguageModel;

  // Try to get metadata from cached catalog
  const catalog = getCatalogSync();
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

// ─── Model Catalog ──────────────────────────────────

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  input: string[];
  contextWindow: number;
  maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/**
 * List all available providers from the AI Gateway catalog.
 * Returns synchronously from the cache; triggers background refresh if stale.
 */
export function listProviders(): string[] {
  const catalog = getCatalogSync();
  const providers = new Set<string>();
  for (const entry of catalog) {
    // Gateway IDs are "provider/model" — extract the provider part
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

// ─── Cost Tracking ──────────────────────────────────

export interface CostEstimate {
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  totalCost: number;
  currency: string;
}

/**
 * Calculate the cost of an LLM call from AI SDK usage data.
 * Uses pricing from the resolved model metadata.
 * Returns cost in USD.
 */
export function estimateCost(model: ResolvedModel, usage: LanguageModelUsage): CostEstimate {
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const cacheReadTokens = usage.inputTokenDetails?.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.inputTokenDetails?.cacheWriteTokens ?? 0;

  // Cost per token (pricing is per-token from gateway)
  const inputCost = inputTokens * model.cost.input;
  const outputCost = outputTokens * model.cost.output;
  const cacheReadCost = cacheReadTokens * model.cost.cacheRead;
  const cacheWriteCost = cacheWriteTokens * model.cost.cacheWrite;

  return {
    inputCost,
    outputCost,
    cacheReadCost,
    cacheWriteCost,
    totalCost: inputCost + outputCost + cacheReadCost + cacheWriteCost,
    currency: "USD",
  };
}

// ─── Provider Validation ────────────────────────────

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
 * Check if there are any stored OAuth profiles for a provider (synchronous).
 * Used by the sync validation path so OAuth-based providers (openai-codex,
 * github-copilot, anthropic, etc.) aren't rejected before spawn.
 *
 * Reads auth-profiles.json directly to stay synchronous in ESM context.
 */
function hasOAuthProfiles(provider: string): boolean {
  try {
    const profilePath = join(getGlobalPolpoDir(), "auth-profiles.json");
    if (!existsSync(profilePath)) return false;
    const data = JSON.parse(readFileSync(profilePath, "utf-8"));
    if (!data?.profiles) return false;
    return Object.values(data.profiles).some(
      (p: any) => p.provider === provider,
    );
  } catch {
    return false;
  }
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

// ─── Dynamic prompt helpers ─────────────────────────

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

// ─── Model Fallback Chain ───────────────────────────

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

// ─── Provider Cooldown ──────────────────────────────

interface CooldownEntry {
  until: number;    // timestamp
  errorCount: number;
  reason?: string;  // "rate_limit" | "auth" | "billing" | "error"
}

const providerCooldowns: Map<string, CooldownEntry> = new Map();

const COOLDOWN_STEPS = [60_000, 300_000, 1_500_000, 3_600_000]; // 1m, 5m, 25m, 1h

/**
 * Check if a provider is currently in cooldown.
 */
export function isProviderInCooldown(provider: string): boolean {
  const entry = providerCooldowns.get(provider);
  if (!entry) return false;
  if (Date.now() >= entry.until) {
    providerCooldowns.delete(provider);
    return false;
  }
  return true;
}

/**
 * Mark a provider as temporarily unavailable (cooldown).
 */
export function markProviderCooldown(provider: string, reason?: string): void {
  const existing = providerCooldowns.get(provider);
  const errorCount = (existing?.errorCount ?? 0) + 1;
  const stepIdx = Math.min(errorCount - 1, COOLDOWN_STEPS.length - 1);
  const cooldownMs = COOLDOWN_STEPS[stepIdx];

  providerCooldowns.set(provider, {
    until: Date.now() + cooldownMs,
    errorCount,
    reason,
  });
}

/**
 * Clear cooldown for a provider (e.g. after successful call).
 */
export function clearProviderCooldown(provider: string): void {
  providerCooldowns.delete(provider);
}

/**
 * Get current cooldown state for all providers.
 */
export function getProviderCooldowns(): Record<string, { until: number; errorCount: number; reason?: string }> {
  const result: Record<string, { until: number; errorCount: number; reason?: string }> = {};
  for (const [provider, entry] of providerCooldowns) {
    if (Date.now() < entry.until) {
      result[provider] = { ...entry };
    }
  }
  return result;
}

// ─── Error Classification ───────────────────────────

/**
 * Classify an error to determine if it should trigger cooldown or failover.
 */
export function classifyProviderError(err: unknown): {
  shouldCooldown: boolean;
  shouldFailover: boolean;
  reason: string;
} {
  if (!(err instanceof Error)) {
    return { shouldCooldown: false, shouldFailover: false, reason: "unknown" };
  }

  const msg = err.message.toLowerCase();

  // Auth errors — cooldown + failover
  if (msg.includes("401") || msg.includes("unauthorized") || msg.includes("invalid api key") ||
      msg.includes("authentication") || msg.includes("forbidden") || msg.includes("403")) {
    return { shouldCooldown: true, shouldFailover: true, reason: "auth" };
  }

  // Rate limit — cooldown + failover
  if (msg.includes("429") || msg.includes("rate limit") || msg.includes("too many requests") ||
      msg.includes("quota exceeded")) {
    return { shouldCooldown: true, shouldFailover: true, reason: "rate_limit" };
  }

  // Billing — long cooldown + failover
  if (msg.includes("insufficient") || msg.includes("credit") || msg.includes("billing") ||
      msg.includes("payment required") || msg.includes("402")) {
    return { shouldCooldown: true, shouldFailover: true, reason: "billing" };
  }

  // Server errors — short cooldown, failover
  if (msg.includes("500") || msg.includes("502") || msg.includes("503") || msg.includes("504") ||
      msg.includes("overloaded") || msg.includes("service unavailable")) {
    return { shouldCooldown: true, shouldFailover: true, reason: "server_error" };
  }

  // Transient network — no cooldown, retry
  if (msg.includes("timeout") || msg.includes("econnreset") || msg.includes("econnrefused") ||
      msg.includes("socket hang up")) {
    return { shouldCooldown: false, shouldFailover: false, reason: "network" };
  }

  // Non-retryable errors (bad request, invalid model, etc.)
  if (msg.includes("400") || msg.includes("invalid") || msg.includes("not found") ||
      msg.includes("404")) {
    return { shouldCooldown: false, shouldFailover: false, reason: "client_error" };
  }

  return { shouldCooldown: false, shouldFailover: false, reason: "unknown" };
}

// ─── ModelConfig Helpers ────────────────────────────

/**
 * Normalize a model spec that may be string or ModelConfig into a plain string.
 * Useful for APIs that only accept a string model spec.
 */
export function resolveModelSpec(spec: string | ModelConfig | undefined): string | undefined {
  if (spec === undefined) return undefined;
  if (typeof spec === "string") return spec;
  return spec.primary;
}

// ─── Billing Disable Integration ────────────────────

/**
 * Handle billing disable for a provider.
 * OAuth profile store removed — this is now a no-op placeholder.
 * Provider-level cooldown (markProviderCooldown) still applies.
 */
async function handleBillingDisable(_provider: string): Promise<void> {
  // No-op: OAuth profile billing tracking removed.
  // Provider-level cooldown is handled by markProviderCooldown() at the call site.
}

// ─── Stream Options Builder ─────────────────────────

/**
 * Build AI SDK compatible options for generateText/streamText calls.
 *
 * Returns an object with:
 * - providerOptions: reasoning/thinking configuration per provider
 * - maxTokens: max output tokens
 * - headers: additional headers (e.g. for API key passthrough)
 *
 * This replaces the old pi-ai `buildStreamOpts` — callers that need the raw
 * options object for pi-agent-core Agent can still use this. The shape changed
 * but the function signature is preserved for backward compat.
 */
export function buildStreamOpts(
  apiKey?: string,
  reasoning?: ReasoningLevel,
  maxTokens?: number,
): Record<string, unknown> | undefined {
  const reasoningVal = reasoning && reasoning !== "off" ? reasoning : undefined;

  if (!apiKey && !reasoningVal && !maxTokens) return undefined;

  const opts: Record<string, unknown> = {};
  if (apiKey) opts.apiKey = apiKey;
  if (reasoningVal) opts.reasoning = reasoningVal;
  if (maxTokens) opts.maxTokens = maxTokens;
  return opts;
}

// ─── Query Functions ────────────────────────────────

/**
 * Simple prompt -> text completion using AI SDK generateText.
 * Integrates with the cooldown system: marks provider cooldown on classified errors,
 * clears cooldown on success. Uses async API key resolution (includes OAuth profiles).
 */
export async function queryText(
  prompt: string,
  model?: string,
  reasoning?: ReasoningLevel,
): Promise<{ text: string; usage?: LanguageModelUsage; model: ResolvedModel }> {
  const m = resolveModel(model);
  const provider = m.provider;

  try {
    const providerOptions = mapReasoningToProviderOptions(provider, reasoning, m.maxTokens);

    const opts: any = {
      model: m.aiModel,
      prompt,
      maxOutputTokens: m.maxTokens,
    };
    if (providerOptions) opts.providerOptions = providerOptions;
    const response = await generateText(opts);

    const text = response.text.trim();
    // Success — clear any cooldown for this provider
    clearProviderCooldown(provider);
    return {
      text,
      usage: response.usage,
      model: m,
    };
  } catch (err) {
    // Classify and potentially cooldown the provider
    const classified = classifyProviderError(err);
    if (classified.reason === "billing") {
      markProviderCooldown(provider, classified.reason);
      handleBillingDisable(provider);
    } else if (classified.shouldCooldown) {
      markProviderCooldown(provider, classified.reason);
    }
    throw err;
  }
}

/**
 * Streaming prompt -> text with progress callback.
 * Integrates with the cooldown system. Uses async API key resolution.
 */
export async function queryStream(
  prompt: string,
  model?: string,
  onProgress?: (text: string) => void,
  reasoning?: ReasoningLevel,
): Promise<{ text: string; usage?: LanguageModelUsage; model: ResolvedModel }> {
  const m = resolveModel(model);
  const provider = m.provider;

  try {
    const providerOptions = mapReasoningToProviderOptions(provider, reasoning, m.maxTokens);

    const streamOpts: any = {
      model: m.aiModel,
      prompt,
      maxOutputTokens: m.maxTokens,
    };
    if (providerOptions) streamOpts.providerOptions = providerOptions;
    const result = streamText(streamOpts);

    for await (const chunk of result.textStream) {
      if (onProgress) {
        onProgress(chunk);
      }
    }

    // Wait for the full result to get usage data
    const text = (await result.text).trim();
    const usage = await result.usage;

    // Success — clear cooldown
    clearProviderCooldown(provider);
    return {
      text,
      usage,
      model: m,
    };
  } catch (err) {
    const classified = classifyProviderError(err);
    if (classified.reason === "billing") {
      markProviderCooldown(provider, classified.reason);
      handleBillingDisable(provider);
    } else if (classified.shouldCooldown) {
      markProviderCooldown(provider, classified.reason);
    }
    throw err;
  }
}

/**
 * Query with model fallback chain — tries primary model, then fallbacks.
 * On provider-level errors, marks cooldown and tries next model.
 */
export async function queryTextWithFallback(
  prompt: string,
  modelConfig: ModelConfig,
): Promise<{ text: string; usage?: LanguageModelUsage; model: ResolvedModel; usedSpec: string }> {
  if (!modelConfig.primary) {
    throw new Error("No primary model configured. Run 'polpo setup' or set POLPO_MODEL env var.");
  }
  const specs = [modelConfig.primary, ...(modelConfig.fallbacks || [])];

  let lastError: unknown;

  for (const spec of specs) {
    const { provider } = parseModelSpec(spec);

    // Skip providers in cooldown
    if (isProviderInCooldown(provider)) continue;

    try {
      const result = await queryText(prompt, spec);
      clearProviderCooldown(provider);
      return { ...result, usedSpec: spec };
    } catch (err) {
      lastError = err;
      const classified = classifyProviderError(err);
      if (classified.shouldCooldown) {
        markProviderCooldown(provider, classified.reason);
      }
      if (!classified.shouldFailover) {
        throw err; // Non-retryable error — don't try other providers
      }
      // Continue to next fallback
    }
  }

  throw lastError ?? new Error("All model providers failed or are in cooldown");
}
