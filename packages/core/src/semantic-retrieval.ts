export const TEXT_EMBEDDING_TASKS = ["document", "query"] as const;
export type TextEmbeddingTask = (typeof TEXT_EMBEDDING_TASKS)[number];

export interface TextEmbeddingIdentity {
  readonly provider: string;
  readonly model: string;
  readonly dimensions: number;
  readonly revision: string;
}

export interface TextEmbeddingRequest {
  readonly texts: readonly string[];
  readonly task: TextEmbeddingTask;
  readonly signal?: AbortSignal;
}

export interface TextEmbeddingResult {
  readonly vectors: readonly (readonly number[])[];
  readonly identity: TextEmbeddingIdentity;
  readonly usage?: unknown;
}

export interface TextEmbeddingProvider {
  identity(): TextEmbeddingIdentity | Promise<TextEmbeddingIdentity>;
  embed(request: TextEmbeddingRequest): Promise<TextEmbeddingResult>;
}

export interface DerivedTextEmbedding {
  readonly corpus: string;
  readonly recordId: string;
  readonly contentHash: string;
  readonly identity: TextEmbeddingIdentity;
  readonly vector: readonly number[];
  readonly createdAt: string;
}

export interface SemanticCandidateQuery {
  readonly corpus: string;
  readonly vector: readonly number[];
  readonly identity: TextEmbeddingIdentity;
  readonly authorizedRecordIds: readonly string[];
  readonly limit: number;
  readonly signal?: AbortSignal;
}

export interface SemanticCandidate {
  readonly id: string;
  readonly score: number;
}

export interface DerivedTextEmbeddingIndex {
  upsert(
    records: readonly DerivedTextEmbedding[],
    options?: { readonly signal?: AbortSignal },
  ): Promise<void>;
  delete(input: {
    readonly corpus: string;
    readonly recordIds: readonly string[];
    readonly signal?: AbortSignal;
  }): Promise<void>;
  search(query: SemanticCandidateQuery): Promise<readonly SemanticCandidate[]>;
  health(input: {
    readonly corpus: string;
    readonly identity: TextEmbeddingIdentity;
    readonly signal?: AbortSignal;
  }): Promise<"ready" | "degraded" | "unavailable">;
  listMissing(input: {
    readonly corpus: string;
    readonly identity: TextEmbeddingIdentity;
    readonly canonical: readonly {
      readonly recordId: string;
      readonly contentHash: string;
    }[];
    readonly signal?: AbortSignal;
  }): Promise<readonly string[]>;
}

export type HybridRetrievalMode = "lexical" | "semantic" | "hybrid";

export interface RankedCandidate {
  readonly id: string;
  readonly score: number;
}

export interface HybridRankingResult {
  readonly id: string;
  readonly score: number;
  readonly mode: HybridRetrievalMode;
  readonly ranks: {
    readonly lexical?: number;
    readonly semantic?: number;
  };
  readonly scores: {
    readonly lexical?: number;
    readonly semantic?: number;
  };
}

export interface HybridRetrievalPolicy {
  readonly candidateLimit?: number;
  readonly resultLimit?: number;
  readonly rrfConstant?: number;
  readonly rerankLimit?: number;
  readonly timeoutMs?: number;
  readonly failureMode?: "fallback" | "strict";
}

export interface NormalizedHybridRetrievalPolicy {
  readonly candidateLimit: number;
  readonly resultLimit: number;
  readonly rrfConstant: number;
  readonly rerankLimit: number;
  readonly timeoutMs: number;
  readonly failureMode: "fallback" | "strict";
}

export interface SemanticRetrievalEvalCase {
  readonly id: string;
  readonly query: string;
  readonly relevantIds: readonly string[];
}

export interface SemanticRetrievalEvalReport {
  readonly cases: number;
  readonly hits: number;
  readonly recallAtK: number;
  readonly missedCaseIds: readonly string[];
}

const MAX_IDENTITY_TEXT = 512;
const DEFAULT_RRF_CONSTANT = 60;

function boundedInteger(
  value: unknown,
  fallback: number,
  path: string,
  min: number,
  max: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || (resolved as number) < min || (resolved as number) > max) {
    throw new TypeError(`${path} must be an integer between ${min} and ${max}`);
  }
  return resolved as number;
}

