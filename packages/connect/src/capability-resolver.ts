import {
  ConnectionSelectionError,
  type ConnectionCapabilityResolver,
  type ConnectionCapabilityResolveInput,
  type ResolvedConnectionCapability,
} from "@polpo-ai/core";

import { hasScopes } from "./scopes.js";
import type {
  ConnectionBindingAttributes,
  ConnectionRecord,
  ConnectionSelectionSelector,
  ConnectPolicy,
  ConnectStore,
  ResolvedConnectionCredential,
} from "./types.js";

export interface ConnectionCapabilityResolverOptions {
  store: ConnectStore;
  resolveSelector(
    input: ConnectionCapabilityResolveInput,
  ): ConnectionSelectionSelector | Promise<ConnectionSelectionSelector>;
  materialize(
    connection: ConnectionRecord,
    input: ConnectionCapabilityResolveInput,
  ): ResolvedConnectionCredential | Promise<ResolvedConnectionCredential>;
  policy?: ConnectPolicy;
}

function samePart<T extends object>(
  left: T | undefined,
  right: T | undefined,
): boolean {
  if (!left || !right) return left === right;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)]);
  return [...keys].every((key) => leftRecord[key] === rightRecord[key]);
}

function bindingMatches(
  binding: ConnectionBindingAttributes | undefined,
  selector: ConnectionSelectionSelector,
): boolean {
  if (!binding) return false;
  return samePart(binding.principal, selector.principal)
    && samePart(binding.tenant, selector.tenant)
    && samePart(binding.resource, selector.resource)
    && binding.scopeEpoch === selector.scopeEpoch;
}

function requiredText(name: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ConnectionSelectionError(
      "connection_slot_invalid",
      `Trusted Connection selector ${name} is required`,
    );
  }
  return value.trim();
}

function normalizeSelector(selector: ConnectionSelectionSelector): ConnectionSelectionSelector {
  if (
    !selector
    || typeof selector !== "object"
    || Array.isArray(selector)
    || (Object.getPrototypeOf(selector) !== Object.prototype
      && Object.getPrototypeOf(selector) !== null)
  ) {
    throw new ConnectionSelectionError(
      "connection_slot_invalid",
      "Trusted Connection selector must be an object",
    );
  }
  const unsupported = Object.keys(selector).filter((key) =>
    !["projectId", "orgId", "principal", "tenant", "resource", "scopeEpoch"].includes(key));
  if (unsupported.length > 0) {
    throw new ConnectionSelectionError(
      "connection_slot_invalid",
      `Trusted Connection selector contains unsupported fields: ${unsupported.join(", ")}`,
    );
  }
  const part = <T extends object>(
    name: string,
    value: T | undefined,
    fields: readonly (keyof T)[],
  ): T | undefined => {
    if (value === undefined) return undefined;
    if (
      !value
      || typeof value !== "object"
      || Array.isArray(value)
      || (Object.getPrototypeOf(value) !== Object.prototype
        && Object.getPrototypeOf(value) !== null)
    ) {
      throw new ConnectionSelectionError(
        "connection_slot_invalid",
        `Trusted Connection selector ${name} is invalid`,
      );
    }
    const unsupportedPart = Object.keys(value).filter((key) =>
      !fields.includes(key as keyof T));
    if (unsupportedPart.length > 0) {
      throw new ConnectionSelectionError(
        "connection_slot_invalid",
        `Trusted Connection selector ${name} contains unsupported fields: ${unsupportedPart.join(", ")}`,
      );
    }
    const normalized = Object.fromEntries(
      fields.map((field) => [
        field,
        requiredText(
          `${name}.${String(field)}`,
          (value as Record<string, unknown>)[String(field)],
        ),
      ]),
    );
    return Object.freeze(normalized) as T;
  };
  return Object.freeze({
    projectId: requiredText("projectId", selector.projectId),
    ...(selector.orgId === undefined ? {} : { orgId: requiredText("orgId", selector.orgId) }),
    ...(selector.principal === undefined ? {} : {
      principal: part("principal", selector.principal, ["type", "id"]),
    }),
    ...(selector.tenant === undefined ? {} : {
      tenant: part("tenant", selector.tenant, ["namespace", "id"]),
    }),
    ...(selector.resource === undefined ? {} : {
      resource: part("resource", selector.resource, ["namespace", "type", "id"]),
    }),
    ...(selector.scopeEpoch === undefined
      ? {}
      : { scopeEpoch: requiredText("scopeEpoch", selector.scopeEpoch) }),
  });
}

