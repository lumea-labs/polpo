import {
  ConnectionSelectionError,
  createToolInvocationContext,
  assertAgentIdentity,
  type AgentSnapshot,
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
  /** Agent-scoped hosts must provide this live lookup. The expected identity
   * comes only from the invocation captured with the execution config. */
  getAgentSnapshot?(name: string): Promise<AgentSnapshot | undefined>;
  /** Trusted host state for resuming an acquired capability. Never take this from tool arguments. */
  selection?: ConnectionCapabilitySelection;
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
    /** Call after refresh/DNS waits and before each credential-bearing dispatch. */
    reauthorize: () => Promise<void>,
  ): Promise<ConnectionResponse<T>>;
  isConnectionVisible?(
    connection: ConnectionRecord,
    selector: ConnectionSelectionSelector,
  ): boolean | Promise<boolean>;
  policy?: ConnectPolicy;
}

/** Stored only by the host. It is deliberately absent from tool-visible capability properties. */
export interface ConnectionCapabilitySelection {
  readonly connectionId: string;
  readonly providerId: string;
  readonly audience: "personal" | "shared" | "end_user";
  readonly secretRef?: string;
  readonly credentialVersion?: string;
  readonly bindingKey: string;
}

const capabilitySelections = new WeakMap<ResolvedConnectionCapability, ConnectionCapabilitySelection>();

export function getConnectionCapabilitySelection(capability: ResolvedConnectionCapability): ConnectionCapabilitySelection | undefined {
  return capabilitySelections.get(capability);
}

/** Host-only snapshot for durable delegation. Never expose this to tools or
 * copy it into a sandbox: it includes credential installation references. */
export function snapshotConnectionCapabilitySelection(connection: ConnectionRecord): ConnectionCapabilitySelection {
  const binding = connection.binding;
  return Object.freeze({ connectionId: connection.id, providerId: connection.providerId,
    audience: effectiveConnectionAudience(connection), secretRef: connection.secretRef,
    credentialVersion: connection.credentialVersion,
    bindingKey: JSON.stringify([binding?.principal?.type, binding?.principal?.id, binding?.principal?.namespace,
      binding?.tenant?.namespace, binding?.tenant?.id, binding?.resource?.namespace, binding?.resource?.type,
      binding?.resource?.id, binding?.scopeEpoch, connection.owner?.type, connection.owner?.id,
      connection.owner?.type === "external_user" ? connection.owner.namespace : undefined]),
  });
}

