/**
 * AI Gateway model catalog — fetching, caching, and querying.
 *
 * Uses the public AI Gateway endpoint to list available models and pricing.
 * The catalog is fetched lazily and cached for 1 hour.
 */

import type { GatewayLanguageModelEntry } from "@ai-sdk/gateway";

// ─── Re-export catalog entry type ────────────────────

export type { GatewayLanguageModelEntry };

// ─── Cached gateway catalog ──────────────────────────

let catalogCache: GatewayLanguageModelEntry[] | null = null;
let catalogFetchPromise: Promise<GatewayLanguageModelEntry[]> | null = null;
let catalogFetchedAt = 0;
const CATALOG_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Fetch and cache the AI Gateway model catalog.
 * Uses the public endpoint (no auth required for listing).
 */
export async function fetchCatalog(): Promise<GatewayLanguageModelEntry[]> {
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
export function getCatalogSync(): GatewayLanguageModelEntry[] {
  const now = Date.now();
  if (!catalogCache || now - catalogFetchedAt > CATALOG_TTL_MS) {
    // Trigger background refresh — don't block
    fetchCatalog().catch(() => {});
  }
  return catalogCache ?? [];
}

// ─── Model Info ──────────────────────────────────────

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
