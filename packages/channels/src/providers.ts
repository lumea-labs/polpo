import { createDiscordAdapter } from "@chat-adapter/discord";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import { createWhatsAppAdapter } from "@chat-adapter/whatsapp";
import type { Adapter } from "chat";
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
      adapter = createWhatsAppAdapter({
        accessToken: installation.credentials.accessToken,
        appSecret: installation.credentials.appSecret,
        phoneNumberId: installation.credentials.phoneNumberId,
        userName: installation.userName,
        verifyToken: installation.credentials.verifyToken,
      });
      break;
  }
  if (installation.typingEnabled === false) {
    adapter.startTyping = async () => {};
  }
  return adapter;
}