export function matchesConnectionCapabilitySelection(connection: ConnectionRecord, expected: ConnectionCapabilitySelection): boolean {
  const current = snapshotConnectionCapabilitySelection(connection);
  return current.connectionId === expected.connectionId && current.providerId === expected.providerId
    && current.audience === expected.audience && current.secretRef === expected.secretRef
    && current.credentialVersion === expected.credentialVersion && current.bindingKey === expected.bindingKey;
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

/** Legacy installations are shared; ownership is never inferred from binding fields. */
export function effectiveConnectionAudience(connection: ConnectionRecord) {
  return connection.audience ?? "shared";
}

/** Grant bindings are additional constraints, not standalone account identities. */
export function matchesConnectionBindingAttributes(
  binding: ConnectionBindingAttributes | undefined,
  selector: ConnectionSelectionSelector,
): boolean {
  return !binding || (bindingPartMatches(binding.principal, selector.principal)
    && bindingPartMatches(binding.tenant, selector.tenant)
    && bindingPartMatches(binding.resource, selector.resource)
    && (binding.scopeEpoch === undefined || binding.scopeEpoch === selector.scopeEpoch));
}

/** Match account ownership and binding against a host-created selector. No fallback is performed. */
export function matchesConnectionBinding(
  connection: ConnectionRecord,
  selector: ConnectionSelectionSelector,
): boolean {
  const binding = connection.binding;
  // Pre-audience records retain their historical classification. A missing
  // user match must never silently become project-wide access.
  const audience = effectiveConnectionAudience(connection);
  if (selector.audience !== undefined && audience !== selector.audience) return false;
  if (audience === "personal") {
    if (!connection.owner || connection.owner.type !== "user"
      || selector.principal?.type !== "user" || selector.principal.id !== connection.owner.id) return false;
  }
  if (audience === "end_user") {
    const owner = connection.owner;
    if (owner?.type !== "external_user" || typeof owner.namespace !== "string" || !owner.namespace.trim()
      || !binding?.principal || binding.principal.type !== "external_user" || binding.principal.id !== owner.id
      || selector.principal?.type !== "external_user" || selector.principal.id !== owner.id
      || selector.principal.namespace !== owner.namespace) return false;
  }
  if (!binding) return selector.audience === "shared" || selector.audience === "personal";
  if (Object.keys(binding).length === 0) return false;
  return matchesConnectionBindingAttributes(binding, selector);
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
    !["projectId", "orgId", "principal", "tenant", "resource", "scopeEpoch", "audience"].includes(key));
  if (unsupported.length > 0) {
    throw new ConnectionSelectionError(
      "connection_slot_invalid",
      `Trusted Connection selector contains unsupported fields: ${unsupported.join(", ")}`,
    );
  }
  if (selector.audience !== undefined && !["personal", "shared", "end_user"].includes(selector.audience)) {
    throw new ConnectionSelectionError("connection_slot_invalid", "Trusted Connection selector audience is invalid");
  }
  const part = <T extends object>(
    name: string,
    value: T | undefined,
    fields: readonly (keyof T)[],
    optionalFields: readonly (keyof T)[] = [],
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
      !fields.includes(key as keyof T) && !optionalFields.includes(key as keyof T));
    if (unsupportedPart.length > 0) {
      throw new ConnectionSelectionError(
        "connection_slot_invalid",
        `Trusted Connection selector ${name} contains unsupported fields: ${unsupportedPart.join(", ")}`,
      );
    }
    const normalized = Object.fromEntries(
      [...fields, ...optionalFields.filter(field => value[field] !== undefined)].map((field) => [
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
    ...(selector.audience === undefined ? {} : { audience: selector.audience }),
    ...(selector.principal === undefined ? {} : {
      principal: part("principal", selector.principal, ["type", "id"], ["namespace"]),
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

/** Host-only authorization shared by HTTP and MCP. No credentials or protocol
 * operations are exposed here; consumers must call current() before transport use. */
export interface SelectedConnectionAccess {
  readonly input: ConnectionCapabilityResolveInput;
  readonly connection: ConnectionRecord;
  readonly selection: ConnectionCapabilitySelection;
  current(): Promise<ConnectionRecord>;
  dispose(): void;
}

export type ConnectionAccessResolverOptions = Pick<ConnectionCapabilityResolverOptions,
  "store" | "selection" | "resolveSelector" | "isConnectionVisible" | "policy" | "getAgentSnapshot">;

export function createConnectionAccessResolver(options: ConnectionAccessResolverOptions): {
  acquire(input: ConnectionCapabilityResolveInput): Promise<SelectedConnectionAccess>;
} {
  return {
    async acquire(original) {
      let input = original;
      try {
        input = Object.freeze({ ...original,
          spec: Object.freeze({ ...original.spec, scopes: Object.freeze([...original.spec.scopes]) }),
          invocation: createToolInvocationContext(original.invocation),
        });
        const assertCurrentAgent = async () => {
          if (!options.getAgentSnapshot) return;
          const expected = input.invocation.agent;
          if (!expected) throw new ConnectionSelectionError("connection_scope_denied", "An authoritative agent identity is required");
          const current = await options.getAgentSnapshot(expected.name);
          try { assertAgentIdentity(expected, current); }
          catch { throw new ConnectionSelectionError("connection_scope_denied", "The execution agent no longer exists or has been replaced"); }
        };
        if (input.signal?.aborted) throw new ConnectionSelectionError(
          "connection_scope_denied", "Connection invocation was cancelled", { slot: input.slot });
        await assertCurrentAgent();
        const selector = normalizeSelector(await options.resolveSelector(input));
        const resumed = options.selection ? await options.store.getConnection(options.selection.connectionId) : undefined;
        const listed = options.selection ? (resumed ? [resumed] : []) : await options.store.listConnections({
          ...(options.isConnectionVisible ? {} : { projectId: selector.projectId }),
          ...(selector.orgId ? { orgId: selector.orgId } : {}),
          ...(input.spec.provider ? { providerId: input.spec.provider } : {}),
          status: "active",
        });
        const candidates: ConnectionRecord[] = [];
        for (const connection of listed) {
          const visible = options.isConnectionVisible
            ? await options.isConnectionVisible(connection, selector)
            : connection.projectId === selector.projectId;
          if (
            connection.status === "active"
            && visible
            && (selector.orgId === undefined || connection.orgId === selector.orgId)
            && (input.spec.provider === undefined || connection.providerId === input.spec.provider)
            && matchesConnectionBinding(connection, selector)
            && (!options.selection || matchesConnectionCapabilitySelection(connection, options.selection))
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
        await assertCurrentAgent();
        let disposed = false;
        const identity = snapshotConnectionCapabilitySelection(selected);
        const capabilityScopes = input.spec.scopes;
        return {
          input, connection: selected, selection: identity,
          dispose: () => { disposed = true; },
          current: async () => {
            let current: ConnectionRecord;
            try {
              if (disposed || input.signal?.aborted) throw new ConnectionSelectionError(
                "connection_scope_denied", "Connection capability is no longer active", { slot: input.slot },
              );
              const found = await options.store.getConnection(identity.connectionId);
              const visible = found && (options.isConnectionVisible
                ? await options.isConnectionVisible(found, selector)
                : found.projectId === selector.projectId);
              if (!found || found.status !== "active" || !visible
                || !matchesConnectionCapabilitySelection(found, identity)
                || (selector.orgId !== undefined && found.orgId !== selector.orgId)
                || !matchesConnectionBinding(found, selector)) {
                throw new ConnectionSelectionError("connection_not_found_for_scope", "Selected Connection is no longer available", { slot: input.slot });
              }
              const allowed = hasScopes(found.grantedScopes, capabilityScopes) && (await options.policy?.canUseConnection({
                connection: found,
                ...(input.invocation.user ? { subject: { type: "user" as const, id: input.invocation.user } } : {}),
                scopes: [...capabilityScopes], actionId: input.toolName,
              }) ?? true);
              if (!allowed || disposed || input.signal?.aborted) throw new ConnectionSelectionError(
                "connection_scope_denied", "Connection permission is no longer valid", { slot: input.slot },
              );
              await assertCurrentAgent();
              if (disposed || input.signal?.aborted) throw new ConnectionSelectionError(
                "connection_scope_denied", "Connection capability is no longer active", { slot: input.slot });
              current = found;
            } catch (error) {
              if (error instanceof ConnectionSelectionError) throw error;
              throw new ConnectionSelectionError("connection_resolver_unavailable", "Connection authorization could not be rechecked", { slot: input.slot, cause: error });
            }
            return current;
          },
        };
      } catch (error) {
        if (error instanceof ConnectionSelectionError) throw error;
        throw new ConnectionSelectionError("connection_resolver_unavailable",
          `Trusted Connection resolution failed for slot "${input.slot}"`, { slot: input.slot, cause: error });
      }
    },
  };
}

export function createConnectionCapabilityResolver(
  options: ConnectionCapabilityResolverOptions,
): ConnectionCapabilityResolver {
  const accessResolver = createConnectionAccessResolver(options);
  return {
    async resolve(original) {
      let access: SelectedConnectionAccess | undefined;
      try {
        access = await accessResolver.acquire(original);
        const input = access.input;
        const selected = access.connection;
        const mode = input.spec.mode ?? "legacy_credentials";
        if (mode === "gateway") {
          if (!options.request) throw new ConnectionSelectionError("connection_resolver_unavailable",
            `Connection gateway is unavailable for slot "${input.slot}"`, { slot: input.slot });
          const acquired = access;
          const capability: ResolvedConnectionCapability = {
            mode, providerId: selected.providerId, scopes: input.spec.scopes,
            dispose: () => acquired.dispose(),
            request: async <T = unknown>(request: ConnectionRequest) => {
              const current = await acquired.current();
              return options.request!<T>(current, input, request, async () => { await acquired.current(); });
            },
          };
          capabilitySelections.set(capability, acquired.selection);
          return capability;
        }
        if (!options.materialize) throw new ConnectionSelectionError("connection_resolver_unavailable",
          `Legacy credential materialization is unavailable for slot "${input.slot}"`, { slot: input.slot });
        await access.current();
        const credential = await options.materialize(selected, input);
        await access.current();
        const capability = credentialCapability(credential);
        access.dispose();
        return capability;
      } catch (error) {
        access?.dispose();
        if (error instanceof ConnectionSelectionError) throw error;
        throw new ConnectionSelectionError("connection_resolver_unavailable",
          `Trusted Connection resolution failed for slot "${original.slot}"`, { slot: original.slot, cause: error });
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
          ? async (connection, resolveInput, request, reauthorize) => {
              assertApplicationOperationAllowed(input.spec.allowedOperations, request, input.spec.scopes);
              return options.request!(connection, resolveInput, request, reauthorize);
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
