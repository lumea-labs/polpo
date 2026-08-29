import { nanoid } from "nanoid";
import { BrainContractError } from "./errors.js";
import { normalizeBrainScope } from "./scope.js";
import {
  BRAIN_INGESTION_JOB_STATUSES,
  BRAIN_INGESTION_OPERATIONS,
  BRAIN_SOURCE_STATUSES,
  BRAIN_SOURCE_TYPES,
  BRAIN_TRUST_LEVELS,
  BRAIN_VERSION_STATUSES,
  type BrainAccessDecision,
  type BrainChunk,
  type BrainCitation,
  type BrainFactoryOptions,
  type BrainIngestionJob,
  type BrainIngestionJobStatus,
  type BrainIngestionOperation,
  type BrainRetrievalResult,
  type BrainRetrievalScores,
  type BrainSource,
  type BrainSourceStatus,
  type BrainSourceType,
  type BrainSourceVersion,
  type BrainTrustLevel,
  type BrainVersionStatus,
  type CreateBrainChunkInput,
  type CreateBrainIngestionJobInput,
  type CreateBrainRetrievalResultInput,
  type CreateBrainSourceInput,
  type CreateBrainSourceVersionInput,
} from "./types.js";
import {
  finiteNumber,
  isoTimestamp,
  nonNegativeInteger,
  normalizeBrainFailure,
  normalizeBrainMetadata,
  optionalText,
  optionalTimestamp,
  positiveInteger,
  requiredText,
} from "./validation.js";

export const MAX_BRAIN_SOURCE_LABEL_CHARACTERS = 512;
export const MAX_BRAIN_CHUNK_CONTENT_CHARACTERS = 128_000;

const sourceTypes = new Set<string>(BRAIN_SOURCE_TYPES);
const sourceStatuses = new Set<string>(BRAIN_SOURCE_STATUSES);
const trustLevels = new Set<string>(BRAIN_TRUST_LEVELS);
const versionStatuses = new Set<string>(BRAIN_VERSION_STATUSES);
const ingestionStatuses = new Set<string>(BRAIN_INGESTION_JOB_STATUSES);
const ingestionOperations = new Set<string>(BRAIN_INGESTION_OPERATIONS);

function enumValue<T extends string>(
  value: unknown,
  values: ReadonlySet<string>,
  path: string,
  code:
    | "invalid_source"
    | "invalid_version"
    | "invalid_ingestion_job"
    | "invalid_retrieval_result",
  label: string,
): T {
  if (typeof value !== "string" || !values.has(value)) {
    throw new BrainContractError(
      `Unknown Brain ${label}: ${String(value)}`,
      code,
      path,
    );
  }
  return value as T;
}

function normalizeTrust(
  value: unknown,
  code: "invalid_source" | "invalid_retrieval_result" = "invalid_source",
): BrainTrustLevel {
  return enumValue(
    value,
    trustLevels,
    "trust",
    code,
    "trust level",
  );
}

function normalizeOptionalFailure(
  value: unknown,
  path: string,
  code: "invalid_source" | "invalid_version" | "invalid_ingestion_job",
): ReturnType<typeof normalizeBrainFailure> | undefined {
  return value === undefined
    ? undefined
    : normalizeBrainFailure(value, path, code);
}

function assertTimestampOrder(
  createdAt: string,
  updatedAt: string,
  code: "invalid_source" | "invalid_version" | "invalid_ingestion_job",
): void {
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new BrainContractError(
      "updatedAt cannot precede createdAt",
      code,
      "updatedAt",
    );
  }
}

function normalizeSourceRecord(input: Record<string, unknown>): BrainSource {
  const status = enumValue<BrainSourceStatus>(
    input.status,
    sourceStatuses,
    "status",
    "invalid_source",
    "source status",
  );
  const currentVersion = optionalText(
    input.currentVersion,
    "currentVersion",
    512,
    "invalid_source",
  );
  if (status === "pending" && currentVersion) {
    throw new BrainContractError(
      "A pending Brain source cannot have a current version",
      "invalid_source",
      "currentVersion",
    );
  }
  if (status === "indexed" && !currentVersion) {
    throw new BrainContractError(
      "An indexed Brain source requires a current version",
      "invalid_source",
      "currentVersion",
    );
  }
  const failure = normalizeOptionalFailure(
    input.failure,
    "failure",
    "invalid_source",
  );
  if (status === "failed" && !failure) {
    throw new BrainContractError(
      "A failed Brain source requires failure details",
      "invalid_source",
      "failure",
    );
  }
  const createdAt = isoTimestamp(
    input.createdAt,
    "createdAt",
    "invalid_source",
  );
  const updatedAt = isoTimestamp(
    input.updatedAt,
    "updatedAt",
    "invalid_source",
  );
  assertTimestampOrder(createdAt, updatedAt, "invalid_source");
  return Object.freeze({
    id: requiredText(input.id, "id", 512, "invalid_source"),
    scope: normalizeBrainScope(input.scope),
    type: enumValue<BrainSourceType>(
      input.type,
      sourceTypes,
      "type",
      "invalid_source",
      "source type",
    ),
    label: requiredText(
      input.label,
      "label",
      MAX_BRAIN_SOURCE_LABEL_CHARACTERS,
      "invalid_source",
    ),
    status,
    trust: normalizeTrust(input.trust),
    ...(currentVersion ? { currentVersion } : {}),
    ...(failure ? { failure } : {}),
    metadata: normalizeBrainMetadata(input.metadata),
    createdAt,
    updatedAt,
  });
}

