import { normalizeBrainAccessDecision } from "./contracts.js";
import { isBrainSourceRetrievable } from "./lifecycle.js";
import { normalizeBrainScope } from "./scope.js";
import { BrainStoreValidationError } from "./store-errors.js";
import type { BrainAccessPolicy, BrainReranker } from "./ports.js";
import type { BrainChunkStore, BrainSourceStore } from "./stores.js";
import type {
  BrainActorContext,
  BrainRetrievalResult,
  BrainScope,
  BrainSource,
} from "./types.js";

export interface RetrieveBrainInput {
  readonly query: string;
  readonly scopes: readonly BrainScope[];
  readonly actor: BrainActorContext;
  readonly limit?: number;
  readonly tokenBudget?: number;
}

export interface RetrieveBrainDeps {
  readonly sourceStore: BrainSourceStore;
  readonly chunkStore: BrainChunkStore;
  readonly accessPolicy: BrainAccessPolicy;
  readonly reranker?: BrainReranker;
  readonly failureMode?: "fallback" | "strict";
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  name: string,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new BrainStoreValidationError(
      `${name} must be an integer between ${min} and ${max}`,
    );
  }
  return value;
}

async function isAuthorized(
  source: BrainSource,
  actor: BrainActorContext,
  policy: BrainAccessPolicy,
): Promise<boolean> {
  try {
    return normalizeBrainAccessDecision(await policy.authorize({
      action: "search",
      source,
      actor,
    })).allowed;
  } catch {
    return false;
  }
}

function resultIdentity(result: BrainRetrievalResult): string {
  return JSON.stringify([
    result.scope.kind,
    result.scope.subjectId,
    result.chunk.id,
    result.chunk.sourceId,
    result.chunk.version,
    result.chunk.citation.sourceId,
    result.chunk.citation.version,
    result.chunk.citation.chunkId,
  ]);
}

function validateReranked(
  original: readonly BrainRetrievalResult[],
  candidate: readonly BrainRetrievalResult[],
): readonly BrainRetrievalResult[] {
  if (!Array.isArray(candidate)) {
    throw new BrainStoreValidationError("Brain reranker returned an invalid result");
  }
  const allowed = new Set(original.map(resultIdentity));
  const seen = new Set<string>();
  for (const result of candidate) {
    const identity = resultIdentity(result);
    if (
      !allowed.has(identity)
      || seen.has(identity)
      || !Number.isFinite(result.score)
    ) {
      throw new BrainStoreValidationError(
        "Brain reranker changed result or citation identity",
      );
    }
    seen.add(identity);
  }
  return candidate;
}

async function listAllSources(
  sourceStore: BrainSourceStore,
  scopes: readonly BrainScope[],
): Promise<BrainSource[]> {
  const sources: BrainSource[] = [];
  let cursor: string | undefined;
  do {
    const page = await sourceStore.listSources({
      scopes,
      statuses: ["indexed", "indexing", "failed"],
      limit: 1_000,
      ...(cursor ? { cursor } : {}),
    });
    sources.push(...page.sources);
    cursor = page.cursor;
  } while (cursor);
  return sources;
}

export async function retrieveBrain(
  input: RetrieveBrainInput,
  deps: RetrieveBrainDeps,
): Promise<readonly BrainRetrievalResult[]> {
  if (!Array.isArray(input.scopes) || input.scopes.length === 0) {
    throw new BrainStoreValidationError(
      "At least one explicit Brain scope is required",
    );
  }
  const scopes = [...new Map(input.scopes.map((scope) => {
    const normalized = normalizeBrainScope(scope);
    return [`${normalized.kind}:${normalized.subjectId}`, normalized] as const;
  })).values()];
  const query = typeof input.query === "string" ? input.query.trim() : "";
  const limit = boundedInteger(input.limit, 10, "limit", 1, 1_000);
  const tokenBudget = boundedInteger(
    input.tokenBudget,
    4_000,
    "tokenBudget",
    0,
    1_000_000,
  );
  if (!query || tokenBudget === 0) return Object.freeze([]);

  const authorized: BrainSource[] = [];
  for (const source of await listAllSources(deps.sourceStore, scopes)) {
    if (
      source.currentVersion
      && await isAuthorized(source, input.actor, deps.accessPolicy)
    ) {
      authorized.push(source);
    }
  }
  if (authorized.length === 0) return Object.freeze([]);

  const candidates = await deps.chunkStore.searchCandidates({
    sources: authorized.map((source) => ({
      scope: source.scope,
      sourceId: source.id,
    })),
    query,
    limit: Math.min(1_000, Math.max(limit * 4, limit)),
  });

  let ranked = candidates;
  if (deps.reranker && candidates.length > 0) {
    try {
      ranked = validateReranked(
        candidates,
        await deps.reranker.rerank({ query, results: candidates, limit }),
      );
    } catch (error) {
      if ((deps.failureMode ?? "fallback") === "strict") throw error;
      ranked = candidates;
    }
  }

  const final: BrainRetrievalResult[] = [];
  let usedTokens = 0;
  for (const result of ranked) {
    if (final.length >= limit) break;
    const source = await deps.sourceStore.getSource({
      scope: result.scope,
      sourceId: result.chunk.sourceId,
    });
    const visible = Boolean(
      source
      && isBrainSourceRetrievable(source)
      && source.currentVersion === result.chunk.version
      && await isAuthorized(source, input.actor, deps.accessPolicy)
    );
    if (!visible) continue;
    const tokens = result.chunk.tokenCount
      ?? Math.max(1, Math.ceil(result.chunk.content.length / 4));
    if (tokens > tokenBudget - usedTokens) continue;
    final.push(result);
    usedTokens += tokens;
  }
  return Object.freeze(final);
}
