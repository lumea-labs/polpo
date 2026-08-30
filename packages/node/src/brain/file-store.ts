import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  InMemoryBrainStore,
  type BrainEnqueueResult,
  type BrainIngestionJob,
  type BrainJobClaimInput,
  type BrainJobFailureInput,
  type BrainJobLeaseInput,
  type BrainJobMutationInput,
  type BrainPublishVersionInput,
  type BrainReplaceVersionChunksInput,
  type BrainScope,
  type BrainSource,
  type BrainSourceRef,
  type BrainSourceVersion,
  type BrainStoreSnapshot,
  type BrainVersionRef,
  type InMemoryBrainStoreOptions,
} from "@polpo-ai/core/brain";
import { FileBrainStoreCorruptionError } from "./errors.js";

export interface FileBrainStoreOptions
  extends Omit<InMemoryBrainStoreOptions, "snapshot"> {}

function loadSnapshot(path: string): BrainStoreSnapshot | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as BrainStoreSnapshot;
  } catch (error) {
    throw new FileBrainStoreCorruptionError(undefined, { cause: error });
  }
}

export class FileBrainStore extends InMemoryBrainStore {
  readonly path: string;

  constructor(path: string, options: FileBrainStoreOptions = {}) {
    const resolved = resolve(path);
    const snapshot = loadSnapshot(resolved);
    try {
      super({ ...options, ...(snapshot ? { snapshot } : {}) });
    } catch (error) {
      throw new FileBrainStoreCorruptionError(undefined, { cause: error });
    }
    this.path = resolved;
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp`;
    let descriptor: number | undefined;
    try {
      writeFileSync(temporary, `${JSON.stringify(this.snapshot(), null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      chmodSync(temporary, 0o600);
      descriptor = openSync(temporary, "r");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, this.path);
      const directory = openSync(dirname(this.path), "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }

  override async createSource(source: BrainSource): Promise<BrainSource> {
    const result = await super.createSource(source);
    this.persist();
    return result;
  }

  override async updateSource(
    source: BrainSource,
    options?: { readonly expectedUpdatedAt?: string },
  ): Promise<BrainSource> {
    const result = await super.updateSource(source, options);
    this.persist();
    return result;
  }

  override async publishVersion(input: BrainPublishVersionInput): Promise<BrainSource> {
    const result = await super.publishVersion(input);
    this.persist();
    return result;
  }

  override async deleteSource(ref: BrainSourceRef): Promise<void> {
    await super.deleteSource(ref);
    this.persist();
  }

  override async createVersion(
    scope: BrainScope,
    version: BrainSourceVersion,
  ): Promise<BrainSourceVersion> {
    const result = await super.createVersion(scope, version);
    this.persist();
    return result;
  }

  override async updateVersion(
    scope: BrainScope,
    version: BrainSourceVersion,
    options?: { readonly expectedUpdatedAt?: string },
  ): Promise<BrainSourceVersion> {
    const result = await super.updateVersion(scope, version, options);
    this.persist();
    return result;
  }

  override async deleteVersion(ref: BrainVersionRef): Promise<void> {
    await super.deleteVersion(ref);
    this.persist();
  }

  override async replaceVersionChunks(
    input: BrainReplaceVersionChunksInput,
  ): Promise<void> {
    await super.replaceVersionChunks(input);
    this.persist();
  }

  override async deleteVersionChunks(ref: BrainVersionRef): Promise<void> {
    await super.deleteVersionChunks(ref);
    this.persist();
  }

  override async deleteSourceChunks(ref: BrainSourceRef): Promise<void> {
    await super.deleteSourceChunks(ref);
    this.persist();
  }

  override async enqueueJob(job: BrainIngestionJob): Promise<BrainEnqueueResult> {
    const result = await super.enqueueJob(job);
    if (result.created) this.persist();
    return result;
  }

  override async claimNextJob(
    input: BrainJobClaimInput,
  ): Promise<BrainIngestionJob | null> {
    const result = await super.claimNextJob(input);
    this.persist();
    return result;
  }

  override async completeJob(input: BrainJobMutationInput): Promise<BrainIngestionJob> {
    const result = await super.completeJob(input);
    this.persist();
    return result;
  }

  override async renewJobLease(input: BrainJobLeaseInput): Promise<BrainIngestionJob> {
    const result = await super.renewJobLease(input);
    this.persist();
    return result;
  }

  override async failJob(input: BrainJobFailureInput): Promise<BrainIngestionJob> {
    const result = await super.failJob(input);
    this.persist();
    return result;
  }

  override async cancelJob(input: BrainJobMutationInput): Promise<BrainIngestionJob> {
    const result = await super.cancelJob(input);
    this.persist();
    return result;
  }
}
