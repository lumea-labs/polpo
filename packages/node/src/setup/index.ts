export {
  detectProviders,
  hasOAuthProfilesForProvider,
  type DetectedProvider,
} from "./providers.js";

export {
  persistToEnvFile,
  removeFromEnvFile,
} from "./env-persistence.js";

export {
  getProviderModels,
  formatCost,
  modelLabel,
  type ModelInfo,
} from "./models.js";

// ── OAuth stubs (OAuth system removed) ──────────────────────────

export interface AuthOption {
  id: string;
  label: string;
  description: string;
  type: "oauth" | "api_key";
  oauthId?: string;
  free: boolean;
}

export interface LoginCallbacks {
  onAuthUrl?: (url: string, instructions?: string) => void;
  onPrompt?: (message: string, placeholder?: string) => Promise<string>;
  onProgress?: (message: string) => void;
}

/** OAuth providers removed — returns only the manual API key option. */
export function getAuthOptions(): AuthOption[] {
  return [
    { id: "api-key", label: "Enter an API key manually", description: "For any provider (OpenAI, Anthropic, Groq, etc.)", type: "api_key", free: false },
  ];
}

/** OAuth providers removed — empty set. */
export const FREE_OAUTH_PROVIDERS = new Set<string>();

/** OAuth providers removed — always returns undefined. */
export function findOAuthProvider(_providerId: string): undefined {
  return undefined;
}

/** OAuth providers removed — returns empty list. */
export function getOAuthProviderList(): { id: string; name: string; flow: string; free: boolean }[] {
  return [];
}

/** OAuth login removed — always throws. */
export async function startOAuthLogin(
  _providerId: string,
  _callbacks: LoginCallbacks,
): Promise<string> {
  throw new Error("OAuth login has been removed. Use API keys instead.");
}
