import { createDiscordAdapter } from "@chat-adapter/discord";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import { createWhatsAppAdapter } from "@chat-adapter/whatsapp";
import type { Adapter } from "chat";
import type { ChannelInstallation } from "./types.js";

export function createOfficialChannelAdapter(
  installation: ChannelInstallation,
): Adapter {
  switch (installation.provider) {
    case "slack":
      return createSlackAdapter({
        botToken: installation.credentials.botToken,
        botUserId: installation.credentials.botUserId,
        mode: "webhook",
        signingSecret: installation.credentials.signingSecret,
        userName: installation.userName,
      });
    case "telegram":
      return createTelegramAdapter({
        botToken: installation.credentials.botToken,
        mode: "webhook",
        secretToken: installation.credentials.secretToken,
        userName: installation.userName,
      });
    case "discord":
      return createDiscordAdapter({
        applicationId: installation.credentials.applicationId,
        botToken: installation.credentials.botToken,
        publicKey: installation.credentials.publicKey,
        userName: installation.userName,
      });
    case "whatsapp":
      return createWhatsAppAdapter({
        accessToken: installation.credentials.accessToken,
        appSecret: installation.credentials.appSecret,
        phoneNumberId: installation.credentials.phoneNumberId,
        userName: installation.userName,
        verifyToken: installation.credentials.verifyToken,
      });
  }
}
