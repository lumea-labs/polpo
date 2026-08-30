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
    readonly rerank?: number;
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
  readonly forbiddenIds?: readonly string[];
  readonly tags?: readonly SemanticRetrievalEvalTag[];
  readonly limit?: number;
}

export const SEMANTIC_RETRIEVAL_EVAL_TAGS = [
  "exact_identifier",
  "paraphrase",
  "multilingual",
  "abstention",
  "stale",
  "revoked",
  "cross_scope",
] as const;
export type SemanticRetrievalEvalTag =
  (typeof SEMANTIC_RETRIEVAL_EVAL_TAGS)[number];

export interface SemanticRetrievalEvalObservationInput {
  readonly resultIds: readonly string[];
  readonly durationMs?: number;
  readonly fallbackReason?: string;
}

export interface SemanticRetrievalEvalCaseReport {
  readonly id: string;
  readonly tags: readonly SemanticRetrievalEvalTag[];
  readonly relevantIds: readonly string[];
  readonly forbiddenIds: readonly string[];
  readonly limit?: number;
  readonly resultIds: readonly string[];
  readonly hit: boolean;
  readonly firstRelevantRank?: number;
  readonly reciprocalRank: number;
  readonly ndcgAtK: number;
  readonly forbiddenResultIds: readonly string[];
  readonly abstentionFalsePositive: boolean;
  readonly durationMs: number;
  readonly fallbackReason?: string;
  readonly failure?: "retriever_error";
}

export interface SemanticRetrievalEvalReport {
  readonly cases: number;
  readonly retrievalCases: number;
  readonly hits: number;
  readonly recallAtK: number;
  readonly mrr: number;
  readonly ndcgAtK: number;
  readonly missedCaseIds: readonly string[];
  readonly abstentionCases: number;
  readonly abstentionFalsePositives: number;
  readonly abstentionFalsePositiveRate: number;
  readonly forbiddenResultCount: number;
  readonly failures: number;
  readonly failedCaseIds: readonly string[];
  readonly failureRate: number;
  readonly exactIdentifier: {
    readonly cases: number;
    readonly hits: number;
    readonly recallAtK: number;
  };
  readonly latencyMs: {
    readonly p50: number;
    readonly p95: number;
    readonly max: number;
  };
  readonly caseReports: readonly SemanticRetrievalEvalCaseReport[];
}

export interface SemanticRetrievalQualityGatePolicy {
  readonly minimumRecallAtK?: number;
  readonly minimumMrr?: number;
  readonly minimumNdcgAtK?: number;
  readonly minimumExactIdentifierRecall?: number;
  readonly maximumAbstentionFalsePositiveRate?: number;
  readonly maximumForbiddenResults?: number;
  readonly maximumFailureRate?: number;
  readonly maximumP95LatencyMs?: number;
  readonly maximumRecallAtKRegression?: number;
  readonly maximumMrrRegression?: number;
  readonly maximumNdcgAtKRegression?: number;
  readonly maximumExactIdentifierRecallRegression?: number;
}

export type SemanticRetrievalQualityGateFailureCode =
  | "minimum_recall_at_k"
  | "minimum_mrr"
  | "minimum_ndcg_at_k"
  | "minimum_exact_identifier_recall"
  | "abstention_false_positive_rate"
  | "forbidden_results"
  | "failure_rate"
  | "p95_latency"
  | "recall_at_k_regression"
  | "mrr_regression"
  | "ndcg_at_k_regression"
  | "exact_identifier_regression";

export interface SemanticRetrievalQualityGateFailure {
  readonly code: SemanticRetrievalQualityGateFailureCode;
  readonly actual: number;
  readonly threshold: number;
  readonly caseIds?: readonly string[];
}

export interface SemanticRetrievalQualityGateResult {
  readonly passed: boolean;
  readonly failures: readonly SemanticRetrievalQualityGateFailure[];
}

export interface TextRerankCandidate {
  readonly id: string;
  readonly text: string;
}

export interface TextRerankRequest {
  readonly query: string;
  readonly candidates: readonly TextRerankCandidate[];
  readonly limit: number;
  readonly signal?: AbortSignal;
}

