import { createDiscordAdapter } from "@chat-adapter/discord";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import { createWhatsAppAdapter } from "@chat-adapter/whatsapp";
import type { Adapter } from "chat";
import type { ChannelInstallation } from "./types.js";

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
