import { ConnectError, type ConnectorDefinitionStore, type StoredConnectorDefinition } from "@polpo-ai/connect";

/** In-memory host adapter for tests and ephemeral self-hosted deployments. */
export class MemoryConnectorDefinitionStore implements ConnectorDefinitionStore {
  private readonly definitions = new Map<string, StoredConnectorDefinition>();

  async listConnectorDefinitions(): Promise<StoredConnectorDefinition[]> {
    return structuredClone([...this.definitions.values()]);
  }
  async getConnectorDefinition(id: string): Promise<StoredConnectorDefinition | null> {
    return structuredClone(this.definitions.get(id) ?? null);
  }
  async createConnectorDefinition(record: StoredConnectorDefinition): Promise<void> {
    if (this.definitions.has(record.definition.id)) throw new ConnectError("invalid_provider", "Connector id is already registered");
    this.definitions.set(record.definition.id, structuredClone(record));
  }
  async disableConnectorDefinition(id: string, disabledAt: string): Promise<StoredConnectorDefinition> {
    const record = this.definitions.get(id);
    if (!record) throw new ConnectError("provider_not_found", "Custom Connector not found");
    if (!record.disabledAt) record.disabledAt = disabledAt;
    return structuredClone(record);
  }
}