export interface TextRerankScore {
  readonly id: string;
  readonly score: number;
}

export interface TextRerankResult {
  readonly ranking: readonly TextRerankScore[];
  readonly usage?: unknown;
}

export interface TextReranker {
  rerank(request: TextRerankRequest): Promise<TextRerankResult>;
}

export interface TextRerankedCandidate {
  readonly candidate: TextRerankCandidate;
  readonly score?: number;
}

export interface TextRerankOutcome {
  readonly ranking: readonly TextRerankedCandidate[];
  readonly usage?: unknown;
  readonly fallbackReason?:
    | "reranker_invalid_output"
    | "reranker_timeout"
    | "reranker_unavailable";
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
  ) => Promise<readonly string[] | SemanticRetrievalEvalObservationInput>,
): Promise<SemanticRetrievalEvalReport> {
  if (!Array.isArray(cases) || typeof retrieve !== "function") {
    throw new TypeError("semantic retrieval eval cases and retriever are required");
  }
  const normalizedCases = normalizeEvalCases(cases);
  const caseReports: SemanticRetrievalEvalCaseReport[] = [];
  for (const value of normalizedCases) {
    const startedAt = performance.now();
    let observation: SemanticRetrievalEvalObservationInput;
    let failure: "retriever_error" | undefined;
    let returned: readonly string[] | SemanticRetrievalEvalObservationInput | undefined;
    try {
      returned = await retrieve(value);
    } catch (error) {
      if (isAbortError(error)) throw error;
      failure = "retriever_error";
    }
    observation = failure
      ? { resultIds: [] }
      : Array.isArray(returned)
        ? { resultIds: returned }
        : normalizeEvalObservation(returned, value);
    const durationMs = observation.durationMs
      ?? Math.max(0, performance.now() - startedAt);
    const resultIds = normalizeResultIds(observation.resultIds, value);
    const relevant = new Set(value.relevantIds);
    const forbidden = new Set(value.forbiddenIds);
    const firstRelevantIndex = resultIds.findIndex((id) => relevant.has(id));
    const firstRelevantRank = firstRelevantIndex < 0
      ? undefined
      : firstRelevantIndex + 1;
    const k = value.limit
      ?? Math.max(resultIds.length, value.relevantIds.length);
    const dcg = resultIds.slice(0, k).reduce((total, id, index) => (
      total + (relevant.has(id) ? 1 / Math.log2(index + 2) : 0)
    ), 0);
    const idealCount = Math.min(value.relevantIds.length, k);
    let idealDcg = 0;
    for (let index = 0; index < idealCount; index += 1) {
      idealDcg += 1 / Math.log2(index + 2);
    }
    const abstention = value.tags.includes("abstention");
    const forbiddenResultIds = resultIds.filter((id) => forbidden.has(id));
    caseReports.push(Object.freeze({
      id: value.id,
      tags: value.tags,
      relevantIds: value.relevantIds,
      forbiddenIds: value.forbiddenIds,
      ...(value.limit === undefined ? {} : { limit: value.limit }),
      resultIds,
      hit: !abstention && firstRelevantRank !== undefined,
      ...(firstRelevantRank === undefined ? {} : { firstRelevantRank }),
      reciprocalRank: firstRelevantRank === undefined ? 0 : 1 / firstRelevantRank,
      ndcgAtK: idealDcg === 0 ? 1 : dcg / idealDcg,
      forbiddenResultIds: Object.freeze(forbiddenResultIds),
      abstentionFalsePositive: abstention && resultIds.length > 0,
      durationMs,
      ...(observation.fallbackReason
        ? { fallbackReason: normalizeReasonCode(
          observation.fallbackReason,
          `case ${value.id} fallbackReason`,
        ) }
        : {}),
      ...(failure ? { failure } : {}),
    }));
  }
  return createEvalReport(caseReports);
}

