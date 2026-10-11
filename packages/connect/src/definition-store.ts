import type { ConnectorDefinition } from "./definitions.js";

export interface StoredConnectorDefinition {
  definition: ConnectorDefinition;
  createdAt: string;
  disabledAt?: string;
}

/**
 * A host binds one store instance to an operator/tenant before creating the service.
 * IDs are immutable, including after disabling. Changing a destination requires a
 * new definition and explicit authorization, never reuse of an existing secret.
 */
export interface ConnectorDefinitionStore {
  listConnectorDefinitions(): Promise<StoredConnectorDefinition[]>;
  getConnectorDefinition(id: string): Promise<StoredConnectorDefinition | null>;
  /** Atomically reject duplicate IDs, including concurrent creations. */
  createConnectorDefinition(record: StoredConnectorDefinition): Promise<void>;
  disableConnectorDefinition(id: string, disabledAt: string): Promise<StoredConnectorDefinition>;
}