export function createBrainSource(
  input: CreateBrainSourceInput,
  factory: BrainFactoryOptions = {},
): BrainSource {
  if (!input || typeof input !== "object") {
    throw new BrainContractError(
      "Brain source input must be an object",
      "invalid_source",
    );
  }
  const at = isoTimestamp(
    factory.now?.() ?? new Date(),
    "now",
    "invalid_source",
  );
  return normalizeSourceRecord({
    id: input.id ?? factory.createId?.() ?? `brain-${nanoid(16)}`,
    scope: input.scope,
    type: input.type,
    label: input.label,
    status: "pending",
    trust: input.trust,
    metadata: input.metadata ?? {},
    createdAt: at,
    updatedAt: at,
  });
}

export function normalizeBrainSource(value: unknown): BrainSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BrainContractError(
      "Brain source must be an object",
      "invalid_source",
    );
  }
  return normalizeSourceRecord(value as Record<string, unknown>);
}

function normalizeVersionRecord(
  input: Record<string, unknown>,
): BrainSourceVersion {
  const status = enumValue<BrainVersionStatus>(
    input.status,
    versionStatuses,
    "status",
    "invalid_version",
    "version status",
  );
  const failure = normalizeOptionalFailure(
    input.failure,
    "failure",
    "invalid_version",
  );
  if (status === "failed" && !failure) {
    throw new BrainContractError(
      "A failed Brain source version requires failure details",
      "invalid_version",
      "failure",
    );
  }
  const createdAt = isoTimestamp(
    input.createdAt,
    "createdAt",
    "invalid_version",
  );
  const updatedAt = isoTimestamp(
    input.updatedAt,
    "updatedAt",
    "invalid_version",
  );
  assertTimestampOrder(createdAt, updatedAt, "invalid_version");
  const indexedAt = optionalTimestamp(
    input.indexedAt,
    "indexedAt",
    "invalid_version",
  );
  if (status === "indexed" && !indexedAt) {
    throw new BrainContractError(
      "An indexed Brain source version requires indexedAt",
      "invalid_version",
      "indexedAt",
    );
  }
  const byteSize = input.byteSize === undefined
    ? undefined
    : nonNegativeInteger(
        input.byteSize,
        "byteSize",
        "invalid_version",
        Number.MAX_SAFE_INTEGER,
      );
  return Object.freeze({
    sourceId: requiredText(
      input.sourceId,
      "sourceId",
      512,
      "invalid_version",
    ),
    version: requiredText(
      input.version,
      "version",
      512,
      "invalid_version",
    ),
    status,
    ...(
      input.contentType === undefined
        ? {}
        : {
            contentType: requiredText(
              input.contentType,
              "contentType",
              256,
              "invalid_version",
            ),
          }
    ),
    ...(byteSize === undefined ? {} : { byteSize }),
    ...(
      input.contentHash === undefined
        ? {}
        : {
            contentHash: requiredText(
              input.contentHash,
              "contentHash",
              512,
              "invalid_version",
            ),
          }
    ),
    ...(failure ? { failure } : {}),
    metadata: normalizeBrainMetadata(input.metadata),
    createdAt,
    updatedAt,
    ...(indexedAt ? { indexedAt } : {}),
  });
}

export function createBrainSourceVersion(
  input: CreateBrainSourceVersionInput,
  factory: Pick<BrainFactoryOptions, "now"> = {},
): BrainSourceVersion {
  if (!input || typeof input !== "object") {
    throw new BrainContractError(
      "Brain source version input must be an object",
      "invalid_version",
    );
  }
  const status = input.status ?? "pending";
  if (status !== "pending" && status !== "indexing") {
    throw new BrainContractError(
      "New Brain source versions may only be pending or indexing",
      "invalid_version",
      "status",
    );
  }
  const at = isoTimestamp(
    factory.now?.() ?? new Date(),
    "now",
    "invalid_version",
  );
  return normalizeVersionRecord({
    ...input,
    status,
    metadata: input.metadata ?? {},
    createdAt: at,
    updatedAt: at,
  });
}