function requiredText(
  value: unknown,
  path: string,
  max = MAX_IDENTITY_TEXT,
): string {
  if (typeof value !== "string") throw new TypeError(`${path} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    throw new TypeError(`${path} must contain between 1 and ${max} characters`);
  }
  return normalized;
}

function canonicalIdentity(value: unknown, path: string): string {
  const normalized = requiredText(value, path);
  if (normalized !== normalized.normalize("NFKC")) {
    throw new TypeError(`${path} must be Unicode-normalized with NFKC`);
  }
  return normalized;
}

interface NormalizedSemanticRetrievalEvalCase extends SemanticRetrievalEvalCase {
  readonly forbiddenIds: readonly string[];
  readonly tags: readonly SemanticRetrievalEvalTag[];
}

const evalTags = new Set<string>(SEMANTIC_RETRIEVAL_EVAL_TAGS);

function uniqueIdentities(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  const seen = new Set<string>();
  return Object.freeze(value.map((candidate, index) => {
    const id = canonicalIdentity(candidate, `${path}[${index}]`);
    if (seen.has(id)) throw new TypeError(`${path} contains duplicate identity ${id}`);
    seen.add(id);
    return id;
  }));
}

function normalizeEvalCases(
  values: readonly SemanticRetrievalEvalCase[],
): readonly NormalizedSemanticRetrievalEvalCase[] {
  const seen = new Set<string>();
  return Object.freeze(values.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError(`cases[${index}] must be an object`);
    }
    const id = canonicalIdentity(value.id, `cases[${index}].id`);
    if (seen.has(id)) throw new TypeError(`cases contains duplicate id ${id}`);
    seen.add(id);
    if (value.tags !== undefined && !Array.isArray(value.tags)) {
      throw new TypeError(`cases[${index}].tags must be an array`);
    }
    const tags = Object.freeze((value.tags ?? []).map((tag, tagIndex) => {
      if (!evalTags.has(tag)) {
        throw new TypeError(`cases[${index}].tags[${tagIndex}] is invalid`);
      }
      return tag;
    }));
    if (new Set(tags).size !== tags.length) {
      throw new TypeError(`cases[${index}].tags contains duplicates`);
    }
    const relevantIds = uniqueIdentities(
      value.relevantIds,
      `cases[${index}].relevantIds`,
    );
    const forbiddenIds = uniqueIdentities(
      value.forbiddenIds ?? [],
      `cases[${index}].forbiddenIds`,
    );
    const abstention = tags.includes("abstention");
    if (abstention && relevantIds.length > 0) {
      throw new TypeError(`cases[${index}] abstention case must not define relevant ids`);
    }
    if (!abstention && relevantIds.length === 0) {
      throw new TypeError(`cases[${index}] requires relevant ids or the abstention tag`);
    }
    if (relevantIds.some((candidate) => forbiddenIds.includes(candidate))) {
      throw new TypeError(`cases[${index}] identity cannot be both relevant and forbidden`);
    }
    const limit = value.limit;
    if (
      limit !== undefined
      && (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000)
    ) {
      throw new TypeError(`cases[${index}].limit must be an integer between 1 and 10000`);
    }
    return Object.freeze({
      id,
      query: requiredText(value.query, `cases[${index}].query`, 32_768),
      relevantIds,
      forbiddenIds,
      tags,
      ...(limit === undefined ? {} : { limit }),
    });
  }));
}

function normalizeDuration(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${path} must be a finite non-negative number`);
  }
  return value;
}

function normalizeReasonCode(value: unknown, path: string): string {
  const code = requiredText(value, path, 128);
  if (!/^[a-z][a-z0-9_.:-]*$/u.test(code)) {
    throw new TypeError(`${path} must be a sanitized reason code`);
  }
  return code;
}

function normalizeEvalObservation(
  value: unknown,
  evalCase: NormalizedSemanticRetrievalEvalCase,
): SemanticRetrievalEvalObservationInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`case ${evalCase.id} observation must be an object or result array`);
  }
  const input = value as SemanticRetrievalEvalObservationInput;
  return Object.freeze({
    resultIds: normalizeResultIds(input.resultIds, evalCase),
    ...(input.durationMs === undefined
      ? {}
      : { durationMs: normalizeDuration(input.durationMs, `case ${evalCase.id} durationMs`) }),
    ...(input.fallbackReason === undefined
      ? {}
      : { fallbackReason: normalizeReasonCode(
        input.fallbackReason,
        `case ${evalCase.id} fallbackReason`,
      ) }),
  });
}

