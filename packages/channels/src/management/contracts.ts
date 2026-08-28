import type {
  ChannelActivityPolicy,
  ChannelConcurrencyPolicy,
  ChannelProviderId,
  ChannelResponseDeliveryPolicy,
  ChannelWhatsAppTemplate,
} from "../types.js";

export type ChannelManagementActorType = "user" | "service" | "agent";

export type ChannelManagementScope = Readonly<{
  actorId: string;
  actorType: ChannelManagementActorType;
  orgId?: string;
  projectId: string;
  surface?: string;
}>;

export type ChannelManagementEvent = Readonly<{
  actorId: string;
  actorType: ChannelManagementActorType;
  channelId?: string;
  connectionId?: string;
  errorCode?: string;
  operation: "configure";
  orgId?: string;
  outcome:
    | "started"
    | "ready"
    | "setup_required"
    | "pending_external"
    | "verifying"
    | "failed";
  projectId: string;
  provider: ChannelProviderId;
  routeId?: string;
  setupId?: string;
  surface?: string;
  timestamp: string;
}>;

export type ConversationChannelStatus = "pending" | "active" | "disabled" | "error";
export type ConversationChannelResponseModality = "text" | "voice";

export type ConversationChannelIdentityResolver = Readonly<{
  connectionId: string;
  endpoint: string;
  timeoutMs?: number;
  type: "http";
  version: 1;
}>;

export type ConversationChannelAttachmentHandler = Readonly<{
  allowedMimeTypes?: readonly string[];
  connectionId: string;
  endpoint: string;
  maxAttachments?: number;
  maxBytes?: number;
  maxTotalBytes?: number;
  timeoutMs?: number;
  type: "http";
  version: 1;
}>;

export type ConversationChannelClientToolContinuation =
  | Readonly<{
      description?: string;
      mode: "direct";
      parameters?: Readonly<Record<string, unknown>>;
      strict?: boolean;
    }>
  | Readonly<{
      description?: string;
      loop: string;
      mode: "loop";
      parameters?: Readonly<Record<string, unknown>>;
      strict?: boolean;
    }>;

export type ConversationChannelClientToolHandler = Readonly<{
  connectionId: string;
  endpoint: string;
  maxContinuations?: number;
  timeoutMs?: number;
  tools: Readonly<Record<string, ConversationChannelClientToolContinuation>>;
  type: "http";
  version: 1;
}>;

export type ConversationChannelActiveRunPolicy = Readonly<{
  behavior: "reject";
  reply: string;
}>;

export type ConversationChannelSettings = Readonly<{
  activeRunPolicy?: ConversationChannelActiveRunPolicy;
  activity?: ChannelActivityPolicy;
  attachmentHandler?: ConversationChannelAttachmentHandler;
  clientToolHandler?: ConversationChannelClientToolHandler;
  concurrency?: ChannelConcurrencyPolicy;
  identityResolver?: ConversationChannelIdentityResolver;
  responseDelivery?: ChannelResponseDeliveryPolicy;
  responseModality?: ConversationChannelResponseModality;
  typingEnabled?: boolean;
}>;

export type ConversationChannelSettingsPatch = Readonly<
  Omit<
    ConversationChannelSettings,
    "activeRunPolicy" | "attachmentHandler" | "clientToolHandler" | "identityResolver"
  > & {
    activeRunPolicy?: ConversationChannelActiveRunPolicy | null;
    attachmentHandler?: ConversationChannelAttachmentHandler | null;
    clientToolHandler?: ConversationChannelClientToolHandler | null;
    identityResolver?: ConversationChannelIdentityResolver | null;
  }
>;

export type ConversationChannel = Readonly<{
  connectionId: string;
  createdAt: string;
  externalChannelId: string | null;
  id: string;
  name: string;
  provider: ChannelProviderId;
  settings: ConversationChannelSettings;
  status: ConversationChannelStatus;
  updatedAt: string;
}>;

export type ConversationChannelRoute = Readonly<{
  agentName: string;
  allowedTools?: readonly string[];
  channelId: string;
  createdAt: string;
  enabled: boolean;
  externalChannelId: string | null;
  id: string;
  priority: number;
  updatedAt: string;
}>;

export type ChannelProviderDescriptor = Readonly<{
  availability: "available" | "disabled" | "unsupported";
  connectionProvider: string;
  destination: Readonly<{
    discovery: "automatic" | "manual" | "both";
    kind: "channel" | "chat" | "application" | "phone_number";
  }>;
  id: ChannelProviderId;
  label: string;
  setup: Readonly<{
    authorization: "existing_connection" | "oauth" | "secure_credentials";
    automations: readonly string[];
    externalSteps: readonly string[];
    secureHandoff: boolean;
  }>;
}>;

export type ChannelSetupRequirement = Readonly<{
  code: string;
  label: string;
  url?: string;
}>;

export type SecureChannelSetupAction = Readonly<{
  expiresAt: string;
  setupId: string;
  url: string;
}>;

export type ChannelSetupError = Readonly<{
  code: string;
  message: string;
  retryable: boolean;
}>;

export type ChannelProvisioningResult =
  | Readonly<{
      channel: ConversationChannel;
      route: ConversationChannelRoute;
      status: "ready";
    }>
  | Readonly<{
      setup: SecureChannelSetupAction;
      status: "setup_required";
    }>
  | Readonly<{
      channel?: ConversationChannel;
      requirements: readonly ChannelSetupRequirement[];
      route?: ConversationChannelRoute;
      setup?: SecureChannelSetupAction;
      status: "pending_external";
    }>
  | Readonly<{
      setupId: string;
      status: "verifying";
    }>
  | Readonly<{
      error: ChannelSetupError;
      setupId?: string;
      status: "failed";
    }>;

