/**
 * Gateway configuration — configurable LLM gateway support.
 *
 * Allows users to route LLM calls through any OpenAI-compatible gateway
 * (Vercel AI Gateway, OpenRouter, LiteLLM, Ollama, etc.) by setting
 * `settings.gateway` in polpo.json.
 */

export interface GatewayConfig {
  /** Gateway endpoint URL. */
  url: string;
  /** Resolved API key (not env var name). */
  apiKey?: string;
  /** Custom headers to send with every request. */
  headers?: Record<string, string>;
}

let gatewayConfig: GatewayConfig | null = null;

/** Configure the LLM gateway. Called by the orchestrator at boot from polpo.json settings. */
export function configureGateway(config: GatewayConfig): void {
  gatewayConfig = config;
}

/** Get the current gateway configuration, or null if not configured. */
export function getGatewayConfig(): GatewayConfig | null {
  return gatewayConfig;
}

/** Reset gateway configuration (useful for tests). */
export function resetGatewayConfig(): void {
  gatewayConfig = null;
}
