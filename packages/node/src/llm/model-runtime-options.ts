import {
  getProviderOverrides,
  hasOAuthProfiles,
  parseModelSpec,
  resolveApiKey,
  type GatewayConfig,
  type ResolveModelOptions,
} from "@polpo-ai/llm";

type ModelSpecLike = string | { primary?: string } | undefined;

/**
 * Select the model runtime for the Node host without leaking host-specific
 * gateway implementations into shared packages.
 */
export function resolveNodeModelOptions(
  model: ModelSpecLike,
  gatewayConfig?: GatewayConfig,
): ResolveModelOptions {
  if (gatewayConfig) {
    return { mode: "gateway", gateway: gatewayConfig };
  }

  const provider = parseProvider(model);
  if (provider && canUseDirectProvider(provider)) {
    return { mode: "provider" };
  }

  if (process.env.AI_GATEWAY_API_KEY) {
    return { mode: "gateway" };
  }

  return { mode: "provider" };
}

function parseProvider(model: ModelSpecLike): string | undefined {
  const spec = typeof model === "string" ? model : model?.primary;
  try {
    return parseModelSpec(spec).provider;
  } catch {
    return undefined;
  }
}

function canUseDirectProvider(provider: string): boolean {
  const override = getProviderOverrides()[provider];
  return !!override?.baseUrl || !!resolveApiKey(provider) || hasOAuthProfiles(provider);
}
