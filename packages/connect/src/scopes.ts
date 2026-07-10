import { ConnectError } from "./errors.js";
import type { ConnectorProviderDefinition } from "./types.js";

export function normalizeScopes(scopes: readonly string[] | undefined): string[] {
  if (!scopes?.length) return [];
  const normalized = scopes.map((scope) => scope.trim()).filter(Boolean);
  return [...new Set(normalized)].sort((a, b) => a.localeCompare(b));
}

export function hasScopes(grantedScopes: readonly string[], requestedScopes: readonly string[]): boolean {
  const granted = new Set(normalizeScopes(grantedScopes));
  return normalizeScopes(requestedScopes).every((scope) => granted.has(scope));
}

export function assertAllowedScopes(provider: ConnectorProviderDefinition, scopes: readonly string[] | undefined): string[] {
  const normalized = normalizeScopes(scopes);
  if (provider.allowCustomScopes) return normalized;

  const allowed = new Set((provider.scopes ?? []).map((scope) => scope.id));
  const invalid = normalized.filter((scope) => !allowed.has(scope));
  if (invalid.length > 0) {
    throw new ConnectError("invalid_scope", `Provider "${provider.id}" does not allow scopes: ${invalid.join(", ")}`, {
      details: { providerId: provider.id, invalidScopes: invalid },
    });
  }

  return normalized;
}

export function assertGrantedScopes(grantedScopes: readonly string[], requestedScopes: readonly string[]): string[] {
  const normalized = normalizeScopes(requestedScopes);
  if (!hasScopes(grantedScopes, normalized)) {
    const granted = new Set(normalizeScopes(grantedScopes));
    const missing = normalized.filter((scope) => !granted.has(scope));
    throw new ConnectError("invalid_scope", `Connection is missing required scopes: ${missing.join(", ")}`, {
      details: { missingScopes: missing },
    });
  }
  return normalized;
}
