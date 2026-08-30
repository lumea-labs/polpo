import { MemoryContractError } from "./errors.js";
import { createMemoryDedupeIdentity } from "./dedupe.js";
import { normalizeMemoryItem } from "./item.js";
import {
  assertMemoryStatusTransition,
  isMemoryItemExpired,
  isMemoryItemRetrievable,
} from "./lifecycle.js";
import { evaluateMemoryWrite, type MemoryWritePolicy } from "./policy.js";
import { rankMemoryItems, selectMemoryResultsWithinBudget } from "./ranking.js";
import {
  assertTextEmbeddingResult,
  cosineSimilarity,
  fuseHybridRankings,
  normalizeTextEmbeddingIdentity,
  rerankTextCandidates,
  textEmbeddingIdentitiesEqual,
  type TextEmbeddingIdentity,
  type HybridRankingResult,
} from "../semantic-retrieval.js";
import {
  canAccessMemoryScope,
  memoryScopeKey,
  normalizeMemoryScope,
} from "./scope.js";
import {
  MemoryAuthorizationError,
  MemoryConflictError,
  MemoryPolicyError,
} from "./store-errors.js";
import type {
  MemoryGetOptions,
  MemoryItemPatch,
  MemoryItemStore,
  MemoryItemStoreSnapshot,
  MemoryListCursor,
  MemoryListPage,
  MemoryListPageQuery,
  MemoryListQuery,
  MemorySearchQuery,
  MemorySearchResult,
  MemorySemanticRetrievalOptions,
  MemoryStoreContext,
  MemoryStoreSnapshotNamespace,
  MemorySupersedeResult,
  MemoryUsageEvent,
  MemoryUsageEventType,
} from "./store-types.js";
import {
  MEMORY_KINDS,
  MEMORY_STATUSES,
  type MemoryDedupeInput,
  type MemoryItem,
  type MemoryKind,
  type MemoryStatus,
} from "./types.js";

interface NamespaceState {
  readonly items: Map<string, MemoryItem>;
  readonly usage: MemoryUsageEvent[];
}

interface StoredMemoryVector {
  readonly values: readonly number[];
  readonly identity: TextEmbeddingIdentity;
  readonly updatedAt: string;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

const memoryKinds = new Set<string>(MEMORY_KINDS);
const memoryStatuses = new Set<string>(MEMORY_STATUSES);
const usageTypes = new Set<MemoryUsageEventType>([
  "retrieved",
  "written",
  "updated",
  "superseded",
  "forgotten",
]);

function text(value: unknown, path: string, max = 512): string {
  if (typeof value !== "string") {
    throw new MemoryContractError(`${path} must be a string`, "invalid_item", path);
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > max) {
    throw new MemoryContractError(
      `${path} must contain between 1 and ${max} characters`,
      "invalid_item",
      path,
    );
  }
  return normalized;
}

function timestamp(value: unknown, path: string): string {
  if (!(typeof value === "string" || value instanceof Date)) {
    throw new MemoryContractError(`${path} must be a timestamp`, "invalid_item", path);
  }
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new MemoryContractError(`${path} must be a timestamp`, "invalid_item", path);
  }
  return parsed.toISOString();
}

function normalizeContext(context: MemoryStoreContext): MemoryStoreContext {
  if (!context || typeof context !== "object") {
    throw new MemoryContractError("Memory store context is required");
  }
  if (
    !context.access
    || typeof context.access !== "object"
    || Array.isArray(context.access)
  ) {
    throw new MemoryContractError(
      "Memory store access context is required",
      "invalid_scope",
      "access",
    );
  }
  return {
    ...context,
    namespace: text(context.namespace, "namespace"),
    access: { ...context.access },
    ...(context.now ? { now: timestamp(context.now, "now") } : {}),
  };
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return 1_000;
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new MemoryContractError(
      "Memory list limit must be an integer between 0 and 10000",
      "invalid_item",
      "limit",
    );
  }
  return value;
}

