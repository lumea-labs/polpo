/**
 * Cost estimation for LLM calls.
 *
 * Calculates cost from AI SDK usage data and model pricing metadata.
 */

import type { LanguageModelUsage } from "ai";
import type { ResolvedModel } from "./model-resolver.js";

// ─── Re-export usage type ────────────────────────────

export type { LanguageModelUsage };

// ─── Cost Types ──────────────────────────────────────

export interface CostEstimate {
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  totalCost: number;
  currency: string;
}

// ─── Cost Calculation ────────────────────────────────

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
