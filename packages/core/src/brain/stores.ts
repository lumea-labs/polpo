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
  BrainSource,
  BrainSourceListQuery,
  BrainSourceListResult,
  BrainSourceRef,
  BrainSourceVersion,
  BrainScope,
  BrainVersionRef,
} from "./types.js";

export interface BrainSourceStore {
  create(source: BrainSource): Promise<BrainSource>;
  get(ref: BrainSourceRef): Promise<BrainSource | null>;
  list(query: BrainSourceListQuery): Promise<BrainSourceListResult>;
  update(
    source: BrainSource,
    options?: { readonly expectedUpdatedAt?: string },
  ): Promise<BrainSource>;
  publishVersion(input: BrainPublishVersionInput): Promise<BrainSource>;
  delete(ref: BrainSourceRef): Promise<void>;
}

export interface BrainVersionStore {
  create(
    scope: BrainSourceRef["scope"],
    version: BrainSourceVersion,
  ): Promise<BrainSourceVersion>;
  get(ref: BrainVersionRef): Promise<BrainSourceVersion | null>;
  list(ref: BrainSourceRef): Promise<readonly BrainSourceVersion[]>;
  update(
    scope: BrainSourceRef["scope"],
    version: BrainSourceVersion,
    options?: { readonly expectedUpdatedAt?: string },
  ): Promise<BrainSourceVersion>;
  delete(ref: BrainVersionRef): Promise<void>;
}

export interface BrainChunkStore {
  /**
   * Atomically replaces all chunks for one unpublished source version.
   * Implementations must expose either the complete new set or the prior set.
   */
  replaceVersion(input: BrainReplaceVersionChunksInput): Promise<void>;
  listVersion(ref: BrainVersionRef): Promise<readonly BrainChunk[]>;
  searchCandidates(
    query: BrainCandidateSearchQuery,
  ): Promise<readonly BrainRetrievalResult[]>;
  deleteVersion(ref: BrainVersionRef): Promise<void>;
  deleteSource(ref: BrainSourceRef): Promise<void>;
}

export interface BrainIngestionJobStore {
  /** Enqueues by dedupeKey and reports whether a new job was created. */
  enqueue(job: BrainIngestionJob): Promise<BrainEnqueueResult>;
  get(ref: {
    readonly scope: BrainScope;
    readonly jobId: string;
  }): Promise<BrainIngestionJob | null>;
  claimNext(input: BrainJobClaimInput): Promise<BrainIngestionJob | null>;
  complete(input: BrainJobMutationInput): Promise<BrainIngestionJob>;
  fail(input: BrainJobFailureInput): Promise<BrainIngestionJob>;
  cancel(input: BrainJobMutationInput): Promise<BrainIngestionJob>;
}
