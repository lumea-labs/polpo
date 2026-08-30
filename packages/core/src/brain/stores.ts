import type {
  BrainCandidateSearchQuery,
  BrainChunk,
  BrainEnqueueResult,
  BrainIngestionJob,
  BrainJobClaimInput,
  BrainJobFailureInput,
  BrainJobLeaseInput,
  BrainJobMutationInput,
  BrainPublishVersionInput,
  BrainReplaceVersionChunksInput,
  BrainRetrievalResult,
  BrainSource,
  BrainSourceListQuery,
  BrainSourceListResult,
  BrainSourceRef,
  BrainSourceVersion,
  BrainScope,
  BrainVersionRef,
} from "./types.js";

export interface BrainSourceStore {
  createSource(source: BrainSource): Promise<BrainSource>;
  getSource(ref: BrainSourceRef): Promise<BrainSource | null>;
  listSources(query: BrainSourceListQuery): Promise<BrainSourceListResult>;
  updateSource(
    source: BrainSource,
    options?: { readonly expectedUpdatedAt?: string },
  ): Promise<BrainSource>;
  publishVersion(input: BrainPublishVersionInput): Promise<BrainSource>;
  deleteSource(ref: BrainSourceRef): Promise<void>;
}

export interface BrainVersionStore {
  createVersion(
    scope: BrainSourceRef["scope"],
    version: BrainSourceVersion,
  ): Promise<BrainSourceVersion>;
  getVersion(ref: BrainVersionRef): Promise<BrainSourceVersion | null>;
  listVersions(ref: BrainSourceRef): Promise<readonly BrainSourceVersion[]>;
  updateVersion(
    scope: BrainSourceRef["scope"],
    version: BrainSourceVersion,
    options?: { readonly expectedUpdatedAt?: string },
  ): Promise<BrainSourceVersion>;
  deleteVersion(ref: BrainVersionRef): Promise<void>;
}

export interface BrainChunkStore {
  /**
   * Atomically replaces all chunks for one unpublished source version.
   * Implementations must expose either the complete new set or the prior set.
   */
  replaceVersionChunks(input: BrainReplaceVersionChunksInput): Promise<void>;
  listVersionChunks(ref: BrainVersionRef): Promise<readonly BrainChunk[]>;
  searchCandidates(
    query: BrainCandidateSearchQuery,
  ): Promise<readonly BrainRetrievalResult[]>;
  deleteVersionChunks(ref: BrainVersionRef): Promise<void>;
  deleteSourceChunks(ref: BrainSourceRef): Promise<void>;
}

export interface BrainIngestionJobStore {
  /** Enqueues by dedupeKey and reports whether a new job was created. */
  enqueueJob(job: BrainIngestionJob): Promise<BrainEnqueueResult>;
  getJob(ref: {
    readonly scope: BrainScope;
    readonly jobId: string;
  }): Promise<BrainIngestionJob | null>;
  claimNextJob(input: BrainJobClaimInput): Promise<BrainIngestionJob | null>;
  /** Optional for compatibility; workers heartbeat when the adapter provides it. */
  renewJobLease?(input: BrainJobLeaseInput): Promise<BrainIngestionJob>;
  completeJob(input: BrainJobMutationInput): Promise<BrainIngestionJob>;
  failJob(input: BrainJobFailureInput): Promise<BrainIngestionJob>;
  cancelJob(input: BrainJobMutationInput): Promise<BrainIngestionJob>;
}
