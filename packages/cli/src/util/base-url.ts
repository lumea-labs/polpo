/**
 * Single source of truth for "where do I send data plane requests?".
 *
 * Resolution priority (first match wins):
 *
 *   1. Explicit `--url` flag passed to the command (caller's responsibility
 *      to surface it as the highest-priority override).
 *   2. `POLPO_URL` env var. Lets users redirect a single command run
 *      without touching files (e.g. `POLPO_URL=http://localhost:4000
 *      polpo deploy` for self-hosted dev).
 *   3. `apiUrl` field in `.polpo/project.json`. Per-project pin — used by
 *      teams that want their `.env.local` and CLI to point somewhere
 *      non-standard (custom domain, on-prem cluster).
 *   4. `https://{projectSlug}.polpo.cloud` — derived from the slug stored
 *      in `project.json`. The default for cloud users post-F4.
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
  /** Pre-read `POLPO_URL` env value. */
  envOverride?: string;
  /** Pre-loaded project config (or null when missing). */
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

const DEFAULT_DASHBOARD_URL = "https://polpo.sh";

/**
 * Derive the dashboard URL from an API URL — used by CLI commands that
 * want to show users a clickable link to the project's web UI.
 *
 * Rules (cheap heuristics that cover canonical setups):
 *   - `https://api.polpo.sh` → `https://polpo.sh` (strip `api.` host prefix)
 *   - `https://<slug>.polpo.cloud` → `https://polpo.sh` (data-plane subdomain
 *     isn't a dashboard host — fall back to the canonical dashboard)
 *   - `http://localhost:4000` → `http://localhost:3000` (dev convention:
 *     API on 4000, dashboard on 3000)
 *   - anything else → unchanged (self-hosted users typically run both on
 *     the same host)
 *
 * Returns a clean origin (no trailing slash, no path).
 */
export function dashboardUrlFor(apiUrl: string): string {
  try {
    const u = new URL(apiUrl);
    if (u.host.endsWith(`.${POLPO_API_DOMAIN}`)) {
      return DEFAULT_DASHBOARD_URL;
    }
    if (u.host.startsWith("api.")) {
      u.host = u.host.slice(4);
      return u.origin;
    }
    if (u.port === "4000") {
      u.port = "3000";
      return u.origin;
    }
    return u.origin;
  } catch {
    return DEFAULT_DASHBOARD_URL;
  }
}