function normalizeResultIds(
  value: unknown,
  evalCase: Pick<NormalizedSemanticRetrievalEvalCase, "id" | "limit">,
): readonly string[] {
  const result = uniqueIdentities(value, `case ${evalCase.id} resultIds`);
  if (evalCase.limit !== undefined && result.length > evalCase.limit) {
    throw new TypeError(`case ${evalCase.id} resultIds exceeds limit`);
  }
  if (result.length > 10_000) {
    throw new TypeError(`case ${evalCase.id} resultIds exceeds maximum size`);
  }
  return result;
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
}

function createEvalReport(
  caseReports: readonly SemanticRetrievalEvalCaseReport[],
): SemanticRetrievalEvalReport {
  const retrieval = caseReports.filter((value) => !value.tags.includes("abstention"));
  const abstention = caseReports.filter((value) => value.tags.includes("abstention"));
  const exact = retrieval.filter((value) => value.tags.includes("exact_identifier"));
  const hits = retrieval.filter((value) => value.hit).length;
  const exactHits = exact.filter((value) => value.hit).length;
  const failures = caseReports.filter((value) => value.failure);
  const falsePositives = abstention.filter((value) => value.abstentionFalsePositive).length;
  const average = (
    values: readonly SemanticRetrievalEvalCaseReport[],
    select: (value: SemanticRetrievalEvalCaseReport) => number,
  ) => values.length === 0
    ? 1
    : values.reduce((total, value) => total + select(value), 0) / values.length;
  const durations = caseReports.map((value) => value.durationMs);
  return Object.freeze({
    cases: caseReports.length,
    retrievalCases: retrieval.length,
    hits,
    recallAtK: retrieval.length === 0 ? 1 : hits / retrieval.length,
    mrr: average(retrieval, (value) => value.reciprocalRank),
    ndcgAtK: average(retrieval, (value) => value.ndcgAtK),
    missedCaseIds: Object.freeze(retrieval.filter((value) => !value.hit).map(({ id }) => id)),
    abstentionCases: abstention.length,
    abstentionFalsePositives: falsePositives,
    abstentionFalsePositiveRate: abstention.length === 0
      ? 0
      : falsePositives / abstention.length,
    forbiddenResultCount: caseReports.reduce(
      (total, value) => total + value.forbiddenResultIds.length,
      0,
    ),
    failures: failures.length,
    failedCaseIds: Object.freeze(failures.map(({ id }) => id)),
    failureRate: caseReports.length === 0 ? 0 : failures.length / caseReports.length,
    exactIdentifier: Object.freeze({
      cases: exact.length,
      hits: exactHits,
      recallAtK: exact.length === 0 ? 1 : exactHits / exact.length,
    }),
    latencyMs: Object.freeze({
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
      max: durations.length === 0 ? 0 : Math.max(...durations),
    }),
    caseReports: Object.freeze([...caseReports]),
  });
}

