/**
 * API key resolution for LLM providers.
 *
 * Resolves API keys from environment variables using the canonical
 * PROVIDER_ENV_MAP from @polpo-ai/core.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Re-export the canonical env map from @polpo-ai/core.
export { PROVIDER_ENV_MAP } from "@polpo-ai/core";
import { PROVIDER_ENV_MAP } from "@polpo-ai/core";

/**
 * Resolve API key for a provider (synchronous).
 * Reads from process.env using the PROVIDER_ENV_MAP.
 */
export function resolveApiKey(provider: string): string | undefined {
  const envVar = PROVIDER_ENV_MAP[provider];
  if (!envVar) return undefined;
  return process.env[envVar] || undefined;
}

/**
 * Resolve API key for a provider (async, full resolution chain).
 * Priority: 1) polpo.json overrides (if they had apiKey), 2) env var lookup, 3) stored OAuth profiles.
 *
 * Returns the API key from env vars or provider config.
 */
export async function resolveApiKeyAsync(provider: string): Promise<string | undefined> {
  return resolveApiKey(provider);
}

/**
 * Check if there are any stored OAuth profiles for a provider (synchronous).
 * Used by the sync validation path so OAuth-based providers (openai-codex,
 * github-copilot, anthropic, etc.) aren't rejected before spawn.
 *
 * Reads auth-profiles.json directly to stay synchronous in ESM context.
 */
export function hasOAuthProfiles(provider: string): boolean {
  try {
    const globalPolpoDir = join(homedir(), ".polpo");
    const profilePath = join(globalPolpoDir, "auth-profiles.json");
    if (!existsSync(profilePath)) return false;
    const data = JSON.parse(readFileSync(profilePath, "utf-8"));
    if (!data?.profiles) return false;
    return Object.values(data.profiles).some(
      (p: any) => p.provider === provider,
    );
  } catch {
    return false;
  }
}