function normalizeSemanticInteger(
  value: number | undefined,
  fallback: number,
  path: string,
  minimum: number,
  maximum: number,
): number {
  const resolved = value ?? fallback;
  if (
    !Number.isSafeInteger(resolved)
    || resolved < minimum
    || resolved > maximum
  ) {
    throw new MemoryContractError(
      `Memory ${path} must be an integer between ${minimum} and ${maximum}`,
      "invalid_item",
      path,
    );
  }
  return resolved;
}

function normalizeListCursor(value: MemoryListCursor): MemoryListCursor {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MemoryContractError(
      "Memory list cursor must be an object",
      "invalid_item",
      "after",
    );
  }
  const keys = Object.keys(value);
  if (
    keys.length !== 2
    || !keys.includes("createdAt")
    || !keys.includes("id")
  ) {
    throw new MemoryContractError(
      "Memory list cursor is malformed",
      "invalid_item",
      "after",
    );
  }
  return Object.freeze({
    createdAt: timestamp(value.createdAt, "after.createdAt"),
    id: text(value.id, "after.id", 256),
  });
}

function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = [...left];
  const rightPoints = [...right];
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const leftPoint = leftPoints[index]!.codePointAt(0)!;
    const rightPoint = rightPoints[index]!.codePointAt(0)!;
    if (leftPoint !== rightPoint) return leftPoint - rightPoint;
  }
  return leftPoints.length - rightPoints.length;
}

function compareListPositions(
  left: MemoryListCursor,
  right: MemoryListCursor,
): number {
  return left.createdAt.localeCompare(right.createdAt)
    || compareUnicodeCodePoints(left.id, right.id);
}

function normalizeUsageEvent(value: MemoryUsageEvent): MemoryUsageEvent {
  if (!value || typeof value !== "object" || !usageTypes.has(value.type)) {
    throw new MemoryContractError("Invalid Memory usage event");
  }
  return Object.freeze({
    id: text(value.id, "usage.id", 256),
    memoryId: text(value.memoryId, "usage.memoryId", 256),
    type: value.type,
    at: timestamp(value.at, "usage.at"),
    ...(value.runId ? { runId: text(value.runId, "usage.runId") } : {}),
    ...(value.sessionId
      ? { sessionId: text(value.sessionId, "usage.sessionId") }
      : {}),
    ...(value.requestId
      ? { requestId: text(value.requestId, "usage.requestId") }
      : {}),
  });
}

function cloneItem(item: MemoryItem): MemoryItem {
  return normalizeMemoryItem(JSON.parse(JSON.stringify(item)));
}

function cloneUsage(event: MemoryUsageEvent): MemoryUsageEvent {
  return normalizeUsageEvent(JSON.parse(JSON.stringify(event)));
}

export class InMemoryMemoryItemStore implements MemoryItemStore {
  private readonly namespaces = new Map<string, NamespaceState>();
  private readonly vectors = new Map<string, StoredMemoryVector>();
  private readonly embeddingProvider?: MemorySemanticRetrievalOptions["embeddingProvider"];
  private readonly embeddingFailureMode: "fallback" | "strict";
  private readonly reranker?: MemorySemanticRetrievalOptions["reranker"];
  private readonly rerankLimit: number;
  private readonly rerankTimeoutMs: number;
  private readonly rerankFailureMode: "fallback" | "strict";

  constructor(
    private readonly writePolicy: MemoryWritePolicy = {},
    snapshot?: MemoryItemStoreSnapshot,
    semantic: MemorySemanticRetrievalOptions = {},
  ) {
    this.embeddingProvider = semantic.embeddingProvider;
    this.embeddingFailureMode = semantic.embeddingFailureMode ?? "fallback";
    this.reranker = semantic.reranker;
    this.rerankLimit = normalizeSemanticInteger(
      semantic.rerankLimit,
      0,
      "rerankLimit",
      0,
      1_000,
    );
    this.rerankTimeoutMs = normalizeSemanticInteger(
      semantic.rerankTimeoutMs,
      1_500,
      "rerankTimeoutMs",
      1,
      120_000,
    );
    this.rerankFailureMode = semantic.rerankFailureMode ?? "fallback";
    if (this.rerankLimit > 0 && !this.reranker) {
      throw new MemoryContractError(
        "Memory rerankLimit requires a reranker",
        "invalid_item",
        "rerankLimit",
      );
    }
    if (
      this.rerankFailureMode !== "fallback"
      && this.rerankFailureMode !== "strict"
    ) {
      throw new MemoryContractError(
        "Memory rerankFailureMode must be fallback or strict",
        "invalid_item",
        "rerankFailureMode",
      );
    }
    if (snapshot) this.replaceSnapshot(snapshot);
  }

