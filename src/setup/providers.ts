import { PROVIDER_ENV_MAP, listProviders } from "../llm/pi-client.js";

export interface DetectedProvider {
  /** Provider name exactly as it appears in the AI Gateway catalog (e.g. "openai", "openai-codex", "google") */
  name: string;
  /** Environment variable for API key (if any) */
  envVar: string | undefined;
  /** Whether a usable credential exists (env key) */
  hasKey: boolean;
  /** Source of credentials */
  source: "env" | "none";
}

/**
 * Detect all providers from the AI Gateway catalog with their credential status.
 *
 * This is a 1:1 pass-through of the catalog — every provider the gateway knows about
 * is returned. No deduplication, no name mapping. The UI is a mere wrapper on this.
 *
 * Credential detection:
 * - env: the provider has a known env var (PROVIDER_ENV_MAP) and it's set
 * - none: no credentials found
 */
export function detectProviders(): DetectedProvider[] {
  const catalogProviders = listProviders();

  return catalogProviders.map((name) => {
    const envVar = PROVIDER_ENV_MAP[name];
    const hasEnvKey = envVar ? !!process.env[envVar] : false;

    return {
      name,
      envVar,
      hasKey: hasEnvKey,
      source: hasEnvKey ? "env" as const : "none" as const,
    };
  });
}

/**
 * Check if a provider has credentials available (env key only, OAuth removed).
 */
export function hasOAuthProfilesForProvider(_provider: string): boolean {
  return false;
}
