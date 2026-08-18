import type { ChannelProviderId } from "../types.js";
import type {
  ChannelConnectionResolver,
  ChannelManagementEvent,
  ChannelManagementScope,
  ChannelManagementStore,
  ChannelProviderAutomation,
  ChannelProviderDescriptor,
  ChannelProvisioningResult,
  ChannelSecureSetupCoordinator,
  ConfigureConversationChannelInput,
  ConversationChannel,
  ConversationChannelQuery,
  ConversationChannelRoute,
  ConversationChannelSettingsPatch,
  RedactedChannelConnection,
  SecureChannelSetupAction,
  TestConversationChannelInput,
  UpdateConversationChannelInput,
  UpsertConversationChannelRouteInput,
} from "./contracts.js";
import { ChannelManagementError, channelSetupError } from "./errors.js";
import { channelProviderCatalog } from "./provider-catalog.js";

export type ChannelManagementServiceOptions = {
  agentExists: (scope: ChannelManagementScope, agentName: string) => Promise<boolean>;
  connectionResolver: ChannelConnectionResolver;
  createId?: (kind: "channel" | "route") => string;
  now?: () => Date | string;
  providerAutomation: ChannelProviderAutomation;
  providerCatalog?: readonly ChannelProviderDescriptor[];
  secureSetup?: ChannelSecureSetupCoordinator;
  store: ChannelManagementStore;
  validateSettings?: (
    scope: ChannelManagementScope,
    settings: NonNullable<ConfigureConversationChannelInput["settings"]> | ConversationChannelSettingsPatch,
    channelId?: string,
  ) => Promise<void>;
  onEvent?: (event: ChannelManagementEvent) => void | Promise<void>;
  onEventError?: (error: unknown, event: ChannelManagementEvent) => void;
};

function timestamp(now: () => Date | string): string {
  const value = now();
  return typeof value === "string" ? value : value.toISOString();
}

function assertIdentifier(value: unknown, label: string, max = 256): string {
  if (typeof value !== "string") {
    throw new ChannelManagementError("INVALID_ARGUMENT", `${label} is invalid`, 400);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > max || normalized.includes("\u0000")) {
    throw new ChannelManagementError("INVALID_ARGUMENT", `${label} is invalid`, 400);
  }
  return normalized;
}

function assertScope(scope: ChannelManagementScope): void {
  assertIdentifier(scope.projectId, "projectId");
  assertIdentifier(scope.actorId, "actorId");
  if (scope.orgId !== undefined) assertIdentifier(scope.orgId, "orgId");
}

