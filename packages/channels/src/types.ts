import type {
  Adapter,
  Lock,
  QueueEntry,
  StateAdapter,
  WebhookOptions,
} from "chat";

export type ChannelStateAdapter = StateAdapter;
export type ChannelStateLock = Lock;
export type ChannelStateQueueEntry = QueueEntry;

export const CHANNEL_PROVIDER_IDS = [
  "slack",
  "telegram",
  "discord",
  "whatsapp",
] as const;

export type ChannelProviderId = (typeof CHANNEL_PROVIDER_IDS)[number];

export type ChannelConcurrencyPolicy = {
  debounceMs?: number;
  maxQueueSize?: number;
  onQueueFull?: "drop-oldest" | "drop-newest";
  queueEntryTtlMs?: number;
  strategy: "drop" | "queue" | "debounce" | "burst" | "concurrent";
};

export type ChannelAttachment = {
  data?: Blob | Buffer;
  fetchData?: () => Promise<Buffer>;
  fetchMetadata?: Record<string, string>;
  height?: number;
  mimeType?: string;
  name?: string;
  size?: number;
  type: "image" | "file" | "video" | "audio";
  url?: string;
  width?: number;
};

export type ChannelInboundMessage = {
  attachments: ChannelAttachment[];
  author: {
    email?: string;
    fullName: string;
    isBot: boolean | "unknown";
    userId: string;
    userName: string;
  };
  id: string;
  isMention: boolean;
  raw: unknown;
  text: string;
  timestamp: Date;
};

export type ChannelInboundTurn = {
  channelId: string;
  credentialRevision: string;
  installationId: string;
  isDirectMessage: boolean;
  messages: ChannelInboundMessage[];
  provider: ChannelProviderId;
  providerEventId: string;
  threadId: string;
};

export type ChannelOutputFile = {
  data: ArrayBuffer | Blob | Buffer;
  filename: string;
  mimeType?: string;
  type?: "image" | "file" | "video" | "audio";
};

export type ChannelTurnResult = {
  files?: ChannelOutputFile[];
  metadata?: Record<string, unknown>;
  stream?: AsyncIterable<string>;
  text?: string;
};

export type ChannelTurnHandler = (
  turn: ChannelInboundTurn,
) => Promise<ChannelTurnResult | void>;

export type ChannelTurnCoordinator = (
  turn: ChannelInboundTurn,
  execute: () => Promise<void>,
) => Promise<void>;

type ChannelInstallationBase = {
  concurrency?: ChannelConcurrencyPolicy;
  credentialRevision: string;
  id: string;
  typingEnabled?: boolean;
  userName?: string;
};

export type SlackChannelInstallation = ChannelInstallationBase & {
  credentials: {
    botToken: string;
    botUserId?: string;
    signingSecret: string;
  };
  provider: "slack";
};

export type TelegramChannelInstallation = ChannelInstallationBase & {
  credentials: {
    botToken: string;
    secretToken?: string;
  };
  provider: "telegram";
};

export type DiscordChannelInstallation = ChannelInstallationBase & {
  credentials: {
    applicationId: string;
    botToken: string;
    publicKey: string;
  };
  provider: "discord";
};

export type WhatsAppChannelInstallation = ChannelInstallationBase & {
  credentials: {
    accessToken: string;
    appSecret: string;
    phoneNumberId: string;
    verifyToken: string;
  };
  provider: "whatsapp";
};

export type ChannelInstallation =
  | SlackChannelInstallation
  | TelegramChannelInstallation
  | DiscordChannelInstallation
  | WhatsAppChannelInstallation;

export type ChannelRuntimeEvent = {
  channelId?: string;
  error?: string;
  installationId: string;
  messageId?: string;
  name:
    | "runtime.created"
    | "runtime.evicted"
    | "webhook.received"
    | "typing.failed"
    | "turn.started"
    | "turn.completed"
    | "turn.failed"
    | "delivery.completed"
    | "delivery.failed";
  provider: ChannelProviderId;
  threadId?: string;
};

export type ChannelAdapterFactory = (
  installation: ChannelInstallation,
) => Adapter;

export type ChannelStateFactory = (
  installation: ChannelInstallation,
) => StateAdapter | Promise<StateAdapter>;

export type ChannelRuntimeOptions = {
  adapterFactory?: ChannelAdapterFactory;
  concurrency?: ChannelConcurrencyPolicy;
  coordinateTurn?: ChannelTurnCoordinator;
  dedupeTtlMs?: number;
  fallbackStreamingPlaceholderText?: string | null;
  handleTurn: ChannelTurnHandler;
  idleTtlMs?: number;
  maxInstances?: number;
  onEvent?: (event: ChannelRuntimeEvent) => void | Promise<void>;
  shouldStartTyping?: (turn: ChannelInboundTurn) => boolean | Promise<boolean>;
  stateFactory?: ChannelStateFactory;
  streamingUpdateIntervalMs?: number;
};

export type ChannelWebhookOptions = WebhookOptions;

export type ChannelInstallationResolverInput = {
  provider: ChannelProviderId;
  request: Request;
  routeKey?: string;
};

export type ChannelInstallationResolver = (
  input: ChannelInstallationResolverInput,
) => Promise<ChannelInstallation | null>;
