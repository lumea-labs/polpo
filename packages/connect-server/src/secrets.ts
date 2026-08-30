import type { StoredConnectionSecret } from "@polpo-ai/connect";

export interface ConnectionSecretStore {
  setSecret(ref: string, secret: StoredConnectionSecret): Promise<void>;
  getSecret(ref: string): Promise<StoredConnectionSecret | null>;
  deleteSecret(ref: string): Promise<void>;
}

export interface VersionedConnectionSecret {
  secret: StoredConnectionSecret;
  version: string;
}

export interface VersionedConnectionSecretStore extends ConnectionSecretStore {
  getVersioned(ref: string): Promise<VersionedConnectionSecret | null>;
  compareAndSet(
    ref: string,
    version: string,
    secret: StoredConnectionSecret,
  ): Promise<boolean>;
}

export interface TokenRefreshCoordinator {
  runExclusive<T>(connectionId: string, fn: () => Promise<T>): Promise<T>;
}

export class MemoryConnectionSecretStore implements ConnectionSecretStore {
  private readonly records = new Map<string, StoredConnectionSecret>();
  private readonly versions = new Map<string, number>();

  async setSecret(ref: string, secret: StoredConnectionSecret): Promise<void> {
    this.records.set(ref, clone(secret));
    this.versions.set(ref, (this.versions.get(ref) ?? 0) + 1);
  }

  async getSecret(ref: string): Promise<StoredConnectionSecret | null> {
    const secret = this.records.get(ref);
    return secret ? clone(secret) : null;
  }

  async deleteSecret(ref: string): Promise<void> {
    this.records.delete(ref);
    this.versions.set(ref, (this.versions.get(ref) ?? 0) + 1);
  }

  async getVersioned(ref: string): Promise<VersionedConnectionSecret | null> {
    const secret = this.records.get(ref);
    if (!secret) return null;
    return {
      secret: clone(secret),
      version: String(this.versions.get(ref) ?? 0),
    };
  }

  async compareAndSet(
    ref: string,
    version: string,
    secret: StoredConnectionSecret,
  ): Promise<boolean> {
    if (!this.records.has(ref) || String(this.versions.get(ref) ?? 0) !== version) {
      return false;
    }
    await this.setSecret(ref, secret);
    return true;
  }
}

export class MemoryTokenRefreshCoordinator implements TokenRefreshCoordinator {
  private readonly tails = new Map<string, Promise<void>>();

  async runExclusive<T>(connectionId: string, fn: () => Promise<T>): Promise<T> {
    const predecessor = this.tails.get(connectionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = predecessor.catch(() => undefined).then(() => gate);
    this.tails.set(connectionId, tail);
    await predecessor.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(connectionId) === tail) this.tails.delete(connectionId);
    }
  }
}

export function isVersionedConnectionSecretStore(
  store: ConnectionSecretStore,
): store is VersionedConnectionSecretStore {
  const candidate = store as Partial<VersionedConnectionSecretStore>;
  return typeof candidate.getVersioned === "function"
    && typeof candidate.compareAndSet === "function";
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
