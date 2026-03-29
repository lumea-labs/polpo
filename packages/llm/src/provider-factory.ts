/**
 * Provider factory — creates AI SDK LanguageModel instances.
 *
 * Handles both standard AI Gateway models and custom OpenAI-compatible
 * endpoints (Ollama, vLLM, LM Studio, etc.).
 */

import type { LanguageModel } from "ai";
import { gateway } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ProviderConfig, ReasoningLevel } from "@polpo-ai/core";
import { resolveApiKey } from "./api-keys.js";
import type { GatewayConfig } from "./gateway-config.js";

/**
 * Create an AI SDK LanguageModel for a custom (non-gateway) provider.
 * Uses @ai-sdk/openai with a custom baseURL for OpenAI-compatible endpoints.
 */
export function createCustomProviderModel(
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
 * Create an AI SDK LanguageModel via the configured gateway, or fall back to
 * the Vercel AI Gateway when no custom gateway is configured.
 *
 * When a gateway is configured in polpo.json (`settings.gateway`), uses
 * @ai-sdk/openai-compatible to route through any OpenAI-compatible endpoint
 * (OpenRouter, LiteLLM, Ollama, etc.).
 *
 * The gateway expects "provider/modelId" format for model identifiers.
 */
export function createGatewayModel(provider: string, modelId: string, config?: GatewayConfig): LanguageModel {
  if (!config) {
    // No explicit config — fall back to Vercel AI Gateway (reads AI_GATEWAY_API_KEY from env)
    const gatewayModelId = `${provider}/${modelId}`;
    return gateway(gatewayModelId as any) as unknown as LanguageModel;
  }

  // Use configured gateway via OpenAI-compatible provider
  const gatewayProvider = createOpenAICompatible({
    baseURL: config.url,
    name: "gateway",
    apiKey: config.apiKey,
    headers: config.headers,
  });

  const modelSpec = `${provider}/${modelId}`;
  return gatewayProvider.languageModel(modelSpec);
}

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

  // Unknown provider — return undefined as best effort
  return undefined;
}

/**
 * Build AI SDK compatible options for generateText/streamText calls.
 *
 * Returns an object with:
 * - providerOptions: reasoning/thinking configuration per provider
 * - maxTokens: max output tokens
 * - headers: additional headers (e.g. for API key passthrough)
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
