import { CHANNEL_PROVIDER_IDS } from "./types.js";
import type {
  ChannelInstallationResolver,
  ChannelProviderId,
  ChannelWebhookOptions,
} from "./types.js";
import type { ChannelRuntime } from "./runtime.js";

export type DispatchChannelWebhookInput = {
  provider: string;
  request: Request;
  resolveInstallation: ChannelInstallationResolver;
  routeKey?: string;
  runtime: ChannelRuntime;
  webhookOptions?: ChannelWebhookOptions;
};

export function isChannelProviderId(value: string): value is ChannelProviderId {
  return (CHANNEL_PROVIDER_IDS as readonly string[]).includes(value);
}

/**
 * Resolve a bounded installation candidate, then let its official adapter
 * authenticate and parse the untouched request body.
 */
export async function dispatchChannelWebhook(
  input: DispatchChannelWebhookInput,
): Promise<Response> {
  if (!isChannelProviderId(input.provider)) {
    return jsonError(404, "unsupported_channel_provider");
  }
  const installation = await input.resolveInstallation({
    provider: input.provider,
    request: input.request.clone(),
    ...(input.routeKey ? { routeKey: input.routeKey } : {}),
  });
  if (!installation) return jsonError(404, "channel_installation_not_found");
  if (installation.provider !== input.provider) {
    return jsonError(404, "channel_installation_not_found");
  }
  return input.runtime.handleWebhook(
    installation,
    input.request,
    input.webhookOptions,
  );
}

function jsonError(status: 404, code: string): Response {
  return Response.json({ error: code, ok: false }, { status });
}