  private vectorKey(namespace: string, itemId: string): string {
    return JSON.stringify([namespace, itemId]);
  }

  private async embedItem(
    item: MemoryItem,
  ): Promise<StoredMemoryVector | undefined> {
    if (!this.embeddingProvider) return undefined;
    try {
      const identity = normalizeTextEmbeddingIdentity(
        await this.embeddingProvider.identity(),
      );
      const result = assertTextEmbeddingResult(
        await this.embeddingProvider.embed({
          texts: [`${item.summary ?? ""}\n${item.content}`],
          task: "document",
        }),
        { expectedCount: 1, expectedIdentity: identity },
      );
      return Object.freeze({
        values: result.vectors[0]!,
        identity: result.identity,
        updatedAt: item.updatedAt,
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (this.embeddingFailureMode === "strict") throw error;
      return undefined;
    }
  }

  async rebuildSemanticIndex(): Promise<Readonly<{
    indexed: number;
    skipped: number;
  }>> {
    if (!this.embeddingProvider) {
      return Object.freeze({ indexed: 0, skipped: 0 });
    }
    const candidates = [...this.namespaces.entries()].flatMap(([namespace, state]) => (
      [...state.items.values()]
        .filter((item) => item.status === "active")
        .map((item) => ({ namespace, item }))
    ));
    let indexed = 0;
    let skipped = 0;
    for (const { namespace, item } of candidates) {
      const key = this.vectorKey(namespace, item.id);
      this.vectors.delete(key);
      const vector = await this.embedItem(item);
      const current = this.namespaces.get(namespace)?.items.get(item.id);
      if (current !== item || current.status !== "active" || !vector) {
        skipped += 1;
        continue;
      }
      this.vectors.set(key, vector);
      indexed += 1;
    }
    return Object.freeze({ indexed, skipped });
  }

  private state(namespace: string): NamespaceState {
    let state = this.namespaces.get(namespace);
    if (!state) {
      state = { items: new Map(), usage: [] };
      this.namespaces.set(namespace, state);
    }
    return state;
  }

  private existing(
    id: string,
    context: MemoryStoreContext,
  ): MemoryItem | undefined {
    const normalized = normalizeContext(context);
    const item = this.namespaces.get(normalized.namespace)?.items.get(
      text(id, "id", 256),
    );
    if (!item || !canAccessMemoryScope(item.scope, normalized.access)) {
      return undefined;
    }
    return item;
  }

  private async assertWriteAllowed(
    item: MemoryItem,
    context: MemoryStoreContext,
  ): Promise<void> {
    const decision = await evaluateMemoryWrite(item, context, this.writePolicy);
    const unauthorized = decision.violations.some(
      (violation) => violation.code === "unauthorized_scope",
    );
    if (unauthorized) throw new MemoryAuthorizationError();
    if (!decision.allowed) {
      throw new MemoryPolicyError(
        `Memory write denied: ${decision.violations
          .map((violation) => violation.code)
          .join(", ")}`,
      );
    }
  }

  async create(
    value: MemoryItem,
    context: MemoryStoreContext,
  ): Promise<MemoryItem> {
    const normalizedContext = normalizeContext(context);
    const item = cloneItem(value);
    if (item.status !== "active" && item.status !== "pending") {
      throw new MemoryContractError(
        "New Memory items may only be active or pending",
        "invalid_item",
        "status",
      );
    }
    await this.assertWriteAllowed(item, normalizedContext);
    const state = this.state(normalizedContext.namespace);
    if (state.items.has(item.id)) {
      throw new MemoryConflictError(
        `Memory item "${item.id}" already exists in this namespace`,
      );
    }
    const vector = await this.embedItem(item);
    if (state.items.has(item.id)) {
      throw new MemoryConflictError(
        `Memory item "${item.id}" was created during semantic indexing`,
      );
    }
    state.items.set(item.id, item);
    if (vector) {
      this.vectors.set(this.vectorKey(normalizedContext.namespace, item.id), vector);
    }
    return cloneItem(item);
  }

  async get(
    id: string,
    context: MemoryStoreContext,
    options: MemoryGetOptions = {},
  ): Promise<MemoryItem | undefined> {
    const item = this.existing(id, context);
    if (!item) return undefined;
    const now = options.now ?? context.now ?? new Date();
    if (!options.includeInactive && item.status !== "active") return undefined;
    if (!options.includeExpired && isMemoryItemExpired(item, now)) return undefined;
    return cloneItem(item);
  }

  async list(
    query: MemoryListQuery,
    context: MemoryStoreContext,
  ): Promise<MemoryItem[]> {
    const page = await this.listPage(query, context);
    return [...page.items];
  }

  async listPage(
    query: MemoryListPageQuery,
    context: MemoryStoreContext,
  ): Promise<MemoryListPage> {
    const normalized = normalizeContext(context);
    const state = this.namespaces.get(normalized.namespace);
    if (!state) return { items: [] };
    const statuses = query.statuses ?? ["active"];
    for (const status of statuses) {
      if (!memoryStatuses.has(status)) {
        throw new MemoryContractError(`Unknown Memory status: ${status}`);
      }
    }
    const kinds = query.kinds;
    if (kinds) {
      for (const kind of kinds) {
        if (!memoryKinds.has(kind)) {
          throw new MemoryContractError(`Unknown Memory kind: ${kind}`);
        }
      }
    }
    const scopeKey = query.scope
      ? memoryScopeKey(normalizeMemoryScope(query.scope))
      : undefined;
    const now = query.now ?? normalized.now ?? new Date();
    const limit = normalizeLimit(query.limit);
    const after = query.after
      ? normalizeListCursor(query.after)
      : undefined;

    const candidates = [...state.items.values()]
      .filter((item) => canAccessMemoryScope(item.scope, normalized.access))
      .filter((item) => statuses.includes(item.status))
      .filter((item) => !kinds || kinds.includes(item.kind))
      .filter((item) => !scopeKey || memoryScopeKey(item.scope) === scopeKey)
      .filter((item) => query.includeExpired || !isMemoryItemExpired(item, now))
      .sort(compareListPositions);
    const positioned = after
      ? candidates.filter((item) => compareListPositions(item, after) > 0)
      : candidates;
    if (limit === 0) return { items: [] };
    const hasMore = positioned.length > limit;
    const items = positioned.slice(0, limit).map(cloneItem);
    const last = items.at(-1);
    return {
      items,
      ...(hasMore && last
        ? {
            nextCursor: Object.freeze({
              createdAt: last.createdAt,
              id: last.id,
            }),
          }
        : {}),
    };
  }

  async update(
    id: string,
    patch: MemoryItemPatch,
    context: MemoryStoreContext,
  ): Promise<MemoryItem | undefined> {
    const normalized = normalizeContext(context);
    const current = this.existing(id, normalized);
    if (!current) return undefined;
    const status = patch.status ?? current.status;
    assertMemoryStatusTransition(current.status, status);
    const candidate = normalizeMemoryItem({
      ...current,
      ...(patch.content === undefined ? {} : { content: patch.content }),
      ...(patch.summary === undefined
        ? {}
        : patch.summary === null
          ? { summary: undefined }
          : { summary: patch.summary }),
      ...(patch.confidence === undefined
        ? {}
        : patch.confidence === null
          ? { confidence: undefined }
          : { confidence: patch.confidence }),
      ...(patch.expiresAt === undefined
        ? {}
        : patch.expiresAt === null
          ? { expiresAt: undefined }
          : { expiresAt: patch.expiresAt }),
      status,
      updatedAt: timestamp(normalized.now ?? new Date(), "now"),
    });
    await this.assertWriteAllowed(candidate, normalized);
    const state = this.state(normalized.namespace);
    if (state.items.get(current.id) !== current) {
      throw new MemoryConflictError(
        `Memory item "${current.id}" changed during update`,
      );
    }
    const vector = candidate.status === "active"
      ? await this.embedItem(candidate)
      : undefined;
    if (state.items.get(current.id) !== current) {
      throw new MemoryConflictError(
        `Memory item "${current.id}" changed during semantic indexing`,
      );
    }
    state.items.set(candidate.id, candidate);
    const vectorKey = this.vectorKey(normalized.namespace, candidate.id);
    if (vector) this.vectors.set(vectorKey, vector);
    else this.vectors.delete(vectorKey);
    return cloneItem(candidate);
  }

  async supersede(
    id: string,
    replacementValue: MemoryItem,
    context: MemoryStoreContext,
  ): Promise<MemorySupersedeResult | undefined> {
    const normalized = normalizeContext(context);
    const current = this.existing(id, normalized);
    if (!current) return undefined;
    assertMemoryStatusTransition(current.status, "superseded");
    const replacement = cloneItem(replacementValue);
    if (replacement.status !== "active") {
      throw new MemoryContractError(
        "A superseding Memory replacement must be active",
        "invalid_item",
        "status",
      );
    }
    if (replacement.id === current.id) {
      throw new MemoryConflictError("Replacement Memory id must be different");
    }
    const state = this.state(normalized.namespace);
    if (state.items.has(replacement.id)) {
      throw new MemoryConflictError(
        `Memory item "${replacement.id}" already exists in this namespace`,
      );
    }
    await this.assertWriteAllowed(replacement, normalized);
    if (state.items.get(current.id) !== current) {
      throw new MemoryConflictError(
        `Memory item "${current.id}" changed during supersede`,
      );
    }
    if (state.items.has(replacement.id)) {
      throw new MemoryConflictError(
        `Memory item "${replacement.id}" was created during supersede`,
      );
    }
    const replacementVector = await this.embedItem(replacement);
    if (state.items.get(current.id) !== current || state.items.has(replacement.id)) {
      throw new MemoryConflictError("Memory changed during semantic indexing");
    }
    const updatedAt = timestamp(normalized.now ?? new Date(), "now");
    const superseded = normalizeMemoryItem({
      ...current,
      status: "superseded",
      updatedAt,
    });
    state.items.set(current.id, superseded);
    state.items.set(replacement.id, replacement);
    this.vectors.delete(this.vectorKey(normalized.namespace, current.id));
    if (replacementVector) {
      this.vectors.set(
        this.vectorKey(normalized.namespace, replacement.id),
        replacementVector,
      );
    }
    return {
      superseded: cloneItem(superseded),
      replacement: cloneItem(replacement),
    };
  }

  async forget(id: string, context: MemoryStoreContext): Promise<boolean> {
    const normalized = normalizeContext(context);
    const current = this.existing(id, normalized);
    if (!current) return false;
    assertMemoryStatusTransition(current.status, "deleted");
    const deleted = normalizeMemoryItem({
      ...current,
      status: "deleted",
      updatedAt: timestamp(normalized.now ?? new Date(), "now"),
    });
    this.state(normalized.namespace).items.set(deleted.id, deleted);
    this.vectors.delete(this.vectorKey(normalized.namespace, deleted.id));
    return true;
  }

  async search(
    query: MemorySearchQuery,
    context: MemoryStoreContext,
  ): Promise<MemorySearchResult[]> {
    const normalizedContext = normalizeContext(context);
    const candidates = await this.list({
      statuses: ["active"],
      kinds: query.kinds,
      scope: query.scope,
      now: query.now,
      limit: 10_000,
    }, normalizedContext);
    const visible = candidates.filter((item) => isMemoryItemRetrievable(
        item,
        query.now ?? context.now ?? new Date(),
      ));
    const eligibleVectors = visible.flatMap((item) => {
      const vector = this.vectors.get(this.vectorKey(normalizedContext.namespace, item.id));
      return vector?.updatedAt === item.updatedAt ? [[item, vector] as const] : [];
    });
    const lexical = rankMemoryItems(visible, query.query);
    let semantic: Array<{ id: string; score: number }> = [];
    let fallbackReason = this.embeddingProvider && eligibleVectors.length === 0
      ? "semantic_index_unavailable"
      : undefined;
    if (this.embeddingProvider && eligibleVectors.length > 0) {
      try {
        const identity = normalizeTextEmbeddingIdentity(
          await this.embeddingProvider.identity(),
        );
        const embedded = assertTextEmbeddingResult(
          await this.embeddingProvider.embed({
            texts: [query.query],
            task: "query",
            ...(query.signal ? { signal: query.signal } : {}),
          }),
          { expectedCount: 1, expectedIdentity: identity },
        );
        semantic = eligibleVectors.flatMap(([item, vector]) => {
          if (!textEmbeddingIdentitiesEqual(vector.identity, embedded.identity)) return [];
          const score = cosineSimilarity(embedded.vectors[0]!, vector.values);
          return score > 0 ? [{ id: item.id, score }] : [];
        });
      } catch (error) {
        if (isAbortError(error)) throw error;
        if (this.embeddingFailureMode === "strict") throw error;
        fallbackReason = "embedding_unavailable";
      }
    }
    const lexicalById = new Map(lexical.map((result) => [result.item.id, result]));
    const itemById = new Map(visible.map((item) => [item.id, item]));
    const fused = fuseHybridRankings({
      lexical: lexical.map((result) => ({ id: result.item.id, score: result.score })),
      semantic,
    });
    let ranked: readonly HybridRankingResult[] = fused;
    if (this.reranker && this.rerankLimit > 0 && fused.length > 0) {
      const count = Math.min(this.rerankLimit, fused.length);
      const outcome = await rerankTextCandidates({
        query: query.query,
        candidates: fused.slice(0, count).map(({ id }) => {
          const item = itemById.get(id)!;
          return {
            id,
            text: `${item.summary ?? ""}\n${item.content}`,
          };
        }),
        limit: count,
        timeoutMs: this.rerankTimeoutMs,
        failureMode: this.rerankFailureMode,
        ...(query.signal ? { signal: query.signal } : {}),
      }, this.reranker);
      const fusedById = new Map(fused.map((result) => [result.id, result]));
      const reranked = outcome.ranking.map(({ candidate, score }) => {
        const original = fusedById.get(candidate.id)!;
        return Object.freeze({
          ...original,
          ...(score === undefined ? {} : {
            score,
            scores: Object.freeze({ ...original.scores, rerank: score }),
          }),
        });
      });
      ranked = Object.freeze([...reranked, ...fused.slice(count)]);
      if (outcome.fallbackReason) fallbackReason = outcome.fallbackReason;
    }
    const resultNow = query.now ?? context.now ?? new Date();
    const currentState = this.namespaces.get(normalizedContext.namespace);
    const final = ranked.flatMap((result): MemorySearchResult[] => {
      const lexicalResult = lexicalById.get(result.id);
      const candidate = itemById.get(result.id)!;
      const current = currentState?.items.get(result.id);
      if (
        !current
        || current.updatedAt !== candidate.updatedAt
        || !canAccessMemoryScope(current.scope, normalizedContext.access)
        || !isMemoryItemRetrievable(current, resultNow)
      ) {
        return [];
      }
      return [Object.freeze({
        item: cloneItem(current),
        score: result.score,
        matchedTerms: lexicalResult?.matchedTerms ?? Object.freeze([]),
        estimatedTokens: lexicalResult?.estimatedTokens
          ?? Math.max(1, Math.ceil((current.content.length + (current.summary?.length ?? 0)) / 4)),
        scores: Object.freeze(result.scores),
        ranks: Object.freeze(result.ranks),
        retrievalMode: result.mode,
        ...(fallbackReason ? { fallbackReason } : {}),
      })];
    });
    return selectMemoryResultsWithinBudget(final, {
      tokenBudget: query.tokenBudget ?? Number.MAX_SAFE_INTEGER,
      maxResults: query.maxResults ?? 20,
    });
  }

  async findDedupeCandidate(
    input: MemoryDedupeInput,
    context: MemoryStoreContext,
  ): Promise<MemoryItem | undefined> {
    const identity = createMemoryDedupeIdentity(input);
    const normalized = normalizeContext(context);
    const state = this.namespaces.get(normalized.namespace);
    if (!state) return undefined;
    const now = normalized.now ?? new Date();
    const candidate = [...state.items.values()]
      .filter((item) => canAccessMemoryScope(item.scope, normalized.access))
      .filter((item) => item.status === "active" || item.status === "pending")
      .filter((item) => !isMemoryItemExpired(item, now))
      .filter((item) => createMemoryDedupeIdentity(item) === identity)
      .sort((left, right) => (
        left.createdAt.localeCompare(right.createdAt)
        || left.id.localeCompare(right.id)
      ))[0];
    return candidate ? cloneItem(candidate) : undefined;
  }

  async appendUsage(
    value: MemoryUsageEvent,
    context: MemoryStoreContext,
  ): Promise<void> {
    const normalized = normalizeContext(context);
    const item = this.existing(value.memoryId, normalized);
    if (!item) throw new MemoryAuthorizationError();
    const event = normalizeUsageEvent(value);
    const state = this.state(normalized.namespace);
    if (state.usage.some((existing) => existing.id === event.id)) {
      throw new MemoryConflictError(
        `Memory usage event "${event.id}" already exists`,
      );
    }
    state.usage.push(event);
  }

  async listUsage(
    memoryId: string,
    context: MemoryStoreContext,
  ): Promise<MemoryUsageEvent[]> {
    const normalized = normalizeContext(context);
    const item = this.existing(memoryId, normalized);
    if (!item) return [];
    return (this.namespaces.get(normalized.namespace)?.usage ?? [])
      .filter((event) => event.memoryId === item.id)
      .slice()
      .sort((left, right) => (
        left.at.localeCompare(right.at)
        || left.id.localeCompare(right.id)
      ))
      .map(cloneUsage);
  }

  exportSnapshot(): MemoryItemStoreSnapshot {
    const namespaces: MemoryStoreSnapshotNamespace[] = [...this.namespaces]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([namespace, state]) => ({
        namespace,
        items: [...state.items.values()]
          .sort((left, right) => left.id.localeCompare(right.id))
          .map(cloneItem),
        usage: state.usage
          .slice()
          .sort((left, right) => left.id.localeCompare(right.id))
          .map(cloneUsage),
      }));
    return Object.freeze({
      version: 1,
      namespaces: Object.freeze(namespaces),
    });
  }

  replaceSnapshot(value: MemoryItemStoreSnapshot): void {
    if (!value || value.version !== 1 || !Array.isArray(value.namespaces)) {
      throw new MemoryContractError("Invalid Memory item store snapshot");
    }
    const next = new Map<string, NamespaceState>();
    for (const namespaceState of value.namespaces) {
      const namespace = text(namespaceState.namespace, "snapshot.namespace");
      if (next.has(namespace)) {
        throw new MemoryConflictError(`Duplicate Memory namespace "${namespace}"`);
      }
      if (
        !Array.isArray(namespaceState.items)
        || !Array.isArray(namespaceState.usage)
      ) {
        throw new MemoryContractError("Invalid Memory namespace snapshot");
      }
      const items = new Map<string, MemoryItem>();
      for (const valueItem of namespaceState.items) {
        const item = cloneItem(valueItem);
        if (items.has(item.id)) {
          throw new MemoryConflictError(`Duplicate Memory item "${item.id}"`);
        }
        items.set(item.id, item);
      }
      const usage: MemoryUsageEvent[] = namespaceState.usage.map(
        (event: MemoryUsageEvent) => cloneUsage(event),
      );
      if (new Set(usage.map((event) => event.id)).size !== usage.length) {
        throw new MemoryConflictError("Duplicate Memory usage event");
      }
      for (const event of usage) {
        if (!items.has(event.memoryId)) {
          throw new MemoryContractError(
            `Memory usage references missing item "${event.memoryId}"`,
          );
        }
      }
      next.set(namespace, { items, usage });
    }
    this.namespaces.clear();
    this.vectors.clear();
    for (const [namespace, state] of next) {
      this.namespaces.set(namespace, state);
    }
  }
}
