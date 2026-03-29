/**
 * Query functions — wrappers around AI SDK generateText/streamText
 * with cooldown integration and provider-level failover.
 */

import { generateText, streamText, type LanguageModelUsage } from "ai";
import type { ReasoningLevel, ModelConfig } from "@polpo-ai/core";

import { resolveModel, parseModelSpec } from "./model-resolver.js";
import type { ResolvedModel } from "./model-resolver.js";
import { mapReasoningToProviderOptions } from "./provider-factory.js";
import {
  isProviderInCooldown,
  markProviderCooldown,
  clearProviderCooldown,
  classifyProviderError,
} from "./cooldown.js";

/**
 * Handle billing disable for a provider.
 * OAuth profile store removed — this is now a no-op placeholder.
 * Provider-level cooldown (markProviderCooldown) still applies.
 */
async function handleBillingDisable(_provider: string): Promise<void> {
  // No-op: OAuth profile billing tracking removed.
  // Provider-level cooldown is handled by markProviderCooldown() at the call site.
}

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
