/**
 * Single source of truth for "where do I send data plane requests?".
 *
 * Resolution priority (first match wins):
 *
 *   1. Explicit `--url` flag passed to the command (caller's responsibility
 *      to surface it as the highest-priority override).
 *   2. `POLPO_API_URL` env var. Lets users redirect a single command run
 *      without touching files (e.g. `POLPO_API_URL=http://localhost:4000
 *      polpo deploy` for self-hosted dev).
 *   3. `apiUrl` field in `.polpo/polpo.json`. Per-project pin — used by
 *      teams that want their `.env.local` and CLI to point somewhere
 *      non-standard (custom domain, on-prem cluster).
 *   4. `https://{projectSlug}.polpo.cloud` — derived from the slug stored
 *      in `polpo.json`. The default for cloud users post-F4.
 *   5. Stored CLI credentials baseUrl (from `~/.polpo/credentials.json`,
 *      defaults to `https://api.polpo.sh`). Last-resort fallback for
 *      legacy clients that don't have a slug yet.
 *
 * Self-hosted users override (1) or (2) and the rest of the chain is
 * irrelevant. Cloud users normally hit (4).
 *
 * IMPORTANT: this function does NOT touch the network or read env files —
 * it's a pure function of the inputs. The caller decides which sources
 * to consult.
 */

export interface BaseUrlInputs {
  /** From `--url` flag. */
  flagOverride?: string;
  /** Pre-read `POLPO_API_URL` env value. */
  envOverride?: string;
  /** Pre-loaded `polpo.json` (or null when missing). */
  polpoConfig?: { apiUrl?: string; projectSlug?: string } | null;
  /** Default cloud base URL fallback (typically `creds.baseUrl`). */
  fallback: string;
}

export const POLPO_API_DOMAIN = "polpo.cloud";

export function resolveBaseUrl(inputs: BaseUrlInputs): string {
  if (inputs.flagOverride) return stripTrailingSlash(inputs.flagOverride);
  if (inputs.envOverride) return stripTrailingSlash(inputs.envOverride);

  const cfg = inputs.polpoConfig;
  if (cfg?.apiUrl) return stripTrailingSlash(cfg.apiUrl);
  if (cfg?.projectSlug) return `https://${cfg.projectSlug}.${POLPO_API_DOMAIN}`;

  return stripTrailingSlash(inputs.fallback);
}

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}