export function normalizeHybridRetrievalPolicy(
  value: HybridRetrievalPolicy = {},
): NormalizedHybridRetrievalPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("hybrid retrieval policy must be an object");
  }
  const candidateLimit = boundedInteger(
    value.candidateLimit,
    80,
    "candidateLimit",
    1,
    10_000,
  );
  const resultLimit = boundedInteger(value.resultLimit, 20, "resultLimit", 1, 1_000);
  const rerankLimit = boundedInteger(value.rerankLimit, 0, "rerankLimit", 0, candidateLimit);
  const failureMode = value.failureMode ?? "fallback";
  if (failureMode !== "fallback" && failureMode !== "strict") {
    throw new TypeError("failureMode must be fallback or strict");
  }
  return Object.freeze({
    candidateLimit,
    resultLimit,
    rrfConstant: boundedInteger(value.rrfConstant, 60, "rrfConstant", 1, 10_000),
    rerankLimit,
    timeoutMs: boundedInteger(value.timeoutMs, 1_500, "timeoutMs", 1, 120_000),
    failureMode,
  });
}

export async function runSemanticRetrievalEval(
  cases: readonly SemanticRetrievalEvalCase[],
  retrieve: (
    value: SemanticRetrievalEvalCase,
  ) => Promise<readonly string[]>,
): Promise<SemanticRetrievalEvalReport> {
  if (!Array.isArray(cases) || typeof retrieve !== "function") {
    throw new TypeError("semantic retrieval eval cases and retriever are required");
  }
  let hits = 0;
  const missedCaseIds: string[] = [];
  for (const [index, value] of cases.entries()) {
    const id = requiredText(value?.id, `cases[${index}].id`);
    requiredText(value?.query, `cases[${index}].query`);
    if (!Array.isArray(value.relevantIds) || value.relevantIds.length === 0) {
      throw new TypeError(`cases[${index}].relevantIds must not be empty`);
    }
    const relevant = new Set(value.relevantIds.map((
      candidate: string,
      candidateIndex: number,
    ) =>
      requiredText(candidate, `cases[${index}].relevantIds[${candidateIndex}]`)));
    const returned = await retrieve(value);
    if (returned.some((candidate) => relevant.has(candidate))) hits += 1;
    else missedCaseIds.push(id);
  }
  return Object.freeze({
    cases: cases.length,
    hits,
    recallAtK: cases.length === 0 ? 1 : hits / cases.length,
    missedCaseIds: Object.freeze(missedCaseIds),
  });
}

