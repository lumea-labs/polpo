import {
  ConnectionSelectionError,
  type ConnectionCapabilityResolver,
  type ConnectionCapabilityResolveInput,
  type ConnectionRequest,
  type ConnectionResponse,
  type ResolvedConnectionCapability,
  type ApplicationCapabilityResolveInput,
  type ApplicationCapabilityResolver,
  type ConnectionOperationPolicy,
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
  materialize?(
    connection: ConnectionRecord,
    input: ConnectionCapabilityResolveInput,
  ): ResolvedConnectionCredential | Promise<ResolvedConnectionCredential>;
  request?<T = unknown>(
    connection: ConnectionRecord,
    input: ConnectionCapabilityResolveInput,
    request: ConnectionRequest,
  ): Promise<ConnectionResponse<T>>;
  isConnectionVisible?(
    connection: ConnectionRecord,
    selector: ConnectionSelectionSelector,
  ): boolean | Promise<boolean>;
  policy?: ConnectPolicy;
}

export interface ApplicationCapabilityResolverOptions extends Omit<
  ConnectionCapabilityResolverOptions,
  "resolveSelector"
> {
  resolveSelector(
    input: ApplicationCapabilityResolveInput,
  ): ConnectionSelectionSelector | Promise<ConnectionSelectionSelector>;
}

function bindingPartMatches<T extends object>(
  binding: T | undefined,
  selector: T | undefined,
): boolean {
  if (!binding) return true;
  if (!selector) return false;
  const bindingRecord = binding as Record<string, unknown>;
  const selectorRecord = selector as Record<string, unknown>;
  return Object.keys(bindingRecord).every(
    (key) => bindingRecord[key] === selectorRecord[key],
  );
}

function bindingMatches(
  binding: ConnectionBindingAttributes | undefined,
  selector: ConnectionSelectionSelector,
): boolean {
  if (!binding) return false;
  return bindingPartMatches(binding.principal, selector.principal)
    && bindingPartMatches(binding.tenant, selector.tenant)
    && bindingPartMatches(binding.resource, selector.resource)
    && (binding.scopeEpoch === undefined
      || binding.scopeEpoch === selector.scopeEpoch);
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
    mode: "legacy_credentials",
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
        const listed = await options.store.listConnections({
          ...(options.isConnectionVisible ? {} : { projectId: selector.projectId }),
          ...(selector.orgId ? { orgId: selector.orgId } : {}),
          ...(input.spec.provider ? { providerId: input.spec.provider } : {}),
          status: "active",
        });
        const candidates: ConnectionRecord[] = [];
        for (const connection of listed) {
          const visible = connection.projectId === selector.projectId
            || await options.isConnectionVisible?.(connection, selector) === true;
          if (
            connection.status === "active"
            && visible
            && (selector.orgId === undefined || connection.orgId === selector.orgId)
            && (input.spec.provider === undefined || connection.providerId === input.spec.provider)
            && bindingMatches(connection.binding, selector)
          ) {
            candidates.push(connection);
          }
        }

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

        const selected = authorized[0];
        const mode = input.spec.mode ?? "legacy_credentials";
        if (mode === "gateway") {
          if (!options.request) {
            throw new ConnectionSelectionError(
              "connection_resolver_unavailable",
              `Connection gateway is unavailable for slot "${input.slot}"`,
              { slot: input.slot },
            );
          }
          return {
            mode,
            providerId: selected.providerId,
            scopes: Object.freeze([...selected.grantedScopes]),
            request: <T = unknown>(request: ConnectionRequest) =>
              options.request!<T>(selected, input, request),
          };
        }
        if (!options.materialize) {
          throw new ConnectionSelectionError(
            "connection_resolver_unavailable",
            `Legacy credential materialization is unavailable for slot "${input.slot}"`,
            { slot: input.slot },
          );
        }
        return credentialCapability(await options.materialize(selected, input));
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

export function createApplicationCapabilityResolver(
  options: ApplicationCapabilityResolverOptions,
): ApplicationCapabilityResolver {
  return {
    async resolve(input) {
      const id = input.spec?.id?.trim();
      const provider = input.spec?.provider?.trim();
      if (!id || !provider || !Array.isArray(input.spec.scopes) || input.spec.scopes.length === 0) {
        throw new ConnectionSelectionError(
          "connection_slot_invalid",
          "Application capability id, provider, and scopes are required",
        );
      }
      const resolver = createConnectionCapabilityResolver({
        ...options,
        resolveSelector: () => options.resolveSelector(input),
        request: options.request
          ? async (connection, resolveInput, request) => {
              assertApplicationOperationAllowed(input.spec.allowedOperations, request, input.spec.scopes);
              return options.request!(connection, resolveInput, request);
            }
          : undefined,
      });
      return resolver.resolve({
        slot: id,
        spec: {
          provider,
          scopes: input.spec.scopes,
          description: `Application capability ${id}`,
          mode: "gateway",
        },
        toolName: `application:${id}`,
        toolCallId: `${input.invocation.runId}:${id}`,
        invocation: input.invocation,
        signal: input.signal,
      });
    },
  };
}

function assertApplicationOperationAllowed(
  policies: readonly ConnectionOperationPolicy[] | undefined,
  request: ConnectionRequest,
  capabilityScopes: readonly string[],
): void {
  if (!policies || policies.length === 0) return;
  const method = request.method.trim().toUpperCase();
  const allowed = policies.some((policy) => {
    if (policy.methods && !policy.methods.some((candidate) => candidate.toUpperCase() === method)) return false;
    if (policy.pathPatterns && !policy.pathPatterns.some((pattern) =>
      pattern.endsWith("*") ? request.path.startsWith(pattern.slice(0, -1)) : request.path === pattern)) return false;
    return !policy.requiredScopes || hasScopes(capabilityScopes, policy.requiredScopes);
  });
  if (!allowed) {
    throw new ConnectionSelectionError(
      "connection_operation_denied",
      `Application Connection operation is not allowed: ${method} ${request.path}`,
    );
  }
}