export function normalizeBrainSourceVersion(
  value: unknown,
): BrainSourceVersion {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BrainContractError(
      "Brain source version must be an object",
      "invalid_version",
    );
  }
  return normalizeVersionRecord(value as Record<string, unknown>);
}

export function normalizeBrainCitation(value: unknown): BrainCitation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BrainContractError(
      "Brain citation must be an object",
      "invalid_citation",
      "citation",
    );
  }
  const candidate = value as Record<string, unknown>;
  const uri = optionalText(candidate.uri, "citation.uri", 4_096, "invalid_citation");
  if (uri) {
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      throw new BrainContractError(
        "citation.uri must be an absolute HTTP(S) URL",
        "invalid_citation",
        "citation.uri",
      );
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new BrainContractError(
        "citation.uri must use HTTP or HTTPS",
        "invalid_citation",
        "citation.uri",
      );
    }
  }
  const capturedAt = optionalTimestamp(
    candidate.capturedAt,
    "citation.capturedAt",
    "invalid_citation",
  );
  return Object.freeze({
    sourceId: requiredText(
      candidate.sourceId,
      "citation.sourceId",
      512,
      "invalid_citation",
    ),
    version: requiredText(
      candidate.version,
      "citation.version",
      512,
      "invalid_citation",
    ),
    chunkId: requiredText(
      candidate.chunkId,
      "citation.chunkId",
      512,
      "invalid_citation",
    ),
    label: requiredText(
      candidate.label,
      "citation.label",
      MAX_BRAIN_SOURCE_LABEL_CHARACTERS,
      "invalid_citation",
    ),
    ...(uri ? { uri } : {}),
    ...(
      candidate.locator === undefined
        ? {}
        : {
            locator: requiredText(
              candidate.locator,
              "citation.locator",
              2_048,
              "invalid_citation",
            ),
          }
    ),
    ...(capturedAt ? { capturedAt } : {}),
  });
}

export function createBrainChunk(input: CreateBrainChunkInput): BrainChunk {
  if (!input || typeof input !== "object") {
    throw new BrainContractError(
      "Brain chunk input must be an object",
      "invalid_chunk",
    );
  }
  const id = requiredText(input.id, "id", 512, "invalid_chunk");
  const sourceId = requiredText(
    input.sourceId,
    "sourceId",
    512,
    "invalid_chunk",
  );
  const version = requiredText(
    input.version,
    "version",
    512,
    "invalid_chunk",
  );
  const citation = normalizeBrainCitation(input.citation);
  if (
    citation.sourceId !== sourceId
    || citation.version !== version
    || citation.chunkId !== id
  ) {
    throw new BrainContractError(
      "Brain chunk citation must reference the same chunk, source, and version",
      "invalid_chunk",
      "citation",
    );
  }
  const tokenCount = input.tokenCount === undefined
    ? undefined
    : nonNegativeInteger(
        input.tokenCount,
        "tokenCount",
        "invalid_chunk",
        1_000_000,
      );
  return Object.freeze({
    id,
    sourceId,
    version,
    index: nonNegativeInteger(input.index, "index", "invalid_chunk"),
    content: requiredText(
      input.content,
      "content",
      MAX_BRAIN_CHUNK_CONTENT_CHARACTERS,
      "invalid_chunk",
    ),
    citation,
    ...(tokenCount === undefined ? {} : { tokenCount }),
    metadata: normalizeBrainMetadata(input.metadata),
  });
}

export function normalizeBrainChunk(value: unknown): BrainChunk {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BrainContractError(
      "Brain chunk must be an object",
      "invalid_chunk",
    );
  }
  return createBrainChunk(value as unknown as CreateBrainChunkInput);
}

function normalizeScores(value: unknown): BrainRetrievalScores {
  if (value === undefined) return Object.freeze({});
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BrainContractError(
      "Brain retrieval scores must be an object",
      "invalid_retrieval_result",
      "scores",
    );
  }
  const candidate = value as Record<string, unknown>;
  const keyword = candidate.keyword === undefined
    ? undefined
    : finiteNumber(
        candidate.keyword,
        "scores.keyword",
        "invalid_retrieval_result",
      );
  const semantic = candidate.semantic === undefined
    ? undefined
    : finiteNumber(
        candidate.semantic,
        "scores.semantic",
        "invalid_retrieval_result",
      );
  const rerank = candidate.rerank === undefined
    ? undefined
    : finiteNumber(
        candidate.rerank,
        "scores.rerank",
        "invalid_retrieval_result",
      );
  return Object.freeze({
    ...(keyword === undefined ? {} : { keyword }),
    ...(semantic === undefined ? {} : { semantic }),
    ...(rerank === undefined ? {} : { rerank }),
  });
}

