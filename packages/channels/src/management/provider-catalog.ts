import type { ChannelProviderId } from "../types.js";
import type { ChannelProviderDescriptor } from "./contracts.js";

const descriptors: Record<ChannelProviderId, Omit<ChannelProviderDescriptor, "availability">> = {
  slack: {
    id: "slack",
    label: "Slack",
    connectionProvider: "slack",
    destination: { kind: "channel", discovery: "automatic" },
    setup: {
      authorization: "oauth",
      secureHandoff: true,
      automations: ["workspace_validation", "channel_discovery"],
      externalSteps: [],
    },
  },
  telegram: {
    id: "telegram",
    label: "Telegram",
    connectionProvider: "telegram",
    destination: { kind: "chat", discovery: "both" },
    setup: {
      authorization: "secure_credentials",
      secureHandoff: true,
      automations: ["token_validation", "chat_discovery", "webhook_registration"],
      externalSteps: ["create_bot"],
    },
  },
  discord: {
    id: "discord",
    label: "Discord",
    connectionProvider: "discord",
    destination: { kind: "application", discovery: "manual" },
    setup: {
      authorization: "secure_credentials",
      secureHandoff: true,
      automations: ["application_validation", "interaction_endpoint_verification"],
      externalSteps: ["install_bot", "configure_interactions_endpoint"],
    },
  },
  whatsapp: {
    id: "whatsapp",
    label: "WhatsApp",
    connectionProvider: "whatsapp",
    destination: { kind: "phone_number", discovery: "both" },
    setup: {
      authorization: "secure_credentials",
      secureHandoff: true,
      automations: ["token_validation", "phone_number_validation", "webhook_verification"],
      externalSteps: ["configure_meta_app"],
    },
  },
};

export function channelProviderCatalog(
  enabled: Partial<Record<ChannelProviderId, boolean>> = {},
): readonly ChannelProviderDescriptor[] {
  return (Object.keys(descriptors) as ChannelProviderId[]).map((id) => ({
    ...descriptors[id],
    availability: enabled[id] === false ? "disabled" : "available",
  }));
}