export type ConfigureConversationChannelInput = Readonly<{
  agentName: string;
  allowedTools?: readonly string[];
  connectionId?: string;
  externalChannelId?: string;
  idempotencyKey: string;
  name?: string;
  priority?: number;
  provider: ChannelProviderId;
  settings?: ConversationChannelSettings;
}>;

export type UpdateConversationChannelInput = Readonly<{
  name?: string;
  settings?: ConversationChannelSettingsPatch;
  status?: Extract<ConversationChannelStatus, "active" | "disabled">;
}>;

export type TestConversationChannelInput = Readonly<{
  recipient?: string;
}>;

export type UpsertConversationChannelRouteInput = Readonly<{
  agentName: string;
  allowedTools?: readonly string[];
  channelId: string;
  enabled?: boolean;
  externalChannelId?: string | null;
  priority?: number;
}>;

export type ConversationChannelQuery = Readonly<{
  connectionId?: string;
  provider?: ChannelProviderId;
  status?: ConversationChannelStatus;
}>;

export type RedactedChannelConnection = Readonly<{
  id: string;
  name?: string;
  providerId: string;
  status: "active" | "pending" | "revoked" | "error";
}>;

export type CreateConversationChannelRecord = Readonly<{
  connectionId: string;
  externalChannelId: string;
  id: string;
  idempotencyKey: string;
  name: string;
  provider: ChannelProviderId;
  settings: ConversationChannelSettings;
  status: ConversationChannelStatus;
  timestamp: string;
}>;

export type CreateConversationChannelRouteRecord = Readonly<{
  agentName: string;
  allowedTools?: readonly string[];
  channelId: string;
  enabled: boolean;
  externalChannelId: string | null;
  id: string;
  priority: number;
  timestamp: string;
}>;

export interface ChannelManagementStore {
  createOrReuseChannel(
    scope: ChannelManagementScope,
    input: CreateConversationChannelRecord,
  ): Promise<ConversationChannel>;
  getChannel(scope: ChannelManagementScope, id: string): Promise<ConversationChannel | null>;
  listChannels(
    scope: ChannelManagementScope,
    query?: ConversationChannelQuery,
  ): Promise<ConversationChannel[]>;
  removeChannel(scope: ChannelManagementScope, id: string): Promise<boolean>;
  updateChannel(
    scope: ChannelManagementScope,
    id: string,
    patch: Omit<UpdateConversationChannelInput, "status"> & {
      status?: ConversationChannelStatus;
      timestamp: string;
    },
  ): Promise<ConversationChannel | null>;
  listRoutes(
    scope: ChannelManagementScope,
    channelId: string,
  ): Promise<ConversationChannelRoute[]>;
  removeRoute(scope: ChannelManagementScope, routeId: string): Promise<boolean>;
  upsertRoute(
    scope: ChannelManagementScope,
    input: CreateConversationChannelRouteRecord,
  ): Promise<ConversationChannelRoute>;
}

export interface ChannelConnectionResolver {
  inspect(
    scope: ChannelManagementScope,
    connectionId: string,
  ): Promise<RedactedChannelConnection | null>;
  validateForProvider(
    scope: ChannelManagementScope,
    connectionId: string,
    provider: ChannelProviderId,
  ): Promise<void>;
}

export type ChannelProviderPreparation =
  | Readonly<{ externalChannelId: string; status: "ready" }>
  | Readonly<{
      externalChannelId?: string;
      requirements: readonly ChannelSetupRequirement[];
      setup?: SecureChannelSetupAction;
      status: "pending_external";
    }>
  | Readonly<{ setupId: string; status: "verifying" }>;

export type ChannelProviderActivation =
  | Readonly<{ status: "ready" }>
  | Readonly<{
      requirements: readonly ChannelSetupRequirement[];
      setup?: SecureChannelSetupAction;
      status: "pending_external";
    }>
  | Readonly<{ setupId: string; status: "verifying" }>;

export interface ChannelProviderAutomation {
  prepare(input: {
    connection: RedactedChannelConnection;
    externalChannelId?: string;
    idempotencyKey: string;
    provider: ChannelProviderId;
    scope: ChannelManagementScope;
  }): Promise<ChannelProviderPreparation>;
  activate(input: {
    channel: ConversationChannel;
    connection: RedactedChannelConnection;
    idempotencyKey: string;
    provider: ChannelProviderId;
    route: ConversationChannelRoute;
    scope: ChannelManagementScope;
  }): Promise<ChannelProviderActivation>;
  test(input: {
    channel: ConversationChannel;
    connection: RedactedChannelConnection;
    recipient?: string;
    scope: ChannelManagementScope;
  }): Promise<{ message?: string; success: boolean }>;
  sendTemplate?(input: {
    channel: ConversationChannel;
    connection: RedactedChannelConnection;
    idempotencyKey: string;
    recipient: string;
    scope: ChannelManagementScope;
    template: ChannelWhatsAppTemplate;
  }): Promise<{ messageId?: string; success: boolean }>;
}

export interface SendConversationChannelTemplateInput {
  idempotencyKey: string;
  recipient: string;
  template: ChannelWhatsAppTemplate;
}

export interface ChannelSecureSetupCoordinator {
  begin(input: {
    agentName: string;
    idempotencyKey: string;
    provider: ChannelProviderId;
    requestedConfig?: Readonly<{
      externalChannelId?: string;
      name?: string;
      priority?: number;
      settings?: ConversationChannelSettings;
    }>;
    scope: ChannelManagementScope;
  }): Promise<SecureChannelSetupAction>;
  get(
    scope: ChannelManagementScope,
    setupId: string,
  ): Promise<ChannelProvisioningResult>;
}