function credentialCapability(
  credential: ResolvedConnectionCredential,
): ResolvedConnectionCapability {
  const metadata = credential.metadata;
  const apiKeyHeader = metadata && typeof metadata.headerName === "string"
    ? metadata.headerName
    : "Authorization";
  const token = credential.kind === "api_key"
    ? credential.value
    : credential.kind === "oauth2" || credential.kind === "mcp"
      ? credential.accessToken
      : undefined;
  const tokenType = credential.kind === "oauth2" || credential.kind === "mcp"
    ? credential.tokenType ?? "Bearer"
    : "Bearer";
  return {
    providerId: credential.providerId,
    scopes: credential.scopes,
    getHeaders: () => token
      ? {
          [apiKeyHeader]: apiKeyHeader.toLowerCase() === "authorization"
            ? `${tokenType} ${token}`
            : token,
        }
      : undefined,
    getToken: () => token,
    getKey: () => credential.kind === "api_key" ? credential.value : undefined,
  };
}

export function createConnectionCapabilityResolver(
  options: ConnectionCapabilityResolverOptions,
): ConnectionCapabilityResolver {
  return {
    async resolve(input) {
      try {
        const selector = normalizeSelector(await options.resolveSelector(input));
        const candidates = (await options.store.listConnections({
          projectId: selector.projectId,
          ...(selector.orgId ? { orgId: selector.orgId } : {}),
          ...(input.spec.provider ? { providerId: input.spec.provider } : {}),
          status: "active",
        })).filter((connection) =>
          connection.status === "active"
          && connection.projectId === selector.projectId
          && (selector.orgId === undefined || connection.orgId === selector.orgId)
          && (input.spec.provider === undefined || connection.providerId === input.spec.provider)
          && bindingMatches(connection.binding, selector));

        if (candidates.length === 0) {
          throw new ConnectionSelectionError(
            "connection_not_found_for_scope",
            `No active Connection matches slot "${input.slot}"`,
            { slot: input.slot },
          );
        }

        const authorized: ConnectionRecord[] = [];
        for (const connection of candidates) {
          if (!hasScopes(connection.grantedScopes, input.spec.scopes)) continue;
          const allowed = await options.policy?.canUseConnection({
            connection,
            ...(input.invocation.user
              ? { subject: { type: "user" as const, id: input.invocation.user } }
              : {}),
            scopes: [...input.spec.scopes],
            actionId: input.toolName,
          }) ?? true;
          if (allowed) authorized.push(connection);
        }
        if (authorized.length === 0) {
          throw new ConnectionSelectionError(
            "connection_scope_denied",
            `Connection scope was denied for slot "${input.slot}"`,
            { slot: input.slot },
          );
        }
        if (authorized.length > 1) {
          throw new ConnectionSelectionError(
            "connection_selection_ambiguous",
            `More than one Connection matches slot "${input.slot}"`,
            { slot: input.slot },
          );
        }

        return credentialCapability(await options.materialize(authorized[0], input));
      } catch (error) {
        if (error instanceof ConnectionSelectionError) throw error;
        throw new ConnectionSelectionError(
          "connection_resolver_unavailable",
          `Trusted Connection resolution failed for slot "${input.slot}"`,
          { slot: input.slot, cause: error },
        );
      }
    },
  };
}
