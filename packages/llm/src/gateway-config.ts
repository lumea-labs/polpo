/**
 * Gateway configuration type — passed per-request, not stored as singleton.
 *
 * Allows users to route LLM calls through any OpenAI-compatible gateway
 * (Vercel AI Gateway, OpenRouter, LiteLLM, Ollama, etc.).
 */

export interface GatewayConfig {
  /** Gateway endpoint URL. */
  url: string;
  /** Resolved API key (not env var name). */
  apiKey?: string;
  /** Custom headers to send with every request. */
  headers?: Record<string, string>;
}
