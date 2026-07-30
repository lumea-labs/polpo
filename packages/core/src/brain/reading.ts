import { normalizeBrainAccessDecision } from "./contracts.js";
import { normalizeBrainScope } from "./scope.js";
import {
  BrainIngestionError,
  BrainStoreValidationError,
} from "./store-errors.js";
import type { BrainAccessPolicy } from "./ports.js";
import type {
  BrainChunkStore,
  BrainSourceStore,
  BrainVersionStore,
} from "./stores.js";
import type {
  BrainActorContext,
  BrainChunk,
  BrainSource,
  BrainSourceRef,
  BrainSourceVersion,
} from "./types.js";

export interface ReadBrainSourceInput {
  readonly ref: BrainSourceRef;
  readonly actor: BrainActorContext;
  readonly version?: string;
  readonly offset?: number;
  readonly limit?: number;
  readonly tokenBudget?: number;
}

export interface ReadBrainSourceDeps {
  readonly sourceStore: BrainSourceStore;
  readonly versionStore: BrainVersionStore;
  readonly chunkStore: BrainChunkStore;
  readonly accessPolicy: BrainAccessPolicy;
}

export interface ReadBrainSourceResult {
  readonly source: BrainSource;
  readonly version: BrainSourceVersion;
  readonly chunks: readonly BrainChunk[];
  readonly nextOffset?: number;
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

async function authorizeRead(
  source: BrainSource,
  actor: BrainActorContext,
  policy: BrainAccessPolicy,
): Promise<void> {
  try {
    const decision = normalizeBrainAccessDecision(await policy.authorize({
      action: "read",
      source,
      actor,
    }));
    if (decision.allowed) return;
  } catch {
    // Policy failures deny access. The caller never receives policy internals.
  }
  throw new BrainIngestionError(
    "Brain source read is not authorized",
    "access_denied",
  );
}

function chunkTokens(chunk: BrainChunk): number {
  return chunk.tokenCount
    ?? Math.max(1, Math.ceil(chunk.content.length / 4));
}

export async function readBrainSource(
  input: ReadBrainSourceInput,
  deps: ReadBrainSourceDeps,
): Promise<ReadBrainSourceResult> {
  const scope = normalizeBrainScope(input.ref.scope);
  const sourceId = typeof input.ref.sourceId === "string"
    ? input.ref.sourceId.trim()
    : "";
  if (!sourceId) {
    throw new BrainStoreValidationError("sourceId is required");
  }
  const offset = boundedInteger(input.offset, 0, "offset", 0, 1_000_000);
  const limit = boundedInteger(input.limit, 20, "limit", 1, 1_000);
  const tokenBudget = boundedInteger(
    input.tokenBudget,
    8_000,
    "tokenBudget",
    0,
    1_000_000,
  );
  const ref = { scope, sourceId };
  const initialSource = await deps.sourceStore.getSource(ref);
  if (!initialSource || initialSource.status === "deleted") {
    throw new BrainIngestionError(
      "Brain source was not found",
      "source_not_found",
    );
  }
  await authorizeRead(initialSource, input.actor, deps.accessPolicy);

  const versionName = input.version?.trim() || initialSource.currentVersion;
  if (!versionName) {
    throw new BrainIngestionError(
      "Brain source has no readable version",
      "version_not_found",
    );
  }
  const versionRef = { ...ref, version: versionName };
  const initialVersion = await deps.versionStore.getVersion(versionRef);
  if (
    !initialVersion
    || initialVersion.status === "deleted"
    || initialVersion.status === "failed"
    || initialVersion.status === "pending"
    || initialVersion.status === "indexing"
  ) {
    throw new BrainIngestionError(
      "Brain source version was not found",
      "version_not_found",
    );
  }

  const allChunks = [...await deps.chunkStore.listVersionChunks(versionRef)]
    .sort((left, right) => left.index - right.index);
  const selected: BrainChunk[] = [];
  let consumed = 0;
  let cursor = offset;
  while (cursor < allChunks.length && selected.length < limit) {
    const chunk = allChunks[cursor];
    const tokens = chunkTokens(chunk);
    if (tokens <= tokenBudget - consumed) {
      selected.push(chunk);
      consumed += tokens;
    }
    cursor += 1;
  }

  // Re-read after policy evaluation and chunk loading. Deletion, replacement,
  // or a concurrent version mutation must not leak a stale result.
  const finalSource = await deps.sourceStore.getSource(ref);
  const finalVersion = await deps.versionStore.getVersion(versionRef);
  if (
    !finalSource
    || finalSource.status === "deleted"
    || !finalVersion
    || finalVersion.status !== initialVersion.status
    || finalVersion.updatedAt !== initialVersion.updatedAt
    || (
      input.version === undefined
      && finalSource.currentVersion !== versionName
    )
  ) {
    throw new BrainIngestionError(
      "Brain source changed while it was being read",
      "source_not_found",
    );
  }
  await authorizeRead(finalSource, input.actor, deps.accessPolicy);

  return Object.freeze({
    source: finalSource,
    version: finalVersion,
    chunks: Object.freeze(selected),
    ...(cursor < allChunks.length ? { nextOffset: cursor } : {}),
  });
}
