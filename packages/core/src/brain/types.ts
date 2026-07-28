export const BRAIN_SCOPE_KINDS = ["org", "project"] as const;
export type BrainScopeKind = (typeof BRAIN_SCOPE_KINDS)[number];

export interface BrainScope {
  readonly kind: BrainScopeKind;
  readonly subjectId: string;
}

export interface BrainScopeAccess {
  readonly orgId?: string;
  readonly projectId?: string;
}

export const BRAIN_SOURCE_TYPES = [
  "paste",
  "url",
  "file",
  "connection",
] as const;
export type BrainSourceType = (typeof BRAIN_SOURCE_TYPES)[number];

export const BRAIN_SOURCE_STATUSES = [
  "pending",
  "indexing",
  "indexed",
  "failed",
  "deleted",
] as const;
export type BrainSourceStatus = (typeof BRAIN_SOURCE_STATUSES)[number];

export const BRAIN_TRUST_LEVELS = [
  "trusted",
  "user_provided",
  "external",
  "untrusted",
] as const;
export type BrainTrustLevel = (typeof BRAIN_TRUST_LEVELS)[number];

export const BRAIN_VERSION_STATUSES = [
  "pending",
  "indexing",
  "indexed",
  "superseded",
  "failed",
  "deleted",
] as const;
export type BrainVersionStatus = (typeof BRAIN_VERSION_STATUSES)[number];

export const BRAIN_INGESTION_JOB_STATUSES = [
  "pending",
  "processing",
  "completed",
  "failed",
  "cancelled",
] as const;
export type BrainIngestionJobStatus =
  (typeof BRAIN_INGESTION_JOB_STATUSES)[number];

export const BRAIN_INGESTION_OPERATIONS = ["ingest", "reindex"] as const;
export type BrainIngestionOperation =
  (typeof BRAIN_INGESTION_OPERATIONS)[number];

export const BRAIN_ACCESS_ACTIONS = [
  "read",
  "search",
  "ingest",
  "manage",
] as const;
export type BrainAccessAction = (typeof BRAIN_ACCESS_ACTIONS)[number];

export type BrainMetadataScalar = string | number | boolean | null;
export type BrainMetadataValue =
  | BrainMetadataScalar
  | readonly BrainMetadataValue[]
  | { readonly [key: string]: BrainMetadataValue };
export type BrainMetadata = Readonly<Record<string, BrainMetadataValue>>;

