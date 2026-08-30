import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  InMemoryMemoryExtractionStore,
  type MemoryExtractionApplyInput,
  type MemoryExtractionAuditEvent,
  type MemoryExtractionCandidate,
  type MemoryExtractionCandidateStore,
  type MemoryExtractionDecisionInput,
  type MemoryExtractionListQuery,
  type MemoryExtractionProposeResult,
  type MemoryExtractionStoreContext,
  type MemoryExtractionStoreSnapshot,
  type MemoryScope,
} from "@polpo-ai/core/memory";
import { MemoryStoreCorruptionError } from "./file-memory-item-store.js";

export interface FileMemoryExtractionStoreOptions {
  readonly fileName?: string;
}

/** Durable local candidate/audit store for self-hosted automatic Memory. */
export class FileMemoryExtractionStore implements MemoryExtractionCandidateStore {
  private readonly path: string;
  private memory = new InMemoryMemoryExtractionStore();
  private loaded = false;
  private loadError: MemoryStoreCorruptionError | undefined;
  private writes: Promise<void> = Promise.resolve();

  constructor(polpoDir: string, options: FileMemoryExtractionStoreOptions = {}) {
    this.path = join(polpoDir, options.fileName ?? "memory-candidates.json");
  }

  private load(): void {
    if (this.loaded) {
      if (this.loadError) throw this.loadError;
      return;
    }
    this.loaded = true;
    if (!existsSync(this.path)) return;
    try {
      const snapshot = JSON.parse(readFileSync(this.path, "utf8")) as
        MemoryExtractionStoreSnapshot;
      this.memory = new InMemoryMemoryExtractionStore({ snapshot });
    } catch (error) {
      this.loadError = new MemoryStoreCorruptionError(
        `Memory extraction store is corrupt: ${this.path}`,
        { cause: error },
      );
      throw this.loadError;
    }
  }

  private persist(): void {
    const directory = dirname(this.path);
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
    const temporaryPath = `${this.path}.tmp`;
    try {
      writeFileSync(
        temporaryPath,
        `${JSON.stringify(this.memory.snapshot(), null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      renameSync(temporaryPath, this.path);
    } catch (error) {
      try {
        if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
      } catch {
        // Preserve the original persistence error.
      }
      throw error;
    }
  }

  private async read<T>(operation: () => Promise<T>): Promise<T> {
    await this.writes;
    this.load();
    return operation();
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writes.then(async () => {
      this.load();
      const before = this.memory.snapshot();
      try {
        const value = await operation();
        this.persist();
        return value;
      } catch (error) {
        this.memory = new InMemoryMemoryExtractionStore({ snapshot: before });
        throw error;
      }
    });
    this.writes = result.then(() => undefined, () => undefined);
    return result;
  }

  propose(
    candidate: MemoryExtractionCandidate,
    context: MemoryExtractionStoreContext,
  ): Promise<MemoryExtractionProposeResult> {
    return this.mutate(() => this.memory.propose(candidate, context));
  }

  get(
    id: string,
    context: MemoryExtractionStoreContext,
  ): Promise<MemoryExtractionCandidate | undefined> {
    return this.read(() => this.memory.get(id, context));
  }

  getByIdempotencyKey(
    idempotencyKey: string,
    scope: MemoryScope,
    context: MemoryExtractionStoreContext,
  ): Promise<MemoryExtractionCandidate | undefined> {
    return this.read(() => this.memory.getByIdempotencyKey(
      idempotencyKey,
      scope,
      context,
    ));
  }

  list(
    query: MemoryExtractionListQuery,
    context: MemoryExtractionStoreContext,
  ): Promise<MemoryExtractionCandidate[]> {
    return this.read(() => this.memory.list(query, context));
  }

  decide(
    id: string,
    input: MemoryExtractionDecisionInput,
    context: MemoryExtractionStoreContext,
  ): Promise<MemoryExtractionCandidate> {
    return this.mutate(() => this.memory.decide(id, input, context));
  }

  markApplied(
    id: string,
    input: MemoryExtractionApplyInput,
    context: MemoryExtractionStoreContext,
  ): Promise<MemoryExtractionCandidate> {
    return this.mutate(() => this.memory.markApplied(id, input, context));
  }

  listAudit(
    candidateId: string,
    context: MemoryExtractionStoreContext,
  ): Promise<MemoryExtractionAuditEvent[]> {
    return this.read(() => this.memory.listAudit(candidateId, context));
  }

  async close(): Promise<void> {
    await this.writes;
  }
}