function requiredText(value: unknown, path: string): string {
  if (typeof value !== "string") throw new TypeError(`${path} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_IDENTITY_TEXT) {
    throw new TypeError(`${path} must contain between 1 and ${MAX_IDENTITY_TEXT} characters`);
  }
  return normalized;
}

export function normalizeTextEmbeddingIdentity(
  value: TextEmbeddingIdentity,
): TextEmbeddingIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("embedding identity must be an object");
  }
  if (!Number.isSafeInteger(value.dimensions) || value.dimensions < 1) {
    throw new TypeError("embedding identity dimensions must be a positive integer");
  }
  return Object.freeze({
    provider: requiredText(value.provider, "embedding identity provider"),
    model: requiredText(value.model, "embedding identity model"),
    dimensions: value.dimensions,
    revision: requiredText(value.revision, "embedding identity revision"),
  });
}

export function textEmbeddingIdentitiesEqual(
  left: TextEmbeddingIdentity,
  right: TextEmbeddingIdentity,
): boolean {
  return left.provider === right.provider
    && left.model === right.model
    && left.dimensions === right.dimensions
    && left.revision === right.revision;
}

export function assertTextEmbeddingResult(
  value: TextEmbeddingResult,
  options: {
    readonly expectedCount: number;
    readonly expectedIdentity?: TextEmbeddingIdentity;
  },
): TextEmbeddingResult {
  if (!Number.isSafeInteger(options.expectedCount) || options.expectedCount < 0) {
    throw new TypeError("expected embedding count must be a non-negative integer");
  }
  if (!value || typeof value !== "object" || !Array.isArray(value.vectors)) {
    throw new TypeError("embedding result vectors must be an array");
  }
  const identity = normalizeTextEmbeddingIdentity(value.identity);
  if (
    options.expectedIdentity
    && !textEmbeddingIdentitiesEqual(
      identity,
      normalizeTextEmbeddingIdentity(options.expectedIdentity),
    )
  ) {
    throw new TypeError("embedding result identity is incompatible");
  }
  if (value.vectors.length !== options.expectedCount) {
    throw new TypeError("embedding result vector count is invalid");
  }
  const vectors = value.vectors.map((vector, index) => {
    if (!Array.isArray(vector) || vector.length !== identity.dimensions) {
      throw new TypeError(`embedding vector ${index} dimensions are invalid`);
    }
    if (!vector.every(Number.isFinite)) {
      throw new TypeError(`embedding vector ${index} must contain finite numbers`);
    }
    return Object.freeze([...vector]);
  });
  return Object.freeze({
    vectors: Object.freeze(vectors),
    identity,
    ...(value.usage === undefined ? {} : { usage: value.usage }),
  });
}

export function cosineSimilarity(
  left: readonly number[],
  right: readonly number[],
): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const l = left[index]!;
    const r = right[index]!;
    if (!Number.isFinite(l) || !Number.isFinite(r)) return 0;
    dot += l * r;
    leftMagnitude += l * l;
    rightMagnitude += r * r;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  const result = dot / Math.sqrt(leftMagnitude * rightMagnitude);
  return Number.isFinite(result) ? Math.max(-1, Math.min(1, result)) : 0;
}

function normalizeRanking(
  value: readonly RankedCandidate[],
  name: string,
): RankedCandidate[] {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  const strongest = new Map<string, number>();
  for (const [index, candidate] of value.entries()) {
    const id = requiredText(candidate?.id, `${name}[${index}].id`);
    if (!Number.isFinite(candidate.score)) {
      throw new TypeError(`${name}[${index}].score must be finite`);
    }
    const current = strongest.get(id);
    if (current === undefined || candidate.score > current) {
      strongest.set(id, candidate.score);
    }
  }
  return [...strongest].map(([id, score]) => ({ id, score })).sort(
    (left, right) => right.score - left.score || left.id.localeCompare(right.id),
  );
}

export function fuseHybridRankings(input: {
  readonly lexical: readonly RankedCandidate[];
  readonly semantic: readonly RankedCandidate[];
  readonly rrfConstant?: number;
  readonly limit?: number;
}): HybridRankingResult[] {
  const rrfConstant = input.rrfConstant ?? DEFAULT_RRF_CONSTANT;
  if (!Number.isSafeInteger(rrfConstant) || rrfConstant < 1 || rrfConstant > 10_000) {
    throw new TypeError("rrfConstant must be an integer between 1 and 10000");
  }
  const limit = input.limit ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new TypeError("limit must be a non-negative integer");
  }
  const lexical = normalizeRanking(input.lexical, "lexical");
  const semantic = normalizeRanking(input.semantic, "semantic");
  const values = new Map<string, {
    score: number;
    lexicalRank?: number;
    semanticRank?: number;
    lexicalScore?: number;
    semanticScore?: number;
  }>();

  const add = (candidate: RankedCandidate, rank: number, kind: "lexical" | "semantic") => {
    const current = values.get(candidate.id) ?? { score: 0 };
    current.score += 1 / (rrfConstant + rank);
    if (kind === "lexical") {
      current.lexicalRank = rank;
      current.lexicalScore = candidate.score;
    } else {
      current.semanticRank = rank;
      current.semanticScore = candidate.score;
    }
    values.set(candidate.id, current);
  };
  lexical.forEach((candidate, index) => add(candidate, index + 1, "lexical"));
  semantic.forEach((candidate, index) => add(candidate, index + 1, "semantic"));

  return [...values].map(([id, value]): HybridRankingResult => {
    const mode = value.lexicalRank !== undefined && value.semanticRank !== undefined
      ? "hybrid"
      : value.semanticRank !== undefined
        ? "semantic"
        : "lexical";
    return Object.freeze({
      id,
      score: value.score,
      mode,
      ranks: Object.freeze({
        ...(value.lexicalRank === undefined ? {} : { lexical: value.lexicalRank }),
        ...(value.semanticRank === undefined ? {} : { semantic: value.semanticRank }),
      }),
      scores: Object.freeze({
        ...(value.lexicalScore === undefined ? {} : { lexical: value.lexicalScore }),
        ...(value.semanticScore === undefined ? {} : { semantic: value.semanticScore }),
      }),
    });
  }).sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, limit);
}
