import { nanoid } from "nanoid";
import {
  normalizeBrainAccessDecision,
  normalizeBrainSource,
  normalizeBrainSourceVersion,
} from "./contracts.js";
import { chunkBrainSections } from "./chunking.js";
import { normalizeBrainScope } from "./scope.js";
import {
  BrainIngestionError,
  BrainStoreConflictError,
} from "./store-errors.js";
import type { BrainAccessPolicy, BrainParser } from "./ports.js";
import type {
  BrainChunkStore,
  BrainSourceStore,
  BrainVersionStore,
} from "./stores.js";
import type {
  BrainActorContext,
  BrainParserBody,
  BrainSource,
  BrainSourceRef,
} from "./types.js";

export interface IngestBrainSourceInput {
  readonly ref: BrainSourceRef;
  readonly version: string;
  readonly body: BrainParserBody;
  readonly contentType?: string;
  readonly actor: BrainActorContext;
}

export interface IngestBrainSourceDeps {
  readonly sourceStore: BrainSourceStore;
  readonly versionStore: BrainVersionStore;
  readonly chunkStore: BrainChunkStore;
  readonly accessPolicy: BrainAccessPolicy;
  readonly parsers: readonly BrainParser[];
  readonly now?: () => Date | string;
  readonly createChunkId?: () => string;
  readonly maxChunkCharacters?: number;
  readonly overlapCharacters?: number;
}

function at(now: (() => Date | string) | undefined): string {
  const value = now?.() ?? new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new BrainIngestionError("Invalid ingestion timestamp");
  }
  return date.toISOString();
}

function failureFor(error: unknown): {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
} {
  if (error instanceof BrainIngestionError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.code === "ingestion_failed",
    };
  }
  return {
    code: "ingestion_failed",
    message: "Brain source ingestion failed",
    retryable: true,
  };
}

async function authorizeIngestion(
  source: BrainSource,
  actor: BrainActorContext,
  policy: BrainAccessPolicy,
): Promise<void> {
  try {
    const decision = normalizeBrainAccessDecision(await policy.authorize({
      action: "ingest",
      source,
      actor,
    }));
    if (decision.allowed) return;
  } catch {
    // Policy failures are authorization failures. Do not mutate source state.
  }
  throw new BrainIngestionError("Brain source ingestion is not authorized", "access_denied");
}

export async function ingestBrainSource(
  input: IngestBrainSourceInput,
  deps: IngestBrainSourceDeps,
): Promise<BrainSource> {
  const scope = normalizeBrainScope(input.ref.scope);
  const ref = {
    scope,
    sourceId: input.ref.sourceId,
  };
  const versionRef = { ...ref, version: input.version };
  const originalSource = await deps.sourceStore.getSource(ref);
  if (!originalSource || originalSource.status === "deleted") {
    throw new BrainIngestionError("Brain source was not found", "source_not_found");
  }
  const originalVersion = await deps.versionStore.getVersion(versionRef);
  if (!originalVersion || originalVersion.status === "deleted") {
    throw new BrainIngestionError(
      "Brain source version was not found",
      "version_not_found",
    );
  }
  await authorizeIngestion(originalSource, input.actor, deps.accessPolicy);

  const startedAt = at(deps.now);
  const indexingSource = normalizeBrainSource({
    ...originalSource,
    status: "indexing",
    failure: undefined,
    updatedAt: startedAt,
  });
  const indexingVersion = normalizeBrainSourceVersion({
    ...originalVersion,
    status: "indexing",
    failure: undefined,
    updatedAt: startedAt,
  });

  let sourceWasMarked = false;
  let versionWasMarked = false;
  try {
    await deps.sourceStore.updateSource(indexingSource, {
      expectedUpdatedAt: originalSource.updatedAt,
    });
    sourceWasMarked = true;
    await deps.versionStore.updateVersion(scope, indexingVersion, {
      expectedUpdatedAt: originalVersion.updatedAt,
    });
    versionWasMarked = true;

    const parser = deps.parsers.find((candidate) =>
      candidate.supports(input.contentType)
    );
    if (!parser) {
      throw new BrainIngestionError(
        "No parser supports this Brain content type",
        "parser_not_found",
      );
    }
    const parsed = await parser.parse({
      source: indexingSource,
      version: indexingVersion,
      body: input.body,
      contentType: input.contentType,
    });
    const chunks = chunkBrainSections({
      source: indexingSource,
      version: input.version,
      sections: parsed.sections,
      createId: deps.createChunkId ?? (() => `brain-chunk-${nanoid(16)}`),
      ...(deps.maxChunkCharacters === undefined
        ? {}
        : { maxCharacters: deps.maxChunkCharacters }),
      ...(deps.overlapCharacters === undefined
        ? {}
        : { overlapCharacters: deps.overlapCharacters }),
    });
    if (chunks.length === 0) {
      throw new BrainIngestionError(
        "Brain content did not produce any searchable text",
        "empty_content",
      );
    }
    await deps.chunkStore.replaceVersionChunks({
      ...versionRef,
      chunks,
    });
    return await deps.sourceStore.publishVersion({
      ...versionRef,
      expectedCurrentVersion: originalSource.currentVersion ?? null,
    });
  } catch (error) {
    const failedAt = at(deps.now);
    const failure = failureFor(error);
    if (versionWasMarked) {
      const currentVersion = await deps.versionStore.getVersion(versionRef);
      if (currentVersion?.status === "indexing") {
        await deps.versionStore.updateVersion(scope, normalizeBrainSourceVersion({
          ...currentVersion,
          status: "failed",
          failure,
          updatedAt: failedAt,
        }), { expectedUpdatedAt: currentVersion.updatedAt }).catch(() => undefined);
      }
    }
    if (sourceWasMarked) {
      const currentSource = await deps.sourceStore.getSource(ref);
      if (currentSource?.status === "indexing") {
        const restored = originalSource.currentVersion
          ? normalizeBrainSource({
              ...currentSource,
              status: "indexed",
              currentVersion: originalSource.currentVersion,
              failure: undefined,
              updatedAt: failedAt,
            })
          : normalizeBrainSource({
              ...currentSource,
              status: "failed",
              currentVersion: undefined,
              failure,
              updatedAt: failedAt,
            });
        await deps.sourceStore.updateSource(restored, {
          expectedUpdatedAt: currentSource.updatedAt,
        }).catch(() => undefined);
      }
    }
    if (error instanceof BrainIngestionError) throw error;
    if (error instanceof BrainStoreConflictError) throw error;
    throw new BrainIngestionError(
      "Brain source ingestion failed",
      "ingestion_failed",
      { cause: error },
    );
  }
}
