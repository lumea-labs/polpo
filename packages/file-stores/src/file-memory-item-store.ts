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
  InMemoryMemoryItemStore,
  type MemoryDedupeInput,
  type MemoryGetOptions,
  type MemoryItem,
  type MemoryItemPatch,
  type MemoryItemStore,
  type MemoryItemStoreSnapshot,
  type MemoryListPage,
  type MemoryListPageQuery,
  type MemoryListQuery,
  type MemorySearchQuery,
  type MemorySearchResult,
  type MemoryStoreContext,
  type MemorySupersedeResult,
  type MemoryUsageEvent,
  type MemoryWritePolicy,
} from "@polpo-ai/core/memory";

export class MemoryStoreCorruptionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MemoryStoreCorruptionError";
  }
}

export interface FileMemoryItemStoreOptions {
  readonly fileName?: string;
  readonly writePolicy?: MemoryWritePolicy;
}

export class FileMemoryItemStore implements MemoryItemStore {
  private readonly path: string;
  private readonly memory: InMemoryMemoryItemStore;
  private loaded = false;
  private loadError: MemoryStoreCorruptionError | undefined;
  private writes: Promise<void> = Promise.resolve();

  constructor(
    polpoDir: string,
    options: FileMemoryItemStoreOptions = {},
  ) {
    this.path = join(polpoDir, options.fileName ?? "memory-items.json");
    this.memory = new InMemoryMemoryItemStore(options.writePolicy);
  }

  private load(): void {
    if (this.loaded) {
      if (this.loadError) throw this.loadError;
      return;
    }
    this.loaded = true;
    if (!existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as
        MemoryItemStoreSnapshot;
      this.memory.replaceSnapshot(parsed);
    } catch (error) {
      this.loadError = new MemoryStoreCorruptionError(
        `Memory item store is corrupt: ${this.path}`,
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
        `${JSON.stringify(this.memory.exportSnapshot(), null, 2)}\n`,
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
      const before = this.memory.exportSnapshot();
      try {
        const value = await operation();
        this.persist();
        return value;
      } catch (error) {
        this.memory.replaceSnapshot(before);
        throw error;
      }
    });
    this.writes = result.then(() => undefined, () => undefined);
    return result;
  }

  create(item: MemoryItem, context: MemoryStoreContext): Promise<MemoryItem> {
    return this.mutate(() => this.memory.create(item, context));
  }

  get(
    id: string,
    context: MemoryStoreContext,
    options?: MemoryGetOptions,
  ): Promise<MemoryItem | undefined> {
    return this.read(() => this.memory.get(id, context, options));
  }

  list(
    query: MemoryListQuery,
    context: MemoryStoreContext,
  ): Promise<MemoryItem[]> {
    return this.read(() => this.memory.list(query, context));
  }

  listPage(
    query: MemoryListPageQuery,
    context: MemoryStoreContext,
  ): Promise<MemoryListPage> {
    return this.read(() => this.memory.listPage(query, context));
  }

  update(
    id: string,
    patch: MemoryItemPatch,
    context: MemoryStoreContext,
  ): Promise<MemoryItem | undefined> {
    return this.mutate(() => this.memory.update(id, patch, context));
  }

  supersede(
    id: string,
    replacement: MemoryItem,
    context: MemoryStoreContext,
  ): Promise<MemorySupersedeResult | undefined> {
    return this.mutate(() => this.memory.supersede(
      id,
      replacement,
      context,
    ));
  }

  forget(id: string, context: MemoryStoreContext): Promise<boolean> {
    return this.mutate(() => this.memory.forget(id, context));
  }

  search(
    query: MemorySearchQuery,
    context: MemoryStoreContext,
  ): Promise<MemorySearchResult[]> {
    return this.read(() => this.memory.search(query, context));
  }

  findDedupeCandidate(
    input: MemoryDedupeInput,
    context: MemoryStoreContext,
  ): Promise<MemoryItem | undefined> {
    return this.read(() => this.memory.findDedupeCandidate(input, context));
  }

  appendUsage(
    event: MemoryUsageEvent,
    context: MemoryStoreContext,
  ): Promise<void> {
    return this.mutate(() => this.memory.appendUsage(event, context));
  }

  listUsage(
    memoryId: string,
    context: MemoryStoreContext,
  ): Promise<MemoryUsageEvent[]> {
    return this.read(() => this.memory.listUsage(memoryId, context));
  }

  async close(): Promise<void> {
    await this.writes;
  }
}
