import { ConnectError } from "./errors.js";
import { assertAllowedScopes } from "./scopes.js";
import { normalizeConnectorHttpPolicy } from "./http-policy.js";
import {
  compileConnectorDefinition, describeConnector, freezeConnectorValue, normalizeConnectorDefinition,
  type ConnectorCatalogEntry, type ConnectorDefinition,
} from "./definitions.js";
import type { ConnectorProviderDefinition } from "./types.js";

export interface ConnectorRegistry {
  list(): ConnectorProviderDefinition[];
  get(providerId: string, authenticationId?: string): ConnectorProviderDefinition | undefined;
  require(providerId: string, authenticationId?: string): ConnectorProviderDefinition;
  describe(providerId: string): ConnectorCatalogEntry;
  catalog(): ConnectorCatalogEntry[];
  validateScopes(providerId: string, scopes?: readonly string[]): string[];
}

export function createConnectorRegistry(providers: readonly (ConnectorProviderDefinition | ConnectorDefinition)[]): ConnectorRegistry {
  const byId = new Map<string, ConnectorProviderDefinition>();
  const methods = new Map<string, Map<string, ConnectorProviderDefinition>>();
  const catalog = new Map<string, ConnectorCatalogEntry>();
  for (const provider of providers) {
    validateProviderId(provider.id);
    if (byId.has(provider.id)) {
      throw new ConnectError("invalid_provider", `Duplicate connector provider id: ${provider.id}`);
    }
    if ("version" in provider) {
      const definition = normalizeConnectorDefinition(provider);
      const compiled = new Map(definition.authentication.map((method) => [
        method.id, compileConnectorDefinition(definition, method.id),
      ]));
      methods.set(provider.id, compiled);
      byId.set(provider.id, compiled.get(definition.defaultAuthenticationId)!);
      catalog.set(provider.id, describeConnector(definition));
    } else {
      const copy = structuredClone(provider);
      const legacy = freezeConnectorValue({
        ...copy,
        ...(copy.http ? { http: normalizeConnectorHttpPolicy(copy.http) } : {}),
      });
      byId.set(provider.id, legacy);
      catalog.set(provider.id, describeConnector(legacy));
    }
  }

  function get(providerId: string, authenticationId?: string) {
    const provider = byId.get(providerId);
    if (!provider || authenticationId === undefined) return provider;
    const compiled = methods.get(providerId);
    if (compiled) {
      const selected = compiled.get(authenticationId);
      if (!selected) throw new ConnectError("unsupported_auth", `Unsupported authentication: ${authenticationId}`);
      return selected;
    }
    if (authenticationId !== (provider.authenticationId ?? "default")) {
      throw new ConnectError("unsupported_auth", `Unsupported authentication: ${authenticationId}`);
    }
    return provider;
  }

  return {
    list() {
      return [...byId.values()];
    },
    get,
    require(providerId, authenticationId) {
      const provider = get(providerId, authenticationId);
      if (!provider) {
        throw new ConnectError("provider_not_found", `Unknown connector provider: ${providerId}`);
      }
      return provider;
    },
    describe(providerId) {
      this.require(providerId);
      return catalog.get(providerId)!;
    },
    catalog() {
      return [...catalog.values()];
    },
    validateScopes(providerId, scopes) {
      return assertAllowedScopes(this.require(providerId), scopes);
    },
  };
}

export function validateProviderId(providerId: string): void {
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(providerId)) {
    throw new ConnectError("invalid_provider", `Invalid connector provider id: ${providerId}`);
  }
}