export interface BrainFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface BrainSource {
  readonly id: string;
  readonly scope: BrainScope;
  readonly type: BrainSourceType;
  readonly label: string;
  readonly status: BrainSourceStatus;
  readonly trust: BrainTrustLevel;
  readonly currentVersion?: string;
  readonly failure?: BrainFailure;
  readonly metadata: BrainMetadata;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateBrainSourceInput {
  readonly id?: string;
  readonly scope: BrainScope;
  readonly type: BrainSourceType;
  readonly label: string;
  readonly trust: BrainTrustLevel;
  readonly metadata?: Record<string, unknown>;
}

export interface BrainSourceVersion {
  readonly sourceId: string;
  readonly version: string;
  readonly status: BrainVersionStatus;
  readonly contentType?: string;
  readonly byteSize?: number;
  readonly contentHash?: string;
  readonly failure?: BrainFailure;
  readonly metadata: BrainMetadata;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly indexedAt?: string;
}

export interface CreateBrainSourceVersionInput {
  readonly sourceId: string;
  readonly version: string;
  readonly status?: Extract<BrainVersionStatus, "pending" | "indexing">;
  readonly contentType?: string;
  readonly byteSize?: number;
  readonly contentHash?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface BrainCitation {
  readonly sourceId: string;
  readonly version: string;
  readonly chunkId: string;
  readonly label: string;
  readonly uri?: string;
  readonly locator?: string;
  readonly capturedAt?: string;
}

export interface BrainChunk {
  readonly id: string;
  readonly sourceId: string;
  readonly version: string;
  readonly index: number;
  readonly content: string;
  readonly citation: BrainCitation;
  readonly tokenCount?: number;
  readonly metadata: BrainMetadata;
}

export interface CreateBrainChunkInput {
  readonly id: string;
  readonly sourceId: string;
  readonly version: string;
  readonly index: number;
  readonly content: string;
  readonly citation: BrainCitation;
  readonly tokenCount?: number;
  readonly metadata?: Record<string, unknown>;
}

export interface BrainRetrievalScores {
  readonly keyword?: number;
  readonly semantic?: number;
  readonly rerank?: number;
}

export interface BrainRetrievalResult {
  readonly chunk: BrainChunk;
  readonly score: number;
  readonly scores: BrainRetrievalScores;
  readonly trust: BrainTrustLevel;
}

export interface CreateBrainRetrievalResultInput {
  readonly chunk: BrainChunk;
  readonly score: number;
  readonly scores?: BrainRetrievalScores;
  readonly trust: BrainTrustLevel;
}

export interface BrainIngestionJob {
  readonly id: string;
  readonly scope: BrainScope;
  readonly sourceId: string;
  readonly version: string;
  readonly operation: BrainIngestionOperation;
  readonly dedupeKey: string;
  readonly status: BrainIngestionJobStatus;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly availableAt: string;
  readonly claimedBy?: string;
  readonly claimToken?: string;
  readonly leaseExpiresAt?: string;
  readonly failure?: BrainFailure;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
}

export interface CreateBrainIngestionJobInput {
  readonly id?: string;
  readonly scope: BrainScope;
  readonly sourceId: string;
  readonly version: string;
  readonly operation: BrainIngestionOperation;
  readonly dedupeKey: string;
  readonly status?: BrainIngestionJobStatus;
  readonly attempt?: number;
  readonly maxAttempts?: number;
  readonly availableAt?: string;
  readonly claimedBy?: string;
  readonly claimToken?: string;
  readonly leaseExpiresAt?: string;
  readonly failure?: BrainFailure;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly completedAt?: string;
}

export interface BrainFactoryOptions {
  readonly createId?: () => string;
  readonly now?: () => Date | string;
}

export interface BrainActorContext extends BrainScopeAccess {
  readonly actor: "user" | "agent" | "system";
  readonly actorId?: string;
  readonly agentName?: string;
  /** Hosted application's user id, not a Polpo account or member id. */
  readonly externalUserId?: string;
  readonly channelId?: string;
  readonly sessionId?: string;
  readonly grants?: readonly string[];
}

export interface BrainAccessRequest {
  readonly action: BrainAccessAction;
  readonly source: BrainSource;
  readonly actor: BrainActorContext;
}

export interface BrainAccessDecision {
  readonly allowed: boolean;
  readonly reason: string;
  readonly matchedScope?: BrainScope;
}

export interface BrainTrustRequest {
  readonly source: BrainSource;
  readonly actor?: BrainActorContext;
  readonly operation: "ingest" | "retrieve";
}

export interface BrainTrustDecision {
  readonly trust: BrainTrustLevel;
  readonly reason: string;
}

export interface BrainSourceRef {
  readonly scope: BrainScope;
  readonly sourceId: string;
}

export interface BrainVersionRef extends BrainSourceRef {
  readonly version: string;
}

export interface BrainSourceListQuery {
  readonly scopes: readonly BrainScope[];
  readonly statuses?: readonly BrainSourceStatus[];
  readonly types?: readonly BrainSourceType[];
  readonly limit?: number;
  readonly cursor?: string;
}

export interface BrainSourceListResult {
  readonly sources: readonly BrainSource[];
  readonly cursor?: string;
}

export interface BrainPublishVersionInput extends BrainVersionRef {
  readonly expectedCurrentVersion?: string;
}

export interface BrainReplaceVersionChunksInput extends BrainVersionRef {
  readonly chunks: readonly BrainChunk[];
}

export interface BrainCandidateSearchQuery {
  readonly scopes: readonly BrainScope[];
  /** Must already be filtered by the caller's ACL policy. */
  readonly sourceIds: readonly string[];
  readonly query: string;
  readonly limit: number;
}

export interface BrainEnqueueResult {
  readonly job: BrainIngestionJob;
  readonly created: boolean;
}

export interface BrainJobClaimInput {
  readonly scope: BrainScope;
  readonly workerId: string;
  readonly now: string;
  readonly leaseMs: number;
}

export interface BrainJobMutationInput {
  readonly scope: BrainScope;
  readonly jobId: string;
  readonly claimToken: string;
  readonly now: string;
}

export interface BrainJobFailureInput extends BrainJobMutationInput {
  readonly failure: BrainFailure;
  readonly retryAt?: string;
}

export interface BrainParsedSection {
  readonly content: string;
  readonly locator?: string;
  readonly metadata?: BrainMetadata;
}

export type BrainParserBody =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "bytes"; readonly bytes: Uint8Array };

export interface BrainParserInput {
  readonly source: BrainSource;
  readonly version: BrainSourceVersion;
  readonly body: BrainParserBody;
  readonly contentType?: string;
}

export interface BrainParserResult {
  readonly sections: readonly BrainParsedSection[];
  readonly metadata?: BrainMetadata;
}

export interface BrainEmbeddingRequest {
  readonly texts: readonly string[];
  readonly model?: string;
}

export interface BrainEmbeddingResult {
  readonly vectors: readonly (readonly number[])[];
  readonly model: string;
  readonly dimensions: number;
}

export interface BrainRerankRequest {
  readonly query: string;
  readonly results: readonly BrainRetrievalResult[];
  readonly limit: number;
}
