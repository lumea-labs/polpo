import { nanoid } from "nanoid";
import {
  createBrainIngestionJob,
  createBrainRetrievalResult,
  normalizeBrainChunk,
  normalizeBrainIngestionJob,
  normalizeBrainSource,
  normalizeBrainSourceVersion,
} from "./contracts.js";
import {
  assertBrainIngestionJobStatusTransition,
  assertBrainSourceStatusTransition,
  assertBrainVersionStatusTransition,
  isBrainSourceRetrievable,
} from "./lifecycle.js";
import { brainScopeKey, normalizeBrainScope } from "./scope.js";
import {
  BrainStoreConflictError,
  BrainStoreValidationError,
} from "./store-errors.js";
import type { BrainEmbeddingProvider } from "./ports.js";
import type {
  BrainChunkStore,
  BrainIngestionJobStore,
  BrainSourceStore,
  BrainVersionStore,
} from "./stores.js";
import type {
  BrainCandidateSearchQuery,
  BrainChunk,
  BrainEnqueueResult,
  BrainIngestionJob,
  BrainJobClaimInput,
  BrainJobFailureInput,
  BrainJobMutationInput,
  BrainPublishVersionInput,
  BrainReplaceVersionChunksInput,
  BrainRetrievalResult,
  BrainScope,
  BrainSource,
  BrainSourceListQuery,
  BrainSourceListResult,
  BrainSourceRef,
  BrainSourceVersion,
  BrainStoreSnapshot,
  BrainVersionRef,
} from "./types.js";

interface StoredVector {
  readonly values: readonly number[];
  readonly model: string;
}

export interface InMemoryBrainStoreOptions {
  readonly snapshot?: BrainStoreSnapshot;
  readonly now?: () => Date | string;
  readonly createId?: () => string;
  readonly embeddingProvider?: BrainEmbeddingProvider;
  readonly embeddingFailureMode?: "fallback" | "strict";
}

function timestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new BrainStoreValidationError("Store time must be a valid timestamp");
  }
  return date.toISOString();
}

