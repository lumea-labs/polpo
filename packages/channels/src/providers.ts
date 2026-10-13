import { createDiscordAdapter } from "@chat-adapter/discord";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import { ConsoleLogger, type Adapter } from "chat";
import { SuggestionWhatsAppAdapter } from "./whatsapp-suggestions.js";
import type {
  ChannelInstallation,
  ChannelProviderCapabilities,
  ChannelProviderId,
} from "./types.js";

const PROVIDER_CAPABILITIES: Record<ChannelProviderId, ChannelProviderCapabilities> = {
  slack: Object.freeze({
    actions: "native",
    audioAttachments: "native",
    cards: "native",
    files: "native",
    formattedText: "native",
    modals: "native",
    reactions: "native",
    streaming: "native",
    structuredStreaming: "native",
    typing: "native",
    videoAttachments: "native",
    voiceReplies: "file-fallback",
  }),
  telegram: Object.freeze({
    actions: "native",
    audioAttachments: "native",
    cards: "partial",
    files: "native",
    formattedText: "native",
    modals: "unsupported",
    reactions: "native",
    streaming: "native",
    structuredStreaming: "fallback",
    typing: "native",
    videoAttachments: "native",
    voiceReplies: "native",
  }),
  discord: Object.freeze({
    actions: "native",
    audioAttachments: "native",
    cards: "native",
    files: "native",
    formattedText: "native",
    modals: "unsupported",
    reactions: "native",
    streaming: "fallback",
    structuredStreaming: "fallback",
    typing: "native",
    videoAttachments: "native",
    voiceReplies: "file-fallback",
  }),
  whatsapp: Object.freeze({
    actions: "native",
    audioAttachments: "native",
    cards: "partial",
    files: "native",
    formattedText: "native",
    modals: "unsupported",
    reactions: "native",
    streaming: "buffered",
    structuredStreaming: "fallback",
    typing: "native",
    videoAttachments: "native",
    voiceReplies: "native",
  }),
};

export function channelProviderCapabilities(
  provider: ChannelProviderId,
): ChannelProviderCapabilities {
  return PROVIDER_CAPABILITIES[provider];
}

export function createOfficialChannelAdapter(
  installation: ChannelInstallation,
): Adapter {
  let adapter: Adapter;
  switch (installation.provider) {
    case "slack":
      adapter = createSlackAdapter({
        botToken: installation.credentials.botToken,
        botUserId: installation.credentials.botUserId,
        mode: "webhook",
        signingSecret: installation.credentials.signingSecret,
        userName: installation.userName,
      });
      break;
    case "telegram":
      adapter = createTelegramAdapter({
        botToken: installation.credentials.botToken,
        mode: "webhook",
        secretToken: installation.credentials.secretToken,
        userName: installation.userName,
      });
      break;
    case "discord":
      adapter = createDiscordAdapter({
        applicationId: installation.credentials.applicationId,
        botToken: installation.credentials.botToken,
        publicKey: installation.credentials.publicKey,
        userName: installation.userName,
      });
      break;
    case "whatsapp":
      adapter = new SuggestionWhatsAppAdapter({
        // Preserve the pinned official factory's configuration and validation.
        accessToken: whatsappSetting(installation.credentials.accessToken, "WHATSAPP_ACCESS_TOKEN", "accessToken"),
        appSecret: whatsappSetting(installation.credentials.appSecret, "WHATSAPP_APP_SECRET", "appSecret"),
        phoneNumberId: whatsappSetting(installation.credentials.phoneNumberId, "WHATSAPP_PHONE_NUMBER_ID", "phoneNumberId"),
        verifyToken: whatsappSetting(installation.credentials.verifyToken, "WHATSAPP_VERIFY_TOKEN", "verifyToken"),
        apiUrl: process.env.WHATSAPP_API_URL,
        userName: installation.userName ?? process.env.WHATSAPP_BOT_USERNAME ?? "whatsapp-bot",
        logger: new ConsoleLogger("info").child("whatsapp"),
      });
      break;
  }
  if (installation.typingEnabled === false) {
    adapter.startTyping = async () => {};
  }
  return adapter;
}

function whatsappSetting(value: string | undefined, environment: string, field: string): string {
  const resolved = value ?? process.env[environment];
  if (!resolved) {
    throw new Error(`${field} is required. Set ${environment} or provide it in config.`);
  }
  return resolved;
}