function rate(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${path} must be a finite number between 0 and 1`);
  }
  return value;
}

export function evaluateSemanticRetrievalQualityGate(input: {
  readonly baseline: SemanticRetrievalEvalReport;
  readonly candidate: SemanticRetrievalEvalReport;
  readonly policy?: SemanticRetrievalQualityGatePolicy;
}): SemanticRetrievalQualityGateResult {
  const manifestIdentity = (report: SemanticRetrievalEvalReport): string => {
    if (
      !report
      || typeof report !== "object"
      || !Array.isArray(report.caseReports)
      || report.cases !== report.caseReports.length
    ) {
      throw new TypeError("quality gate report is malformed");
    }
    const seen = new Set<string>();
    return JSON.stringify(report.caseReports.map((value, index) => {
      const id = canonicalIdentity(value?.id, `caseReports[${index}].id`);
      if (seen.has(id)) throw new TypeError(`caseReports contains duplicate id ${id}`);
      seen.add(id);
      if (
        !Array.isArray(value.tags)
        || value.tags.some((tag: unknown) => (
          typeof tag !== "string" || !evalTags.has(tag)
        ))
      ) {
        throw new TypeError(`caseReports[${index}].tags is invalid`);
      }
      if (
        !Array.isArray(value.relevantIds)
        || !Array.isArray(value.forbiddenIds)
      ) {
        throw new TypeError(`caseReports[${index}] manifest identity is invalid`);
      }
      return [
        id,
        [...value.tags].sort(),
        [...value.relevantIds].sort(),
        [...value.forbiddenIds].sort(),
        value.limit ?? null,
      ];
    }));
  };
  if (manifestIdentity(input.baseline) !== manifestIdentity(input.candidate)) {
    throw new TypeError("quality gate reports must use the same case manifest");
  }
  const validateReport = (
    report: SemanticRetrievalEvalReport,
    path: string,
  ) => {
    rate(report.recallAtK, `${path}.recallAtK`);
    rate(report.mrr, `${path}.mrr`);
    rate(report.ndcgAtK, `${path}.ndcgAtK`);
    rate(report.abstentionFalsePositiveRate, `${path}.abstentionFalsePositiveRate`);
    rate(report.failureRate, `${path}.failureRate`);
    rate(report.exactIdentifier?.recallAtK, `${path}.exactIdentifier.recallAtK`);
    for (const [name, value] of Object.entries(report.latencyMs ?? {})) {
      normalizeDuration(value, `${path}.latencyMs.${name}`);
    }
    if (
      !report.latencyMs
      || !Object.hasOwn(report.latencyMs, "p50")
      || !Object.hasOwn(report.latencyMs, "p95")
      || !Object.hasOwn(report.latencyMs, "max")
    ) {
      throw new TypeError(`${path}.latencyMs is malformed`);
    }
    if (!Number.isSafeInteger(report.forbiddenResultCount) || report.forbiddenResultCount < 0) {
      throw new TypeError(`${path}.forbiddenResultCount must be a non-negative integer`);
    }
  };
  validateReport(input.baseline, "baseline");
  validateReport(input.candidate, "candidate");
  const policy = input.policy ?? {};
  const minimumRecallAtK = rate(policy.minimumRecallAtK ?? 0, "minimumRecallAtK");
  const minimumMrr = rate(policy.minimumMrr ?? 0, "minimumMrr");
  const minimumNdcgAtK = rate(policy.minimumNdcgAtK ?? 0, "minimumNdcgAtK");
  const minimumExact = rate(
    policy.minimumExactIdentifierRecall ?? 0,
    "minimumExactIdentifierRecall",
  );
  const maximumAbstention = rate(
    policy.maximumAbstentionFalsePositiveRate ?? 1,
    "maximumAbstentionFalsePositiveRate",
  );
  const maximumFailureRate = rate(
    policy.maximumFailureRate ?? 0,
    "maximumFailureRate",
  );
  const maximumRecallRegression = rate(
    policy.maximumRecallAtKRegression ?? 0,
    "maximumRecallAtKRegression",
  );
  const maximumMrrRegression = rate(
    policy.maximumMrrRegression ?? 0,
    "maximumMrrRegression",
  );
  const maximumNdcgRegression = rate(
    policy.maximumNdcgAtKRegression ?? 0,
    "maximumNdcgAtKRegression",
  );
  const maximumExactRegression = rate(
    policy.maximumExactIdentifierRecallRegression ?? 0,
    "maximumExactIdentifierRecallRegression",
  );
  const maximumForbidden = policy.maximumForbiddenResults ?? 0;
  if (!Number.isSafeInteger(maximumForbidden) || maximumForbidden < 0) {
    throw new TypeError("maximumForbiddenResults must be a non-negative integer");
  }
  const maximumP95 = policy.maximumP95LatencyMs;
  if (
    maximumP95 !== undefined
    && (typeof maximumP95 !== "number" || !Number.isFinite(maximumP95) || maximumP95 < 0)
  ) {
    throw new TypeError("maximumP95LatencyMs must be a finite non-negative number");
  }
  const failures: SemanticRetrievalQualityGateFailure[] = [];
  const add = (
    code: SemanticRetrievalQualityGateFailureCode,
    actual: number,
    threshold: number,
    caseIds?: readonly string[],
  ) => failures.push(Object.freeze({
    code,
    actual,
    threshold,
    ...(caseIds?.length ? { caseIds: Object.freeze([...caseIds]) } : {}),
  }));
  if (input.candidate.recallAtK < minimumRecallAtK) {
    add("minimum_recall_at_k", input.candidate.recallAtK, minimumRecallAtK);
  }
  if (input.candidate.mrr < minimumMrr) add("minimum_mrr", input.candidate.mrr, minimumMrr);
  if (input.candidate.ndcgAtK < minimumNdcgAtK) {
    add("minimum_ndcg_at_k", input.candidate.ndcgAtK, minimumNdcgAtK);
  }
  if (input.candidate.exactIdentifier.recallAtK < minimumExact) {
    add(
      "minimum_exact_identifier_recall",
      input.candidate.exactIdentifier.recallAtK,
      minimumExact,
    );
  }
  if (input.candidate.abstentionFalsePositiveRate > maximumAbstention) {
    add(
      "abstention_false_positive_rate",
      input.candidate.abstentionFalsePositiveRate,
      maximumAbstention,
      input.candidate.caseReports
        .filter((value) => value.abstentionFalsePositive)
        .map(({ id }) => id),
    );
  }
  if (input.candidate.forbiddenResultCount > maximumForbidden) {
    add(
      "forbidden_results",
      input.candidate.forbiddenResultCount,
      maximumForbidden,
      input.candidate.caseReports
        .filter((value) => value.forbiddenResultIds.length > 0)
        .map(({ id }) => id),
    );
  }
  if (input.candidate.failureRate > maximumFailureRate) {
    add("failure_rate", input.candidate.failureRate, maximumFailureRate, input.candidate.failedCaseIds);
  }
  if (maximumP95 !== undefined && input.candidate.latencyMs.p95 > maximumP95) {
    add("p95_latency", input.candidate.latencyMs.p95, maximumP95);
  }
  const regression = (
    code: SemanticRetrievalQualityGateFailureCode,
    baseline: number,
    candidate: number,
    maximum: number,
    caseIds?: readonly string[],
  ) => {
    const actual = baseline - candidate;
    if (actual > maximum) add(code, actual, maximum, caseIds);
  };
  regression(
    "recall_at_k_regression",
    input.baseline.recallAtK,
    input.candidate.recallAtK,
    maximumRecallRegression,
  );
  regression("mrr_regression", input.baseline.mrr, input.candidate.mrr, maximumMrrRegression);
  regression(
    "ndcg_at_k_regression",
    input.baseline.ndcgAtK,
    input.candidate.ndcgAtK,
    maximumNdcgRegression,
  );
  regression(
    "exact_identifier_regression",
    input.baseline.exactIdentifier.recallAtK,
    input.candidate.exactIdentifier.recallAtK,
    maximumExactRegression,
    input.candidate.caseReports
      .filter((value) => value.tags.includes("exact_identifier") && !value.hit)
      .map(({ id }) => id),
  );
  return Object.freeze({
    passed: failures.length === 0,
    failures: Object.freeze(failures),
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function fallbackRanking(
  candidates: readonly TextRerankCandidate[],
  limit: number,
  fallbackReason: TextRerankOutcome["fallbackReason"],
): TextRerankOutcome {
  return Object.freeze({
    ranking: Object.freeze(candidates.slice(0, limit).map((candidate) => Object.freeze({
      candidate,
    }))),
    fallbackReason,
  });
}

export async function rerankTextCandidates(
  input: {
    readonly query: string;
    readonly candidates: readonly TextRerankCandidate[];
    readonly limit: number;
    readonly timeoutMs?: number;
    readonly failureMode?: "fallback" | "strict";
    readonly signal?: AbortSignal;
  },
  reranker: TextReranker,
): Promise<TextRerankOutcome> {
  if (!reranker || typeof reranker.rerank !== "function") {
    throw new TypeError("text reranker is required");
  }
  if (!Array.isArray(input.candidates) || input.candidates.length === 0) {
    throw new TypeError("rerank candidates must be a non-empty array");
  }
  if (input.candidates.length > 1_000) {
    throw new TypeError("rerank candidates must not exceed 1000 entries");
  }
  if (
    !Number.isSafeInteger(input.limit)
    || input.limit < 1
    || input.limit > input.candidates.length
  ) {
    throw new TypeError("rerank limit must be between 1 and the candidate count");
  }
  const timeoutMs = input.timeoutMs ?? 1_500;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new TypeError("rerank timeoutMs must be an integer between 1 and 120000");
  }
  const failureMode = input.failureMode ?? "fallback";
  if (failureMode !== "fallback" && failureMode !== "strict") {
    throw new TypeError("rerank failureMode must be fallback or strict");
  }
  const seen = new Set<string>();
  const candidates = Object.freeze(input.candidates.map((candidate, index) => {
    const id = canonicalIdentity(candidate?.id, `candidates[${index}].id`);
    if (seen.has(id)) throw new TypeError(`candidates contains duplicate identity ${id}`);
    seen.add(id);
    return Object.freeze({
      id,
      text: requiredText(candidate?.text, `candidates[${index}].text`, 1_000_000),
    });
  }));
  if (candidates.reduce((total, candidate) => total + candidate.text.length, 0) > 10_000_000) {
    throw new TypeError("rerank candidate text exceeds the total size limit");
  }
  const query = requiredText(input.query, "rerank query", 32_768);
  if (input.signal?.aborted) {
    throw Object.assign(new Error("Text reranking was aborted"), { name: "AbortError" });
  }
  const controller = new AbortController();
  let timedOut = false;
  let validatingOutput = false;
  const abortParent = () => controller.abort(input.signal?.reason);
  input.signal?.addEventListener("abort", abortParent, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const abortPromise = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => {
        const error = new Error(timedOut
          ? "Text reranking timed out"
          : "Text reranking was aborted");
        error.name = timedOut ? "TimeoutError" : "AbortError";
        reject(error);
      }, { once: true });
    });
    const value = await Promise.race([
      reranker.rerank({
        query,
        candidates,
        limit: input.limit,
        signal: controller.signal,
      }),
      abortPromise,
    ]);
    if (input.signal?.aborted) {
      throw Object.assign(new Error("Text reranking was aborted"), { name: "AbortError" });
    }
    validatingOutput = true;
    if (!value || typeof value !== "object" || !Array.isArray(value.ranking)) {
      throw new TypeError("text reranker returned an invalid result");
    }
    if (value.ranking.length !== input.limit) {
      throw new TypeError(`text reranker must return exactly ${input.limit} results`);
    }
    const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const ranked = new Set<string>();
    const ranking = Object.freeze(value.ranking.map((result, index) => {
      const id = canonicalIdentity(result?.id, `reranker.ranking[${index}].id`);
      const candidate = candidateById.get(id);
      if (!candidate) throw new TypeError(`text reranker returned unknown identity ${id}`);
      if (ranked.has(id)) throw new TypeError(`text reranker returned duplicate identity ${id}`);
      ranked.add(id);
      if (!Number.isFinite(result.score)) {
        throw new TypeError(`reranker.ranking[${index}].score must be finite`);
      }
      return Object.freeze({ candidate, score: result.score });
    }));
    return Object.freeze({
      ranking,
      ...(value.usage === undefined ? {} : { usage: value.usage }),
    });
  } catch (error) {
    if (isAbortError(error) && !timedOut) throw error;
    if (failureMode === "strict") throw error;
    return fallbackRanking(
      candidates,
      input.limit,
      timedOut
        ? "reranker_timeout"
        : validatingOutput && error instanceof TypeError
          ? "reranker_invalid_output"
          : "reranker_unavailable",
    );
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", abortParent);
  }
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
