import { BrainContractError } from "./errors.js";
import type {
  BrainIngestionJobStatus,
  BrainSource,
  BrainSourceStatus,
  BrainVersionStatus,
} from "./types.js";

const sourceTransitions: Readonly<
  Record<BrainSourceStatus, ReadonlySet<BrainSourceStatus>>
> = {
  pending: new Set(["pending", "indexing", "failed", "deleted"]),
  indexing: new Set(["indexing", "indexed", "failed", "deleted"]),
  indexed: new Set(["indexed", "indexing", "failed", "deleted"]),
  failed: new Set(["failed", "indexing", "deleted"]),
  deleted: new Set(["deleted"]),
};

const versionTransitions: Readonly<
  Record<BrainVersionStatus, ReadonlySet<BrainVersionStatus>>
> = {
  pending: new Set(["pending", "indexing", "failed", "deleted"]),
  indexing: new Set(["indexing", "indexed", "failed", "deleted"]),
  indexed: new Set(["indexed", "superseded", "deleted"]),
  superseded: new Set(["superseded", "deleted"]),
  failed: new Set(["failed", "indexing", "deleted"]),
  deleted: new Set(["deleted"]),
};

const ingestionTransitions: Readonly<
  Record<BrainIngestionJobStatus, ReadonlySet<BrainIngestionJobStatus>>
> = {
  pending: new Set(["pending", "processing", "cancelled"]),
  processing: new Set([
    "processing",
    "pending",
    "completed",
    "failed",
    "cancelled",
  ]),
  completed: new Set(["completed"]),
  failed: new Set(["failed"]),
  cancelled: new Set(["cancelled"]),
};

function assertTransition<T extends string>(
  from: T,
  to: T,
  transitions: Readonly<Record<T, ReadonlySet<T>>>,
  label: string,
): void {
  if (!transitions[from]?.has(to)) {
    throw new BrainContractError(
      `Invalid Brain ${label} transition: ${String(from)} -> ${String(to)}`,
      "invalid_transition",
      "status",
    );
  }
}

export function assertBrainSourceStatusTransition(
  from: BrainSourceStatus,
  to: BrainSourceStatus,
): void {
  assertTransition(from, to, sourceTransitions, "source status");
}

export function assertBrainVersionStatusTransition(
  from: BrainVersionStatus,
  to: BrainVersionStatus,
): void {
  assertTransition(from, to, versionTransitions, "version status");
}

export function assertBrainIngestionJobStatusTransition(
  from: BrainIngestionJobStatus,
  to: BrainIngestionJobStatus,
): void {
  assertTransition(from, to, ingestionTransitions, "ingestion job status");
}

export function isBrainSourceRetrievable(
  source: Pick<BrainSource, "status" | "currentVersion">,
): boolean {
  return Boolean(
    source.currentVersion
    && (
      source.status === "indexed"
      || source.status === "indexing"
      || source.status === "failed"
    ),
  );
}