function normalizeRetrievalRanks(value: unknown) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BrainContractError(
      "Brain retrieval ranks must be an object",
      "invalid_retrieval_result",
      "ranks",
    );
  }
  const candidate = value as Record<string, unknown>;
  const rank = (field: "keyword" | "semantic") => {
    const raw = candidate[field];
    if (raw === undefined) return undefined;
    if (!Number.isSafeInteger(raw) || (raw as number) < 1) {
      throw new BrainContractError(
        `Brain retrieval ranks.${field} must be a positive integer`,
        "invalid_retrieval_result",
        `ranks.${field}`,
      );
    }
    return raw as number;
  };
  const keyword = rank("keyword");
  const semantic = rank("semantic");
  return Object.freeze({
    ...(keyword === undefined ? {} : { keyword }),
    ...(semantic === undefined ? {} : { semantic }),
  });
}

export function createBrainRetrievalResult(
  input: CreateBrainRetrievalResultInput,
): BrainRetrievalResult {
  if (!input || typeof input !== "object") {
    throw new BrainContractError(
      "Brain retrieval result input must be an object",
      "invalid_retrieval_result",
    );
  }
  return Object.freeze({
    scope: normalizeBrainScope(input.scope),
    chunk: normalizeBrainChunk(input.chunk),
    score: finiteNumber(
      input.score,
      "score",
      "invalid_retrieval_result",
    ),
    scores: normalizeScores(input.scores),
    ...(input.ranks === undefined
      ? {}
      : { ranks: normalizeRetrievalRanks(input.ranks) }),
    ...(input.retrievalMode === undefined
      ? {}
      : {
          retrievalMode: enumValue<"lexical" | "semantic" | "hybrid">(
            input.retrievalMode,
            new Set(["lexical", "semantic", "hybrid"]),
            "retrievalMode",
            "invalid_retrieval_result",
            "retrieval mode",
          ),
        }),
    ...(input.fallbackReason === undefined
      ? {}
      : {
          fallbackReason: requiredText(
            input.fallbackReason,
            "fallbackReason",
            512,
            "invalid_retrieval_result",
          ),
        }),
    trust: normalizeTrust(input.trust, "invalid_retrieval_result"),
  });
}

