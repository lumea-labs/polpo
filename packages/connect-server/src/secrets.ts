import type { StoredConnectionSecret } from "@polpo-ai/connect";

export interface ConnectionSecretStore {
  setSecret(ref: string, secret: StoredConnectionSecret): Promise<void>;
  getSecret(ref: string): Promise<StoredConnectionSecret | null>;
  deleteSecret(ref: string): Promise<void>;
}

export class MemoryConnectionSecretStore implements ConnectionSecretStore {
  private readonly records = new Map<string, StoredConnectionSecret>();

  async setSecret(ref: string, secret: StoredConnectionSecret): Promise<void> {
    this.records.set(ref, clone(secret));
  }

  async getSecret(ref: string): Promise<StoredConnectionSecret | null> {
    const secret = this.records.get(ref);
    return secret ? clone(secret) : null;
  }

  async deleteSecret(ref: string): Promise<void> {
    this.records.delete(ref);
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