function assertSetupAction(action: SecureChannelSetupAction): SecureChannelSetupAction {
  let url: URL;
  try {
    url = new URL(action.url);
  } catch {
    throw new ChannelManagementError("INVALID_SETUP_URL", "Secure setup URL is invalid", 500);
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (
    (url.protocol !== "https:" && !(local && url.protocol === "http:"))
    || url.username
    || url.password
    || url.hash
  ) {
    throw new ChannelManagementError("INVALID_SETUP_URL", "Secure setup URL is not allowed", 500);
  }
  for (const key of url.searchParams.keys()) {
    if (/token|secret|password|credential|api[_-]?key|oauth[_-]?code/i.test(key)) {
      throw new ChannelManagementError("INVALID_SETUP_URL", "Secure setup URL contains credential-like data", 500);
    }
  }
  if (!Number.isFinite(Date.parse(action.expiresAt))) {
    throw new ChannelManagementError("INVALID_SETUP_EXPIRY", "Secure setup expiry is invalid", 500);
  }
  return {
    setupId: assertIdentifier(action.setupId, "setupId"),
    url: url.toString(),
    expiresAt: action.expiresAt,
  };
}

function assertRedactedConnection(value: RedactedChannelConnection): RedactedChannelConnection {
  if (!["active", "pending", "revoked", "error"].includes(value.status)) {
    throw new ChannelManagementError("INVALID_CONNECTION", "Connection status is invalid", 500);
  }
  return {
    id: assertIdentifier(value.id, "connection.id"),
    providerId: assertIdentifier(value.providerId, "connection.providerId"),
    status: value.status,
    ...(value.name ? { name: assertIdentifier(value.name, "connection.name") } : {}),
  };
}

function redactRequirements<T extends Readonly<{ code: string; label: string; url?: string }>>(
  requirements: readonly T[],
): ReadonlyArray<{ code: string; label: string; url?: string }> {
  return requirements.map((requirement) => ({
    code: assertIdentifier(requirement.code, "requirement.code"),
    label: assertIdentifier(requirement.label, "requirement.label", 512),
    ...(requirement.url ? { url: requirement.url } : {}),
  }));
}

function defaultId(kind: "channel" | "route"): string {
  return `${kind}-${crypto.randomUUID()}`;
}

export class ChannelManagementService {
  readonly options: Required<Pick<ChannelManagementServiceOptions, "agentExists" | "connectionResolver" | "providerAutomation" | "store">>
    & Omit<ChannelManagementServiceOptions, "agentExists" | "connectionResolver" | "providerAutomation" | "store">;

  private readonly inflight = new Map<string, Promise<ChannelProvisioningResult>>();
  private readonly createId: (kind: "channel" | "route") => string;
  private readonly now: () => Date | string;
  private readonly providers: Map<ChannelProviderId, ChannelProviderDescriptor>;

  constructor(options: ChannelManagementServiceOptions) {
    this.options = options;
    this.createId = options.createId ?? defaultId;
    this.now = options.now ?? (() => new Date());
    this.providers = new Map(
      (options.providerCatalog ?? channelProviderCatalog()).map((provider) => [provider.id, provider]),
    );
  }

  listProviders(): readonly ChannelProviderDescriptor[] {
    return [...this.providers.values()].map((provider) => structuredClone(provider));
  }

  list(
    scope: ChannelManagementScope,
    query?: ConversationChannelQuery,
  ): Promise<ConversationChannel[]> {
    assertScope(scope);
    return this.options.store.listChannels(scope, query);
  }

  async get(scope: ChannelManagementScope, channelId: string): Promise<ConversationChannel> {
    assertScope(scope);
    const channel = await this.options.store.getChannel(scope, assertIdentifier(channelId, "channelId"));
    if (!channel) throw new ChannelManagementError("CHANNEL_NOT_FOUND", "Channel not found", 404);
    return channel;
  }

  configure(
    scope: ChannelManagementScope,
    input: ConfigureConversationChannelInput,
  ): Promise<ChannelProvisioningResult> {
    assertScope(scope);
    const idempotencyKey = assertIdentifier(input.idempotencyKey, "idempotencyKey", 512);
    const key = `${scope.orgId ?? ""}\u0000${scope.projectId}\u0000${scope.actorId}\u0000${idempotencyKey}`;
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const normalizedInput = { ...input, idempotencyKey };
    const operation = this.emitConfigure(scope, normalizedInput, { outcome: "started" })
      .then(() => this.configureOnce(scope, normalizedInput))
      .then(async (result) => {
        await this.emitConfigure(scope, normalizedInput, this.eventFromResult(result));
        return result;
      })
      .catch(async (error) => {
        await this.emitConfigure(scope, normalizedInput, {
          outcome: "failed",
          errorCode: error instanceof ChannelManagementError
            ? error.code
            : "CHANNEL_SETUP_FAILED",
        });
        throw error;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, operation);
    return operation;
  }

  private async configureOnce(
    scope: ChannelManagementScope,
    input: ConfigureConversationChannelInput,
  ): Promise<ChannelProvisioningResult> {
    const provider = this.providers.get(input.provider);
    if (!provider || provider.availability === "unsupported") {
      throw new ChannelManagementError("PROVIDER_UNSUPPORTED", "Channel provider is unsupported", 400);
    }
    if (provider.availability !== "available") {
      throw new ChannelManagementError("PROVIDER_DISABLED", "Channel provider is disabled", 403);
    }
    const agentName = assertIdentifier(input.agentName, "agentName");
    if (!await this.options.agentExists(scope, agentName)) {
      throw new ChannelManagementError("AGENT_NOT_FOUND", "Agent not found", 404);
    }
    if (input.settings && this.options.validateSettings) {
      await this.options.validateSettings(scope, input.settings);
    }
    if (!input.connectionId) {
      if (!this.options.secureSetup) {
        throw new ChannelManagementError(
          "SECURE_SETUP_UNAVAILABLE",
          "Secure Channel setup is not configured",
          501,
        );
      }
      const setup = assertSetupAction(await this.options.secureSetup.begin({
        scope,
        provider: input.provider,
        agentName,
        idempotencyKey: input.idempotencyKey,
        requestedConfig: {
          ...(input.externalChannelId === undefined ? {} : { externalChannelId: input.externalChannelId }),
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.priority === undefined ? {} : { priority: input.priority }),
          ...(input.settings === undefined ? {} : { settings: input.settings }),
        },
      }));
      return { status: "setup_required", setup };
    }

    const connectionId = assertIdentifier(input.connectionId, "connectionId");
    const inspectedConnection = await this.options.connectionResolver.inspect(scope, connectionId);
    if (!inspectedConnection) throw new ChannelManagementError("CONNECTION_NOT_FOUND", "Connection not found", 404);
    const connection = assertRedactedConnection(inspectedConnection);
    if (connection.status !== "active") {
      throw new ChannelManagementError("CONNECTION_INACTIVE", "Connection is not active", 409);
    }
    if (connection.providerId !== provider.connectionProvider) {
      throw new ChannelManagementError(
        "CONNECTION_PROVIDER_MISMATCH",
        "Connection does not belong to this Channel provider",
        409,
      );
    }
    await this.options.connectionResolver.validateForProvider(scope, connectionId, input.provider);

    const prepared = await this.options.providerAutomation.prepare({
      scope,
      provider: input.provider,
      connection,
      externalChannelId: input.externalChannelId?.trim() || undefined,
      idempotencyKey: input.idempotencyKey,
    });
    if (prepared.status === "pending_external") {
      return {
        status: "pending_external",
        requirements: redactRequirements(prepared.requirements),
        ...(prepared.setup ? { setup: assertSetupAction(prepared.setup) } : {}),
      };
    }
    if (prepared.status === "verifying") {
      return { status: "verifying", setupId: assertIdentifier(prepared.setupId, "setupId") };
    }

    const externalChannelId = assertIdentifier(prepared.externalChannelId, "externalChannelId");
    const now = timestamp(this.now);
    const channel = await this.options.store.createOrReuseChannel(scope, {
      id: this.createId("channel"),
      idempotencyKey: input.idempotencyKey,
      provider: input.provider,
      connectionId,
      externalChannelId,
      name: input.name?.trim() || `${provider.label} channel`,
      settings: input.settings ?? {},
      status: "pending",
      timestamp: now,
    });
    const route = await this.options.store.upsertRoute(scope, {
      id: this.createId("route"),
      channelId: channel.id,
      agentName,
      externalChannelId,
      enabled: true,
      priority: input.priority ?? 100,
      timestamp: now,
    });

    if (channel.status === "active") return { status: "ready", channel, route };

    try {
      const activation = await this.options.providerAutomation.activate({
        scope,
        provider: input.provider,
        connection,
        channel,
        route,
        idempotencyKey: input.idempotencyKey,
      });
      if (activation.status === "pending_external") {
        return {
          status: "pending_external",
          channel,
          requirements: redactRequirements(activation.requirements),
          route,
          ...(activation.setup ? { setup: assertSetupAction(activation.setup) } : {}),
        };
      }
      if (activation.status === "verifying") {
        return { status: "verifying", setupId: assertIdentifier(activation.setupId, "setupId") };
      }
      const active = await this.options.store.updateChannel(scope, channel.id, {
        status: "active",
        timestamp: timestamp(this.now),
      });
      if (!active) throw new ChannelManagementError("CHANNEL_NOT_FOUND", "Channel disappeared during setup", 409);
      return { status: "ready", channel: active, route };
    } catch (error) {
      await this.options.store.updateChannel(scope, channel.id, {
        status: "error",
        timestamp: timestamp(this.now),
      });
      return { status: "failed", error: channelSetupError(error) };
    }
  }

  async update(
    scope: ChannelManagementScope,
    channelId: string,
    patch: UpdateConversationChannelInput,
  ): Promise<ConversationChannel> {
    assertScope(scope);
    if (patch.name !== undefined) assertIdentifier(patch.name, "name");
    const normalizedChannelId = assertIdentifier(channelId, "channelId");
    if (patch.settings && this.options.validateSettings) {
      await this.options.validateSettings(scope, patch.settings, normalizedChannelId);
    }
    const updated = await this.options.store.updateChannel(scope, normalizedChannelId, {
      ...patch,
      timestamp: timestamp(this.now),
    });
    if (!updated) throw new ChannelManagementError("CHANNEL_NOT_FOUND", "Channel not found", 404);
    return updated;
  }

  async remove(scope: ChannelManagementScope, channelId: string): Promise<{ removed: true }> {
    assertScope(scope);
    if (!await this.options.store.removeChannel(scope, assertIdentifier(channelId, "channelId"))) {
      throw new ChannelManagementError("CHANNEL_NOT_FOUND", "Channel not found", 404);
    }
    return { removed: true };
  }

  listRoutes(scope: ChannelManagementScope, channelId: string): Promise<ConversationChannelRoute[]> {
    assertScope(scope);
    return this.options.store.listRoutes(scope, assertIdentifier(channelId, "channelId"));
  }

  async upsertRoute(
    scope: ChannelManagementScope,
    input: UpsertConversationChannelRouteInput,
  ): Promise<ConversationChannelRoute> {
    assertScope(scope);
    const channel = await this.get(scope, input.channelId);
    const agentName = assertIdentifier(input.agentName, "agentName");
    if (!await this.options.agentExists(scope, agentName)) {
      throw new ChannelManagementError("AGENT_NOT_FOUND", "Agent not found", 404);
    }
    return this.options.store.upsertRoute(scope, {
      id: this.createId("route"),
      channelId: channel.id,
      agentName,
      externalChannelId: input.externalChannelId === undefined
        ? channel.externalChannelId
        : input.externalChannelId,
      enabled: input.enabled ?? true,
      priority: input.priority ?? 100,
      timestamp: timestamp(this.now),
    });
  }

  async removeRoute(
    scope: ChannelManagementScope,
    routeId: string,
    channelId?: string,
  ): Promise<{ removed: true }> {
    assertScope(scope);
    const normalizedRouteId = assertIdentifier(routeId, "routeId");
    if (channelId !== undefined) {
      const routes = await this.listRoutes(scope, assertIdentifier(channelId, "channelId"));
      if (!routes.some((route) => route.id === normalizedRouteId)) {
        throw new ChannelManagementError("ROUTE_NOT_FOUND", "Channel route not found", 404);
      }
    }
    if (!await this.options.store.removeRoute(scope, normalizedRouteId)) {
      throw new ChannelManagementError("ROUTE_NOT_FOUND", "Channel route not found", 404);
    }
    return { removed: true };
  }

  async test(
    scope: ChannelManagementScope,
    channelId: string,
    input: TestConversationChannelInput = {},
  ): Promise<{ message?: string; success: boolean }> {
    const channel = await this.get(scope, channelId);
    if (channel.status !== "active") {
      throw new ChannelManagementError("CHANNEL_INACTIVE", "Channel is not active", 409);
    }
    const inspectedConnection = await this.options.connectionResolver.inspect(scope, channel.connectionId);
    if (!inspectedConnection) {
      throw new ChannelManagementError("CONNECTION_INACTIVE", "Connection is not active", 409);
    }
    const connection = assertRedactedConnection(inspectedConnection);
    if (connection.status !== "active") {
      throw new ChannelManagementError("CONNECTION_INACTIVE", "Connection is not active", 409);
    }
    const recipient = input.recipient === undefined
      ? undefined
      : assertIdentifier(input.recipient, "recipient", 512);
    return this.options.providerAutomation.test({ scope, channel, connection, recipient });
  }

  setupStatus(scope: ChannelManagementScope, setupId: string): Promise<ChannelProvisioningResult> {
    assertScope(scope);
    if (!this.options.secureSetup) {
      throw new ChannelManagementError("SECURE_SETUP_UNAVAILABLE", "Secure Channel setup is not configured", 501);
    }
    return this.options.secureSetup.get(scope, assertIdentifier(setupId, "setupId"));
  }

  private eventFromResult(result: ChannelProvisioningResult): Pick<
    ChannelManagementEvent,
    "channelId" | "errorCode" | "outcome" | "routeId" | "setupId"
  > {
    switch (result.status) {
      case "ready":
        return {
          outcome: "ready",
          channelId: result.channel.id,
          routeId: result.route.id,
        };
      case "setup_required":
        return { outcome: "setup_required", setupId: result.setup.setupId };
      case "pending_external":
        return {
          outcome: "pending_external",
          ...(result.channel ? { channelId: result.channel.id } : {}),
          ...(result.route ? { routeId: result.route.id } : {}),
          ...(result.setup ? { setupId: result.setup.setupId } : {}),
        };
      case "verifying":
        return { outcome: "verifying", setupId: result.setupId };
      case "failed":
        return {
          outcome: "failed",
          errorCode: result.error.code,
          ...(result.setupId ? { setupId: result.setupId } : {}),
        };
    }
  }

  private async emitConfigure(
    scope: ChannelManagementScope,
    input: ConfigureConversationChannelInput,
    details: Pick<
      ChannelManagementEvent,
      "outcome"
    > & Partial<Pick<
      ChannelManagementEvent,
      "channelId" | "errorCode" | "routeId" | "setupId"
    >>,
  ): Promise<void> {
    if (!this.options.onEvent) return;
    const event: ChannelManagementEvent = {
      operation: "configure",
      outcome: details.outcome,
      timestamp: timestamp(this.now),
      actorId: scope.actorId,
      actorType: scope.actorType,
      projectId: scope.projectId,
      provider: input.provider,
      ...(scope.orgId ? { orgId: scope.orgId } : {}),
      ...(scope.surface ? { surface: scope.surface } : {}),
      ...(input.connectionId ? { connectionId: input.connectionId } : {}),
      ...(details.channelId ? { channelId: details.channelId } : {}),
      ...(details.routeId ? { routeId: details.routeId } : {}),
      ...(details.setupId ? { setupId: details.setupId } : {}),
      ...(details.errorCode ? { errorCode: details.errorCode } : {}),
    };
    try {
      await this.options.onEvent(event);
    } catch (error) {
      try {
        this.options.onEventError?.(error, event);
      } catch {
        // Observability must never alter Channel provisioning semantics.
      }
    }
  }
}
