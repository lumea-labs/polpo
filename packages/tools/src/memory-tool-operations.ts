export interface MemoryToolOperation {
  readonly key: string;
  readonly fingerprint: string;
}

export interface MemoryToolOperationCoordinator {
  run<T>(
    operation: MemoryToolOperation,
    execute: () => Promise<T>,
  ): Promise<T>;
}

interface OperationEntry {
  readonly fingerprint: string;
  readonly result: Promise<unknown>;
  settled: boolean;
}

export class MemoryToolOperationConflictError extends Error {
  readonly code = "memory_tool_operation_conflict";

  constructor() {
    super("Memory tool call id was reused with different arguments");
    this.name = "MemoryToolOperationConflictError";
  }
}

/** Process-local coordinator. Hosted runtimes can inject a durable equivalent. */
export class InMemoryMemoryToolOperationCoordinator
implements MemoryToolOperationCoordinator {
  private readonly entries = new Map<string, OperationEntry>();

  constructor(private readonly maxEntries = 10_000) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new TypeError("Memory operation coordinator maxEntries must be positive");
    }
  }

  run<T>(operation: MemoryToolOperation, execute: () => Promise<T>): Promise<T> {
    const existing = this.entries.get(operation.key);
    if (existing) {
      if (existing.fingerprint !== operation.fingerprint) {
        throw new MemoryToolOperationConflictError();
      }
      return existing.result as Promise<T>;
    }

    if (this.entries.size >= this.maxEntries) {
      const settled = [...this.entries.entries()].find(([, entry]) => entry.settled);
      if (!settled) {
        throw new Error("Memory operation coordinator is at capacity");
      }
      this.entries.delete(settled[0]);
    }

    const result = execute();
    const entry: OperationEntry = {
      fingerprint: operation.fingerprint,
      result,
      settled: false,
    };
    this.entries.set(operation.key, entry);
    result.then(() => {
      entry.settled = true;
    }, () => {});
    result.catch(() => {
      if (this.entries.get(operation.key)?.result === result) {
        this.entries.delete(operation.key);
      }
    });
    return result;
  }
}
