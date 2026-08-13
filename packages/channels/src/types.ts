import type {
  ActionEvent,
  Adapter,
  FormattedContent,
  LinkPreview,
  Lock,
  Logger,
  LogLevel,
  MessageSubject,
  ModalResponse,
  OptionsLoadResult,
  PostableMessage,
  QueueEntry,
  StateAdapter,
  StreamChunk,
  StreamEvent,
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
  maxConcurrent?: number;
  maxQueueSize?: number;
  onQueueFull?: "drop-oldest" | "drop-newest";
  queueEntryTtlMs?: number;
  strategy: "drop" | "queue" | "debounce" | "burst" | "concurrent";
};

export type ChannelResponseDeliveryPolicy = {
  maxMessages?: number;
  style: "single" | "conversational";
  targetCharacters?: number;
};

export type ChannelCapabilitySupport =
  | "native"
  | "partial"
  | "fallback"
  | "buffered"
  | "file-fallback"
  | "unsupported";

export type ChannelProviderCapabilities = Readonly<{
  actions: ChannelCapabilitySupport;
  audioAttachments: ChannelCapabilitySupport;
  cards: ChannelCapabilitySupport;
  files: ChannelCapabilitySupport;
  formattedText: ChannelCapabilitySupport;
  modals: ChannelCapabilitySupport;
  reactions: ChannelCapabilitySupport;
  streaming: ChannelCapabilitySupport;
  structuredStreaming: ChannelCapabilitySupport;
  typing: ChannelCapabilitySupport;
  videoAttachments: ChannelCapabilitySupport;
  voiceReplies: ChannelCapabilitySupport;
}>;

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

export type ChannelAuthor = {
  email?: string;
  fullName: string;
  isBot: boolean | "unknown";
  userId: string;
  userName: string;
};

export type ChannelInboundMessage = {
  attachments: ChannelAttachment[];
  author: ChannelAuthor;
  edited?: boolean;
  editedAt?: Date;
  formatted?: FormattedContent;
  id: string;
  isMention: boolean;
  links?: LinkPreview[];
  raw: unknown;
  subject?: MessageSubject;
  text: string;
  timestamp: Date;
};

export type ChannelTurnCoordination = {
  grouped: boolean;
  messageCount: number;
  messageIds: string[];
  primaryMessageId: string;
  strategy: ChannelConcurrencyPolicy["strategy"];
};

export type ChannelInboundTurn = {
  channelId: string;
  coordination: ChannelTurnCoordination;
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

export type ChannelNativePost = PostableMessage;
export type ChannelOutputStream = AsyncIterable<string | StreamChunk | StreamEvent>;

export type ChannelTurnResult = {
  files?: ChannelOutputFile[];
  metadata?: Record<string, unknown>;
  posts?: ChannelNativePost[];
  stream?: ChannelOutputStream;
  text?: string;
};

type ChannelEventBase = {
  channelId?: string;
  credentialRevision: string;
  installationId: string;
  provider: ChannelProviderId;
  providerEventId: string;
  raw: unknown;
  threadId?: string;
  user: ChannelAuthor;
};

export type ChannelMessageEvent = ChannelInboundTurn & {
  type: "message";
};

export type ChannelSlashCommandEvent = ChannelEventBase & {
  command: string;
  openModal: ActionEvent["openModal"];
  text: string;
  type: "slash_command";
};

export type ChannelActionEvent = ChannelEventBase & {
  actionId: string;
  messageId: string;
  openModal: ActionEvent["openModal"];
  triggerId?: string;
  type: "action";
  value?: string;
};

export type ChannelReactionEvent = ChannelEventBase & {
  added: boolean;
  emoji: string;
  messageId: string;
  rawEmoji: string;
  type: "reaction";
};

export type ChannelModalSubmitEvent = ChannelEventBase & {
  callbackId: string;
  messageId?: string;
  privateMetadata?: string;
  type: "modal.submit";
  values: Record<string, string>;
  viewId: string;
};

export type ChannelModalCloseEvent = ChannelEventBase & {
  callbackId: string;
  messageId?: string;
  privateMetadata?: string;
  type: "modal.close";
  viewId: string;
};

export type ChannelOptionsLoadEvent = ChannelEventBase & {
  actionId: string;
  query: string;
  type: "options.load";
};

export type ChannelInboundEvent =
  | ChannelMessageEvent
  | ChannelSlashCommandEvent
  | ChannelActionEvent
  | ChannelReactionEvent
  | ChannelModalSubmitEvent
  | ChannelModalCloseEvent
  | ChannelOptionsLoadEvent;

export type ChannelEventResult = ChannelTurnResult & {
  modalResponse?: ModalResponse;
  options?: OptionsLoadResult;
};

export type ChannelEventHandler = (
  event: ChannelInboundEvent,
) => Promise<ChannelEventResult | void>;

export type ChannelTurnHandler = (
  turn: ChannelInboundTurn,
) => Promise<ChannelTurnResult | void>;

export type ChannelTurnCoordinator = (
  turn: ChannelInboundTurn,
  execute: () => Promise<void>,
) => Promise<void>;

export type ChannelEventCoordinator = (
  event: ChannelInboundEvent,
  execute: () => Promise<void>,
) => Promise<"executed" | "queued" | "steered" | "rejected" | void>;

type ChannelInstallationBase = {
  concurrency?: ChannelConcurrencyPolicy;
  credentialRevision: string;
  id: string;
  responseDelivery?: ChannelResponseDeliveryPolicy;
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
  details?: Record<string, string | number | boolean | null>;
  error?: string;
  installationId: string;
  messageId?: string;
  name:
    | "runtime.created"
    | "runtime.evicted"
    | "webhook.received"
    | "typing.failed"
    | "event.unhandled"
    | "event.queued"
    | "event.steered"
    | "event.rejected"
    | "transport.message.queued"
    | "transport.message.dequeued"
    | "transport.message.dropped"
    | "transport.message.expired"
    | "transport.message.superseded"
    | "transport.message.debouncing"
    | "transport.message.debounce_reset"
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
  coordinateEvent?: ChannelEventCoordinator;
  coordinateTurn?: ChannelTurnCoordinator;
  dedupeTtlMs?: number;
  fallbackStreamingPlaceholderText?: string | null;
  handleEvent?: ChannelEventHandler;
  handleTurn?: ChannelTurnHandler;
  idleTtlMs?: number;
  observabilityTimeoutMs?: number;
  logger?: Logger | LogLevel;
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