function normalizeIngestionJobRecord(
  input: Record<string, unknown>,
): BrainIngestionJob {
  const status = enumValue<BrainIngestionJobStatus>(
    input.status,
    ingestionStatuses,
    "status",
    "invalid_ingestion_job",
    "ingestion job status",
  );
  const attempt = nonNegativeInteger(
    input.attempt,
    "attempt",
    "invalid_ingestion_job",
    100,
  );
  const maxAttempts = positiveInteger(
    input.maxAttempts,
    "maxAttempts",
    "invalid_ingestion_job",
    100,
  );
  if (attempt > maxAttempts) {
    throw new BrainContractError(
      "attempt cannot exceed maxAttempts",
      "invalid_ingestion_job",
      "attempt",
    );
  }
  const claimedBy = optionalText(
    input.claimedBy,
    "claimedBy",
    512,
    "invalid_ingestion_job",
  );
  const claimToken = optionalText(
    input.claimToken,
    "claimToken",
    512,
    "invalid_ingestion_job",
  );
  const leaseExpiresAt = optionalTimestamp(
    input.leaseExpiresAt,
    "leaseExpiresAt",
    "invalid_ingestion_job",
  );
  if (status === "processing") {
    if (!claimedBy || !claimToken || !leaseExpiresAt || attempt === 0) {
      throw new BrainContractError(
        "A processing Brain ingestion job requires a worker, claim token, lease, and positive attempt",
        "invalid_ingestion_job",
        "status",
      );
    }
  } else if (claimedBy || claimToken || leaseExpiresAt) {
    throw new BrainContractError(
      "Only a processing Brain ingestion job may retain claim state",
      "invalid_ingestion_job",
      "claimToken",
    );
  }
  const failure = normalizeOptionalFailure(
    input.failure,
    "failure",
    "invalid_ingestion_job",
  );
  if (status === "failed" && !failure) {
    throw new BrainContractError(
      "A failed Brain ingestion job requires failure details",
      "invalid_ingestion_job",
      "failure",
    );
  }
  if (status !== "failed" && failure) {
    throw new BrainContractError(
      "Only a failed Brain ingestion job may retain failure details",
      "invalid_ingestion_job",
      "failure",
    );
  }
  const createdAt = isoTimestamp(
    input.createdAt,
    "createdAt",
    "invalid_ingestion_job",
  );
  const updatedAt = isoTimestamp(
    input.updatedAt,
    "updatedAt",
    "invalid_ingestion_job",
  );
  assertTimestampOrder(createdAt, updatedAt, "invalid_ingestion_job");
  const availableAt = isoTimestamp(
    input.availableAt,
    "availableAt",
    "invalid_ingestion_job",
  );
  if (leaseExpiresAt && Date.parse(leaseExpiresAt) <= Date.parse(updatedAt)) {
    throw new BrainContractError(
      "leaseExpiresAt must follow updatedAt",
      "invalid_ingestion_job",
      "leaseExpiresAt",
    );
  }
  const completedAt = optionalTimestamp(
    input.completedAt,
    "completedAt",
    "invalid_ingestion_job",
  );
  if (status === "completed" && !completedAt) {
    throw new BrainContractError(
      "A completed Brain ingestion job requires completedAt",
      "invalid_ingestion_job",
      "completedAt",
    );
  }
  if (status !== "completed" && completedAt) {
    throw new BrainContractError(
      "Only a completed Brain ingestion job may have completedAt",
      "invalid_ingestion_job",
      "completedAt",
    );
  }
  return Object.freeze({
    id: requiredText(input.id, "id", 512, "invalid_ingestion_job"),
    scope: normalizeBrainScope(input.scope),
    sourceId: requiredText(
      input.sourceId,
      "sourceId",
      512,
      "invalid_ingestion_job",
    ),
    version: requiredText(
      input.version,
      "version",
      512,
      "invalid_ingestion_job",
    ),
    operation: enumValue<BrainIngestionOperation>(
      input.operation,
      ingestionOperations,
      "operation",
      "invalid_ingestion_job",
      "ingestion operation",
    ),
    dedupeKey: requiredText(
      input.dedupeKey,
      "dedupeKey",
      1_024,
      "invalid_ingestion_job",
    ),
    status,
    attempt,
    maxAttempts,
    availableAt,
    ...(claimedBy ? { claimedBy } : {}),
    ...(claimToken ? { claimToken } : {}),
    ...(leaseExpiresAt ? { leaseExpiresAt } : {}),
    ...(failure ? { failure } : {}),
    createdAt,
    updatedAt,
    ...(completedAt ? { completedAt } : {}),
  });
}

export function createBrainIngestionJob(
  input: CreateBrainIngestionJobInput,
  factory: BrainFactoryOptions = {},
): BrainIngestionJob {
  if (!input || typeof input !== "object") {
    throw new BrainContractError(
      "Brain ingestion job input must be an object",
      "invalid_ingestion_job",
    );
  }
  const at = isoTimestamp(
    factory.now?.() ?? input.updatedAt ?? input.createdAt ?? new Date(),
    "now",
    "invalid_ingestion_job",
  );
  return normalizeIngestionJobRecord({
    ...input,
    id: input.id ?? factory.createId?.() ?? `brain-job-${nanoid(16)}`,
    status: input.status ?? "pending",
    attempt: input.attempt ?? 0,
    maxAttempts: input.maxAttempts ?? 3,
    availableAt: input.availableAt ?? at,
    createdAt: input.createdAt ?? at,
    updatedAt: input.updatedAt ?? at,
  });
}

export function normalizeBrainIngestionJob(
  value: unknown,
): BrainIngestionJob {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BrainContractError(
      "Brain ingestion job must be an object",
      "invalid_ingestion_job",
    );
  }
  return normalizeIngestionJobRecord(value as Record<string, unknown>);
}

export function normalizeBrainAccessDecision(
  value: unknown,
): BrainAccessDecision {
  const fallback = Object.freeze({
    allowed: false,
    reason: "invalid_policy_decision",
  });
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fallback;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.allowed !== "boolean") return fallback;
  let reason: string;
  try {
    reason = requiredText(
      candidate.reason,
      "reason",
      512,
      "invalid_access_decision",
    );
  } catch {
    return fallback;
  }
  let matchedScope;
  if (candidate.matchedScope !== undefined) {
    try {
      matchedScope = normalizeBrainScope(candidate.matchedScope);
    } catch {
      return fallback;
    }
  }
  return Object.freeze({
    allowed: candidate.allowed,
    reason,
    ...(matchedScope ? { matchedScope } : {}),
  });
}
