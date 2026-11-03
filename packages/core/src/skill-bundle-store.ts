import type { SkillBundle, SkillBundleReceipt, SkillBundleSource } from "./skill-bundle.js";
import type { SkillManifest } from "./skill-manifest.js";

/** A bundle that has passed the canonical manifest, path, size and digest checks. */
export interface ValidatedSkillBundle {
  bundle: SkillBundle;
  manifest: SkillManifest;
  digest: string;
  uncompressedBytes: number;
  source: SkillBundleSource | string;
}

/** One immutable version returned by a SkillBundleStore. */
export interface StoredSkillBundle extends ValidatedSkillBundle {
  /** Host-specific immutable root when resources can be mounted into a sandbox. */
  root?: string;
  createdAt?: string;
}

export interface StoredSkillSummary {
  name: string;
  description: string;
  digest: string;
  files: number;
  uncompressedBytes: number;
  source: SkillBundleSource | string;
  allowedTools?: string[];
  root?: string;
  createdAt?: string;
}

export interface SkillBundlePutOptions {
  conflict: "error" | "replace";
  /** Compare-and-swap precondition for the currently active digest. */
  expectedDigest?: string;
}

export interface SkillBundleDeleteOptions {
  /** Compare-and-swap precondition for the currently active digest. */
  expectedDigest?: string;
}

/**
 * Portable content-addressed skill storage contract.
 *
 * `get(name)` resolves the active version. `get(name, digest)` resolves that
 * exact immutable version so a checkpoint can resume without drifting after
 * a replacement. Implementations must never expose a partially written
 * bundle as active.
 */
export interface SkillBundleStore {
  get(name: string, digest?: string): Promise<StoredSkillBundle | null>;
  put(input: ValidatedSkillBundle, options: SkillBundlePutOptions): Promise<SkillBundleReceipt>;
  delete(name: string, options?: SkillBundleDeleteOptions): Promise<boolean>;
  list(): Promise<StoredSkillSummary[]>;
}

export type SkillBundleStoreConflictCode = "skill_conflict" | "skill_digest_conflict";

export class SkillBundleStoreConflictError extends Error {
  constructor(
    readonly code: SkillBundleStoreConflictCode,
    message: string,
    readonly currentDigest?: string,
  ) {
    super(message);
    this.name = "SkillBundleStoreConflictError";
  }
}
