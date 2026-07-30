import { MemoryContractError } from "./errors.js";
import type { MemoryItem } from "./types.js";
import type { MemorySearchResult } from "./store-types.js";

const TOKEN_PATTERN = /[\p{L}\p{N}]+/gu;

function terms(value: string): string[] {
  return [
    ...new Set(
      (value.normalize("NFKC").toLowerCase().match(TOKEN_PATTERN) ?? [])
        .filter(Boolean),
    ),
  ];
}

export function estimateMemoryItemTokens(item: MemoryItem): number {
  const characters = item.content.length + (item.summary?.length ?? 0);
  return Math.max(1, Math.ceil(characters / 4));
}

export function rankMemoryItems(
  items: readonly MemoryItem[],
  query: string,
): MemorySearchResult[] {
  const queryTerms = terms(query);
  if (queryTerms.length === 0) {
    throw new MemoryContractError(
      "Memory search query must contain searchable terms",
      "invalid_item",
      "query",
    );
  }
  const normalizedQuery = query.normalize("NFKC").trim().toLowerCase();

  return items
    .map((item): MemorySearchResult | undefined => {
      const searchable = `${item.summary ?? ""}\n${item.content}`
        .normalize("NFKC")
        .toLowerCase();
      const searchableTerms = new Set(terms(searchable));
      const matchedTerms = queryTerms.filter((term) => searchableTerms.has(term));
      if (matchedTerms.length === 0) return undefined;

      const coverage = matchedTerms.length / queryTerms.length;
      const density = matchedTerms.length / Math.max(1, searchableTerms.size);
      const exactPhrase = searchable.includes(normalizedQuery) ? 1 : 0;
      const score = exactPhrase * 2 + coverage + density;
      return Object.freeze({
        item,
        score,
        matchedTerms: Object.freeze(matchedTerms),
        estimatedTokens: estimateMemoryItemTokens(item),
      });
    })
    .filter((result): result is MemorySearchResult => result !== undefined)
    .sort((left, right) => (
      right.score - left.score
      || right.item.updatedAt.localeCompare(left.item.updatedAt)
      || left.item.id.localeCompare(right.item.id)
    ));
}

export function selectMemoryResultsWithinBudget(
  results: readonly MemorySearchResult[],
  options: {
    readonly tokenBudget: number;
    readonly maxResults?: number;
  },
): MemorySearchResult[] {
  if (
    !Number.isInteger(options.tokenBudget)
    || options.tokenBudget < 0
  ) {
    throw new MemoryContractError(
      "Memory token budget must be a non-negative integer",
      "invalid_item",
      "tokenBudget",
    );
  }
  const maxResults = options.maxResults ?? results.length;
  if (!Number.isInteger(maxResults) || maxResults < 0) {
    throw new MemoryContractError(
      "Memory maxResults must be a non-negative integer",
      "invalid_item",
      "maxResults",
    );
  }

  const selected: MemorySearchResult[] = [];
  let usedTokens = 0;
  for (const result of results) {
    if (selected.length >= maxResults) break;
    if (usedTokens + result.estimatedTokens > options.tokenBudget) continue;
    selected.push(result);
    usedTokens += result.estimatedTokens;
  }
  return selected;
}
