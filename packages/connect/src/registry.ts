import { ConnectError } from "./errors.js";
import { assertAllowedScopes } from "./scopes.js";
import { normalizeConnectorHttpPolicy } from "./http-policy.js";
import type { ConnectorProviderDefinition } from "./types.js";

export interface ConnectorRegistry {
  list(): ConnectorProviderDefinition[];
  get(providerId: string): ConnectorProviderDefinition | undefined;
  require(providerId: string): ConnectorProviderDefinition;
  validateScopes(providerId: string, scopes?: readonly string[]): string[];
}

export function createConnectorRegistry(providers: readonly ConnectorProviderDefinition[]): ConnectorRegistry {
  const byId = new Map<string, ConnectorProviderDefinition>();
  for (const provider of providers) {
    validateProviderId(provider.id);
    if (byId.has(provider.id)) {
      throw new ConnectError("invalid_provider", `Duplicate connector provider id: ${provider.id}`);
    }
    byId.set(provider.id, Object.freeze({
      ...provider,
      ...(provider.http ? { http: normalizeConnectorHttpPolicy(provider.http) } : {}),
    }));
  }

  return {
    list() {
      return [...byId.values()];
    },
    get(providerId) {
      return byId.get(providerId);
    },
    require(providerId) {
      const provider = byId.get(providerId);
      if (!provider) {
        throw new ConnectError("provider_not_found", `Unknown connector provider: ${providerId}`);
      }
      return provider;
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
