import type { ModelConfig } from "./types/config.js";

export const MAX_MODEL_FALLBACKS = 3;

export type ModelSelection = string | ModelConfig;

export interface NormalizedModelPolicy {
  primary: string;
  fallbacks: string[];
  candidates: string[];
}

export interface NormalizeModelPolicyOptions {
  maxFallbacks?: number;
}

export function normalizeModelPolicy(
  selection: ModelSelection,
  options: NormalizeModelPolicyOptions = {},
): NormalizedModelPolicy {
  const maxFallbacks = options.maxFallbacks ?? MAX_MODEL_FALLBACKS;
  if (!Number.isInteger(maxFallbacks) || maxFallbacks < 0) {
    throw new Error("Model fallback limit must be a non-negative integer");
  }

  const primary = normalizePrimary(selection);
  const fallbacks = normalizeFallbacks(selection, primary, maxFallbacks);

  return {
    primary,
    fallbacks,
    candidates: [primary, ...fallbacks],
  };
}

export function isModelConfig(value: unknown): value is ModelConfig {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizePrimary(selection: ModelSelection): string {
  if (typeof selection === "string") {
    const primary = selection.trim();
    if (!primary) throw new Error("Model policy primary model cannot be empty");
    return primary;
  }

  if (!isModelConfig(selection)) {
    throw new Error("Model policy must be a model string or a model config object");
  }

  const primary = selection.primary?.trim();
  if (!primary) throw new Error("Model policy primary model cannot be empty");
  return primary;
}

function normalizeFallbacks(
  selection: ModelSelection,
  primary: string,
  maxFallbacks: number,
): string[] {
  if (typeof selection === "string") return [];

  const values = selection.fallbacks ?? [];
  if (!Array.isArray(values)) {
    throw new Error("Model policy fallbacks must be an array of model strings");
  }

  const seen = new Set([primary]);
  const fallbacks: string[] = [];

  for (const value of values) {
    if (typeof value !== "string") {
      throw new Error("Model policy fallbacks must be model strings");
    }
    const fallback = value.trim();
    if (!fallback) {
      throw new Error("Model policy fallbacks cannot contain empty model ids");
    }
    if (seen.has(fallback)) continue;
    seen.add(fallback);
    fallbacks.push(fallback);
  }

  if (fallbacks.length > maxFallbacks) {
    throw new Error(`Model policy supports at most ${maxFallbacks} fallback models`);
  }

  return fallbacks;
}