function text(value: unknown, path: string, max = 1_024): string {
  if (typeof value !== "string") {
    throw new BrainStoreValidationError(`${path} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    throw new BrainStoreValidationError(
      `${path} must contain between 1 and ${max} characters`,
    );
  }
  return normalized;
}

function scopeKey(scope: BrainScope): string {
  return brainScopeKey(normalizeBrainScope(scope));
}

function sourceKey(scope: BrainScope, sourceId: string): string {
  return JSON.stringify([scopeKey(scope), text(sourceId, "sourceId", 512)]);
}

function versionKey(ref: BrainVersionRef): string {
  return JSON.stringify([
    sourceKey(ref.scope, ref.sourceId),
    text(ref.version, "version", 512),
  ]);
}

function sourceKeyFromVersionKey(key: string): string {
  const parsed = JSON.parse(key) as unknown;
  if (
    !Array.isArray(parsed)
    || parsed.length !== 2
    || typeof parsed[0] !== "string"
  ) {
    throw new BrainStoreValidationError("Malformed Brain version key");
  }
  return parsed[0];
}

function scopeFromSourceKey(key: string): BrainScope {
  const parsed = JSON.parse(key) as unknown;
  if (
    !Array.isArray(parsed)
    || parsed.length !== 2
    || typeof parsed[0] !== "string"
  ) {
    throw new BrainStoreValidationError("Malformed Brain source key");
  }
  const parsedScope = JSON.parse(parsed[0]) as unknown;
  if (
    !Array.isArray(parsedScope)
    || parsedScope.length !== 2
    || typeof parsedScope[0] !== "string"
    || typeof parsedScope[1] !== "string"
  ) {
    throw new BrainStoreValidationError("Malformed Brain scope key");
  }
  return normalizeBrainScope({
    kind: parsedScope[0],
    subjectId: parsedScope[1],
  });
}

function scopeFromVersionKey(key: string): BrainScope {
  return scopeFromSourceKey(sourceKeyFromVersionKey(key));
}

function jobKey(scope: BrainScope, jobId: string): string {
  return JSON.stringify([scopeKey(scope), text(jobId, "jobId", 512)]);
}

function dedupeKey(job: BrainIngestionJob): string {
  return JSON.stringify([scopeKey(job.scope), job.dedupeKey]);
}

function cloneSource(value: BrainSource): BrainSource {
  return normalizeBrainSource(JSON.parse(JSON.stringify(value)));
}

function cloneVersion(value: BrainSourceVersion): BrainSourceVersion {
  return normalizeBrainSourceVersion(JSON.parse(JSON.stringify(value)));
}

function cloneChunk(value: BrainChunk): BrainChunk {
  return normalizeBrainChunk(JSON.parse(JSON.stringify(value)));
}

function cloneJob(value: BrainIngestionJob): BrainIngestionJob {
  return normalizeBrainIngestionJob(JSON.parse(JSON.stringify(value)));
}

function normalizeLimit(value: number | undefined, fallback = 100): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new BrainStoreValidationError(
      "limit must be an integer between 1 and 1000",
    );
  }
  return value;
}

function normalizeScopes(scopes: readonly BrainScope[]): BrainScope[] {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new BrainStoreValidationError(
      "At least one explicit Brain scope is required",
    );
  }
  const unique = new Map<string, BrainScope>();
  for (const scope of scopes) {
    const normalized = normalizeBrainScope(scope);
    unique.set(scopeKey(normalized), normalized);
  }
  return [...unique.values()];
}

function normalizeSourceRefs(
  refs: readonly BrainSourceRef[],
): BrainSourceRef[] {
  if (!Array.isArray(refs)) {
    throw new BrainStoreValidationError("sources must be an array");
  }
  const unique = new Map<string, BrainSourceRef>();
  for (const ref of refs) {
    let scope: BrainScope;
    try {
      scope = normalizeBrainScope(ref.scope);
    } catch (error) {
      throw new BrainStoreValidationError(
        `sources[].scope is invalid: ${
          error instanceof Error ? error.message : "validation failed"
        }`,
      );
    }
    const sourceId = text(ref.sourceId, "sources[].sourceId", 512);
    unique.set(sourceKey(scope, sourceId), Object.freeze({ scope, sourceId }));
  }
  return [...unique.values()];
}

function terms(value: string): string[] {
  return [...new Set(
    value
      .normalize("NFKC")
      .toLocaleLowerCase("en-US")
      .match(/[\p{L}\p{N}_-]+/gu) ?? [],
  )];
}

function lexicalScore(content: string, queryTerms: readonly string[]): number {
  if (queryTerms.length === 0) return 0;
  const contentTerms = terms(content);
  if (contentTerms.length === 0) return 0;
  const frequencies = new Map<string, number>();
  for (const term of contentTerms) {
    frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
  }
  let matched = 0;
  let frequency = 0;
  for (const term of queryTerms) {
    const count = frequencies.get(term) ?? 0;
    if (count > 0) matched += 1;
    frequency += Math.min(count, 4);
  }
  if (matched === 0) return 0;
  return matched / queryTerms.length + frequency / (queryTerms.length * 20);
}

function cosine(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const l = left[index];
    const r = right[index];
    if (!Number.isFinite(l) || !Number.isFinite(r)) return 0;
    dot += l * r;
    leftMagnitude += l * l;
    rightMagnitude += r * r;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  const score = dot / Math.sqrt(leftMagnitude * rightMagnitude);
  return Number.isFinite(score) ? score : 0;
}

function validateVectors(
  vectors: readonly (readonly number[])[],
  expectedCount: number,
  expectedDimensions: number,
): boolean {
  return (
    vectors.length === expectedCount
    && expectedDimensions > 0
    && vectors.every((vector) => (
      vector.length === expectedDimensions
      && vector.every(Number.isFinite)
    ))
  );
}

export class InMemoryBrainStore implements
  BrainSourceStore,
  BrainVersionStore,
  BrainChunkStore,
  BrainIngestionJobStore {
  private readonly sources = new Map<string, BrainSource>();
  private readonly versions = new Map<string, BrainSourceVersion>();
  private readonly chunks = new Map<string, readonly BrainChunk[]>();
  private readonly jobs = new Map<string, BrainIngestionJob>();
  private readonly jobsByDedupe = new Map<string, string>();
  private readonly vectors = new Map<string, StoredVector>();
  private readonly now: () => Date | string;
  private readonly createId: () => string;
  private readonly embeddingProvider?: BrainEmbeddingProvider;
  private readonly embeddingFailureMode: "fallback" | "strict";

  constructor(options: InMemoryBrainStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? (() => nanoid(16));
    this.embeddingProvider = options.embeddingProvider;
    this.embeddingFailureMode = options.embeddingFailureMode ?? "fallback";
    if (options.snapshot) this.restore(options.snapshot);
  }

  private at(): string {
    return timestamp(this.now());
  }

  private source(ref: BrainSourceRef): BrainSource | undefined {
    return this.sources.get(sourceKey(ref.scope, ref.sourceId));
  }

  private version(ref: BrainVersionRef): BrainSourceVersion | undefined {
    return this.versions.get(versionKey(ref));
  }

  async createSource(value: BrainSource): Promise<BrainSource> {
    const source = cloneSource(value);
    const key = sourceKey(source.scope, source.id);
    if (this.sources.has(key)) {
      throw new BrainStoreConflictError(
        `Brain source "${source.id}" already exists in this scope`,
      );
    }
    this.sources.set(key, source);
    return cloneSource(source);
  }

  async getSource(ref: BrainSourceRef): Promise<BrainSource | null> {
    const source = this.source(ref);
    return source ? cloneSource(source) : null;
  }

  async listSources(query: BrainSourceListQuery): Promise<BrainSourceListResult> {
    const scopes = normalizeScopes(query.scopes);
    const allowedScopes = new Set(scopes.map(scopeKey));
    const limit = normalizeLimit(query.limit);
    const offset = query.cursor === undefined
      ? 0
      : Number.parseInt(query.cursor, 10);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new BrainStoreValidationError("cursor must be a valid offset");
    }
    const statuses = query.statuses
      ? new Set(query.statuses)
      : undefined;
    const types = query.types ? new Set(query.types) : undefined;
    const matches = [...this.sources.values()]
      .filter((source) => allowedScopes.has(scopeKey(source.scope)))
      .filter((source) => !statuses || statuses.has(source.status))
      .filter((source) => !types || types.has(source.type))
      .sort((left, right) => (
        left.createdAt.localeCompare(right.createdAt)
        || left.id.localeCompare(right.id)
      ));
    const selected = matches.slice(offset, offset + limit).map(cloneSource);
    const cursor = offset + selected.length < matches.length
      ? String(offset + selected.length)
      : undefined;
    return Object.freeze({
      sources: Object.freeze(selected),
      ...(cursor ? { cursor } : {}),
    });
  }

  async updateSource(
    value: BrainSource,
    options: { readonly expectedUpdatedAt?: string } = {},
  ): Promise<BrainSource> {
    const candidate = cloneSource(value);
    const key = sourceKey(candidate.scope, candidate.id);
    const current = this.sources.get(key);
    if (!current) {
      throw new BrainStoreConflictError(
        `Brain source "${candidate.id}" does not exist in this scope`,
      );
    }
    if (
      options.expectedUpdatedAt !== undefined
      && current.updatedAt !== options.expectedUpdatedAt
    ) {
      throw new BrainStoreConflictError(
        `Brain source "${candidate.id}" changed during update`,
      );
    }
    assertBrainSourceStatusTransition(current.status, candidate.status);
    this.sources.set(key, candidate);
    return cloneSource(candidate);
  }

  async publishVersion(
    input: BrainPublishVersionInput,
  ): Promise<BrainSource> {
    const source = this.source(input);
    const version = this.version(input);
    const chunks = this.chunks.get(versionKey(input)) ?? [];
    if (!source || !version) {
      throw new BrainStoreConflictError(
        "Brain source and source version must exist before publish",
      );
    }
    if (version.status !== "indexing") {
      throw new BrainStoreConflictError(
        "Only an indexing Brain source version can be published",
      );
    }
    if (chunks.length === 0) {
      throw new BrainStoreValidationError(
        "A Brain source version cannot be published without chunks",
      );
    }
    if (Object.hasOwn(input, "expectedCurrentVersion")) {
      const expected = input.expectedCurrentVersion ?? undefined;
      if (source.currentVersion !== expected) {
        throw new BrainStoreConflictError(
          "Brain source current version changed before publish",
        );
      }
    }
    const at = this.at();
    const indexed = normalizeBrainSourceVersion({
      ...version,
      status: "indexed",
      indexedAt: at,
      updatedAt: at,
      failure: undefined,
    });
    const published = normalizeBrainSource({
      ...source,
      status: "indexed",
      currentVersion: version.version,
      failure: undefined,
      updatedAt: at,
    });
    let priorVersion: BrainSourceVersion | undefined;
    if (source.currentVersion && source.currentVersion !== version.version) {
      const priorKey = versionKey({ ...input, version: source.currentVersion });
      const prior = this.versions.get(priorKey);
      if (prior?.status === "indexed") {
        priorVersion = normalizeBrainSourceVersion({
          ...prior,
          status: "superseded",
          updatedAt: at,
        });
      }
    }

    // All candidates are validated above; these synchronous writes form one
    // observable publish boundary for the in-memory reference adapter.
    this.versions.set(versionKey(input), indexed);
    if (priorVersion) {
      this.versions.set(versionKey({
        ...input,
        version: priorVersion.version,
      }), priorVersion);
    }
    this.sources.set(sourceKey(input.scope, input.sourceId), published);
    return cloneSource(published);
  }

  async deleteSource(ref: BrainSourceRef): Promise<void> {
    const source = this.source(ref);
    if (!source || source.status === "deleted") return;
    const deleted = normalizeBrainSource({
      ...source,
      status: "deleted",
      updatedAt: this.at(),
    });
    this.sources.set(sourceKey(ref.scope, ref.sourceId), deleted);
    await this.deleteSourceChunks(ref);
  }

  async createVersion(
    scope: BrainScope,
    value: BrainSourceVersion,
  ): Promise<BrainSourceVersion> {
    const normalizedScope = normalizeBrainScope(scope);
    const version = cloneVersion(value);
    if (!this.source({ scope: normalizedScope, sourceId: version.sourceId })) {
      throw new BrainStoreConflictError(
        `Brain source "${version.sourceId}" does not exist in this scope`,
      );
    }
    const key = versionKey({
      scope: normalizedScope,
      sourceId: version.sourceId,
      version: version.version,
    });
    if (this.versions.has(key)) {
      throw new BrainStoreConflictError(
        `Brain source version "${version.version}" already exists`,
      );
    }
    this.versions.set(key, version);
    return cloneVersion(version);
  }

  async getVersion(ref: BrainVersionRef): Promise<BrainSourceVersion | null> {
    const version = this.version(ref);
    return version ? cloneVersion(version) : null;
  }

  async listVersions(ref: BrainSourceRef): Promise<readonly BrainSourceVersion[]> {
    const prefix = sourceKey(ref.scope, ref.sourceId);
    return Object.freeze(
      [...this.versions.entries()]
        .filter(([key]) => sourceKeyFromVersionKey(key) === prefix)
        .map(([, version]) => cloneVersion(version))
        .sort((left, right) => (
          left.createdAt.localeCompare(right.createdAt)
          || left.version.localeCompare(right.version)
        )),
    );
  }

  async updateVersion(
    scope: BrainScope,
    value: BrainSourceVersion,
    options: { readonly expectedUpdatedAt?: string } = {},
  ): Promise<BrainSourceVersion> {
    const candidate = cloneVersion(value);
    const ref = {
      scope: normalizeBrainScope(scope),
      sourceId: candidate.sourceId,
      version: candidate.version,
    };
    const key = versionKey(ref);
    const current = this.versions.get(key);
    if (!current) {
      throw new BrainStoreConflictError(
        `Brain source version "${candidate.version}" does not exist`,
      );
    }
    if (
      options.expectedUpdatedAt !== undefined
      && current.updatedAt !== options.expectedUpdatedAt
    ) {
      throw new BrainStoreConflictError(
        `Brain source version "${candidate.version}" changed during update`,
      );
    }
    assertBrainVersionStatusTransition(current.status, candidate.status);
    this.versions.set(key, candidate);
    return cloneVersion(candidate);
  }

  async deleteVersion(ref: BrainVersionRef): Promise<void> {
    const current = this.version(ref);
    if (!current || current.status === "deleted") return;
    this.versions.set(versionKey(ref), normalizeBrainSourceVersion({
      ...current,
      status: "deleted",
      updatedAt: this.at(),
    }));
    await this.deleteVersionChunks(ref);
  }

  async replaceVersionChunks(
    input: BrainReplaceVersionChunksInput,
  ): Promise<void> {
    const version = this.version(input);
    if (!version) {
      throw new BrainStoreConflictError(
        "Brain source version does not exist",
      );
    }
    if (version.status !== "pending" && version.status !== "indexing") {
      throw new BrainStoreConflictError(
        "Chunks may only be replaced for an unpublished version",
      );
    }
    let chunks: BrainChunk[];
    try {
      chunks = input.chunks.map(cloneChunk);
    } catch (error) {
      throw new BrainStoreValidationError(
        `Replacement chunks are invalid: ${
          error instanceof Error ? error.message : "validation failed"
        }`,
      );
    }
    const ids = new Set<string>();
    const indexes = new Set<number>();
    for (const chunk of chunks) {
      if (
        chunk.sourceId !== input.sourceId
        || chunk.version !== input.version
      ) {
        throw new BrainStoreValidationError(
          "Every replacement chunk must match the source and version",
        );
      }
      if (ids.has(chunk.id) || indexes.has(chunk.index)) {
        throw new BrainStoreValidationError(
          "Replacement chunks must have unique ids and indexes",
        );
      }
      ids.add(chunk.id);
      indexes.add(chunk.index);
    }
    if (chunks.some((chunk, index) => chunk.index !== index)) {
      throw new BrainStoreValidationError(
        "Replacement chunk indexes must be contiguous and ordered",
      );
    }

    let embedded: readonly (readonly number[])[] | undefined;
    let model: string | undefined;
    if (this.embeddingProvider && chunks.length > 0) {
      try {
        const result = await this.embeddingProvider.embed({
          texts: chunks.map((chunk) => chunk.content),
        });
        if (
          !validateVectors(result.vectors, chunks.length, result.dimensions)
        ) {
          throw new BrainStoreValidationError(
            "Embedding provider returned malformed vectors",
          );
        }
        embedded = result.vectors;
        model = result.model;
      } catch (error) {
        if (this.embeddingFailureMode === "strict") throw error;
      }
    }

    const key = versionKey(input);
    this.chunks.set(key, Object.freeze(chunks));
    for (const [storedKey] of this.vectors) {
      if (storedKey.startsWith(`${key}:`)) this.vectors.delete(storedKey);
    }
    if (embedded && model) {
      chunks.forEach((chunk, index) => {
        this.vectors.set(`${key}:${chunk.id}`, {
          values: Object.freeze([...embedded![index]]),
          model: model!,
        });
      });
    }
  }

  async listVersionChunks(ref: BrainVersionRef): Promise<readonly BrainChunk[]> {
    return Object.freeze(
      (this.chunks.get(versionKey(ref)) ?? []).map(cloneChunk),
    );
  }

  async searchCandidates(
    query: BrainCandidateSearchQuery,
  ): Promise<readonly BrainRetrievalResult[]> {
    const sources = normalizeSourceRefs(query.sources);
    if (sources.length === 0) {
      return Object.freeze([]);
    }
    const queryText = text(query.query, "query", 16_000);
    const limit = normalizeLimit(query.limit, 10);
    const queryTerms = terms(queryText);

    let queryVector: readonly number[] | undefined;
    if (this.embeddingProvider) {
      try {
        const result = await this.embeddingProvider.embed({
          texts: [queryText],
        });
        if (!validateVectors(result.vectors, 1, result.dimensions)) {
          throw new BrainStoreValidationError(
            "Embedding provider returned a malformed query vector",
          );
        }
        queryVector = result.vectors[0];
      } catch (error) {
        if (this.embeddingFailureMode === "strict") throw error;
      }
    }

    const results: BrainRetrievalResult[] = [];
    for (const { scope, sourceId } of sources) {
      const source = this.source({ scope, sourceId });
      if (!source || !isBrainSourceRetrievable(source)) continue;
      const currentVersion = source.currentVersion!;
      const ref = { scope, sourceId, version: currentVersion };
      const chunks = this.chunks.get(versionKey(ref)) ?? [];
      for (const chunk of chunks) {
        const keyword = lexicalScore(chunk.content, queryTerms);
        const stored = this.vectors.get(`${versionKey(ref)}:${chunk.id}`);
        const semantic = queryVector && stored
          ? cosine(queryVector, stored.values)
          : 0;
        if (keyword <= 0 && semantic <= 0) continue;
        const score = keyword + Math.max(0, semantic);
        results.push(createBrainRetrievalResult({
          scope,
          chunk,
          score,
          scores: {
            ...(keyword > 0 ? { keyword } : {}),
            ...(semantic > 0 ? { semantic } : {}),
          },
          trust: source.trust,
        }));
      }
    }
    return Object.freeze(
      results
        .sort((left, right) => (
          right.score - left.score
          || left.chunk.sourceId.localeCompare(right.chunk.sourceId)
          || left.chunk.index - right.chunk.index
          || left.chunk.id.localeCompare(right.chunk.id)
        ))
        .slice(0, limit),
    );
  }

  async deleteVersionChunks(ref: BrainVersionRef): Promise<void> {
    const key = versionKey(ref);
    this.chunks.delete(key);
    for (const [storedKey] of this.vectors) {
      if (storedKey.startsWith(`${key}:`)) this.vectors.delete(storedKey);
    }
  }

  async deleteSourceChunks(ref: BrainSourceRef): Promise<void> {
    const prefix = sourceKey(ref.scope, ref.sourceId);
    for (const key of [...this.chunks.keys()]) {
      if (sourceKeyFromVersionKey(key) === prefix) {
        this.chunks.delete(key);
        for (const [storedKey] of this.vectors) {
          if (storedKey.startsWith(`${key}:`)) this.vectors.delete(storedKey);
        }
      }
    }
  }

  async enqueueJob(value: BrainIngestionJob): Promise<BrainEnqueueResult> {
    const job = cloneJob(value);
    const existingId = this.jobsByDedupe.get(dedupeKey(job));
    if (existingId) {
      const existing = this.jobs.get(jobKey(job.scope, existingId));
      if (existing) {
        return Object.freeze({ job: cloneJob(existing), created: false });
      }
    }
    const key = jobKey(job.scope, job.id);
    if (this.jobs.has(key)) {
      throw new BrainStoreConflictError(
        `Brain ingestion job "${job.id}" already exists in this scope`,
      );
    }
    this.jobs.set(key, job);
    this.jobsByDedupe.set(dedupeKey(job), job.id);
    return Object.freeze({ job: cloneJob(job), created: true });
  }

  async getJob(ref: {
    readonly scope: BrainScope;
    readonly jobId: string;
  }): Promise<BrainIngestionJob | null> {
    const job = this.jobs.get(jobKey(ref.scope, ref.jobId));
    return job ? cloneJob(job) : null;
  }

  async claimNextJob(
    input: BrainJobClaimInput,
  ): Promise<BrainIngestionJob | null> {
    const scope = normalizeBrainScope(input.scope);
    const workerId = text(input.workerId, "workerId", 512);
    const now = timestamp(input.now);
    if (
      !Number.isSafeInteger(input.leaseMs)
      || input.leaseMs < 1
      || input.leaseMs > 86_400_000
    ) {
      throw new BrainStoreValidationError(
        "leaseMs must be an integer between 1 and 86400000",
      );
    }
    for (const [key, job] of this.jobs) {
      if (
        scopeKey(job.scope) === scopeKey(scope)
        && job.status === "processing"
        && job.leaseExpiresAt
        && job.leaseExpiresAt <= now
        && job.attempt >= job.maxAttempts
      ) {
        this.jobs.set(key, createBrainIngestionJob({
          ...job,
          status: "failed",
          claimedBy: undefined,
          claimToken: undefined,
          leaseExpiresAt: undefined,
          failure: {
            code: "lease_exhausted",
            message: "Ingestion lease expired after the final attempt",
            retryable: false,
          },
          updatedAt: now,
        }));
      }
    }
    const matching = [...this.jobs.values()]
      .filter((job) => scopeKey(job.scope) === scopeKey(scope))
      .filter((job) => (
        (job.status === "pending" && job.availableAt <= now)
        || (
          job.status === "processing"
          && Boolean(job.leaseExpiresAt && job.leaseExpiresAt <= now)
          && job.attempt < job.maxAttempts
        )
      ))
      .sort((left, right) => (
        left.availableAt.localeCompare(right.availableAt)
        || left.createdAt.localeCompare(right.createdAt)
        || left.id.localeCompare(right.id)
      ));
    const current = matching[0];
    if (!current) return null;
    assertBrainIngestionJobStatusTransition(current.status, "processing");
    const claimed = createBrainIngestionJob({
      ...current,
      status: "processing",
      attempt: current.attempt + 1,
      claimedBy: workerId,
      claimToken: this.createId(),
      leaseExpiresAt: new Date(
        Date.parse(now) + input.leaseMs,
      ).toISOString(),
      failure: undefined,
      updatedAt: now,
    });
    this.jobs.set(jobKey(scope, claimed.id), claimed);
    return cloneJob(claimed);
  }

  private claimedJob(input: BrainJobMutationInput): BrainIngestionJob {
    const current = this.jobs.get(jobKey(input.scope, input.jobId));
    if (
      !current
      || current.status !== "processing"
      || current.claimToken !== input.claimToken
    ) {
      throw new BrainStoreConflictError(
        "Brain ingestion job claim is missing, stale, or already completed",
      );
    }
    return current;
  }

  async completeJob(input: BrainJobMutationInput): Promise<BrainIngestionJob> {
    const current = this.claimedJob(input);
    const now = timestamp(input.now);
    assertBrainIngestionJobStatusTransition(current.status, "completed");
    const completed = createBrainIngestionJob({
      ...current,
      status: "completed",
      claimedBy: undefined,
      claimToken: undefined,
      leaseExpiresAt: undefined,
      failure: undefined,
      updatedAt: now,
      completedAt: now,
    });
    this.jobs.set(jobKey(input.scope, input.jobId), completed);
    return cloneJob(completed);
  }

  async failJob(input: BrainJobFailureInput): Promise<BrainIngestionJob> {
    const current = this.claimedJob(input);
    const now = timestamp(input.now);
    const retry = (
      input.failure.retryable
      && current.attempt < current.maxAttempts
      && input.retryAt !== undefined
    );
    const nextStatus = retry ? "pending" : "failed";
    assertBrainIngestionJobStatusTransition(current.status, nextStatus);
    const failed = createBrainIngestionJob({
      ...current,
      status: nextStatus,
      claimedBy: undefined,
      claimToken: undefined,
      leaseExpiresAt: undefined,
      ...(retry
        ? {
            availableAt: timestamp(input.retryAt!),
            failure: undefined,
          }
        : { failure: input.failure }),
      updatedAt: now,
      completedAt: undefined,
    });
    this.jobs.set(jobKey(input.scope, input.jobId), failed);
    return cloneJob(failed);
  }

  async cancelJob(input: BrainJobMutationInput): Promise<BrainIngestionJob> {
    const current = this.claimedJob(input);
    const now = timestamp(input.now);
    assertBrainIngestionJobStatusTransition(current.status, "cancelled");
    const cancelled = createBrainIngestionJob({
      ...current,
      status: "cancelled",
      claimedBy: undefined,
      claimToken: undefined,
      leaseExpiresAt: undefined,
      failure: undefined,
      updatedAt: now,
      completedAt: undefined,
    });
    this.jobs.set(jobKey(input.scope, input.jobId), cancelled);
    return cloneJob(cancelled);
  }

  snapshot(): BrainStoreSnapshot {
    const sources = [...this.sources.values()]
      .map(cloneSource)
      .sort((left, right) => (
        scopeKey(left.scope).localeCompare(scopeKey(right.scope))
        || left.id.localeCompare(right.id)
      ));
    const sourceVersions = [...this.versions.entries()]
      .map(([key, value]) => Object.freeze({
        scope: scopeFromVersionKey(key),
        value: cloneVersion(value),
      }))
      .sort((left, right) => (
        scopeKey(left.scope).localeCompare(scopeKey(right.scope))
        || left.value.sourceId.localeCompare(right.value.sourceId)
        || left.value.version.localeCompare(right.value.version)
      ));
    const chunks = [...this.chunks.entries()].flatMap(([key, values]) => {
      const scope = scopeFromVersionKey(key);
      return values.map((value) => Object.freeze({
        scope,
        value: cloneChunk(value),
      }));
    });
    const jobs = [...this.jobs.values()].map(cloneJob);
    return Object.freeze({
      version: 1,
      sources: Object.freeze(sources),
      sourceVersions: Object.freeze(sourceVersions),
      chunks: Object.freeze(chunks),
      jobs: Object.freeze(jobs),
    });
  }

  private restore(snapshot: BrainStoreSnapshot): void {
    if (
      !snapshot
      || typeof snapshot !== "object"
      || snapshot.version !== 1
      || !Array.isArray(snapshot.sources)
      || !Array.isArray(snapshot.sourceVersions)
      || !Array.isArray(snapshot.chunks)
      || !Array.isArray(snapshot.jobs)
    ) {
      throw new BrainStoreValidationError(
        "Unsupported or malformed Brain store snapshot",
      );
    }
    for (const value of snapshot.sources) {
      const source = cloneSource(value);
      const key = sourceKey(source.scope, source.id);
      if (this.sources.has(key)) {
        throw new BrainStoreValidationError("Snapshot contains duplicate sources");
      }
      this.sources.set(key, source);
    }
    for (const entry of snapshot.sourceVersions) {
      const scope = normalizeBrainScope(entry.scope);
      const value = cloneVersion(entry.value);
      if (!this.source({ scope, sourceId: value.sourceId })) {
        throw new BrainStoreValidationError(
          "Snapshot source version has no matching source",
        );
      }
      const key = versionKey({
        scope,
        sourceId: value.sourceId,
        version: value.version,
      });
      if (this.versions.has(key)) {
        throw new BrainStoreValidationError(
          "Snapshot contains duplicate source versions",
        );
      }
      this.versions.set(key, value);
    }
    for (const entry of snapshot.chunks) {
      const scope = normalizeBrainScope(entry.scope);
      const value = cloneChunk(entry.value);
      const ref = {
        scope,
        sourceId: value.sourceId,
        version: value.version,
      };
      if (!this.version(ref)) {
        throw new BrainStoreValidationError(
          "Snapshot chunk has no matching source version",
        );
      }
      const key = versionKey(ref);
      const current = [...(this.chunks.get(key) ?? []), value]
        .sort((left, right) => left.index - right.index);
      this.chunks.set(key, Object.freeze(current));
    }
    for (const values of this.chunks.values()) {
      const ids = new Set<string>();
      for (const [index, chunk] of values.entries()) {
        if (chunk.index !== index || ids.has(chunk.id)) {
          throw new BrainStoreValidationError(
            "Snapshot contains duplicate or non-contiguous Brain chunks",
          );
        }
        ids.add(chunk.id);
      }
    }
    for (const source of this.sources.values()) {
      if (!source.currentVersion) continue;
      const ref = {
        scope: source.scope,
        sourceId: source.id,
        version: source.currentVersion,
      };
      const version = this.version(ref);
      if (
        !version
        || version.status !== "indexed"
        || (this.chunks.get(versionKey(ref))?.length ?? 0) === 0
      ) {
        throw new BrainStoreValidationError(
          "Snapshot current Brain version is missing indexed chunks",
        );
      }
    }
    for (const value of snapshot.jobs) {
      const job = cloneJob(value);
      const key = jobKey(job.scope, job.id);
      if (this.jobs.has(key) || this.jobsByDedupe.has(dedupeKey(job))) {
        throw new BrainStoreValidationError(
          "Snapshot contains duplicate ingestion jobs",
        );
      }
      this.jobs.set(key, job);
      this.jobsByDedupe.set(dedupeKey(job), job.id);
    }
  }
}
