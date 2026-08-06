/**
 * Read/write helpers for `.polpo/project.json` — the per-project config file
 * that links a directory to a cloud project.
 *
 * Schema kept minimal on purpose — whatever fields exist already are
 * preserved on partial updates.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface PolpoProjectConfig {
  /** Filesystem layout version. New projects use version 2. */
  schemaVersion?: number;
  /** Project name shown in dashboards/logs. */
  project?: string;
  /**
   * Public project ref (Supabase-style, `^[a-z]{20}$`) — the canonical
   * identifier the CLI uses to compute the data plane URL
   * `https://{projectSlug}.polpo.cloud`. Set by `polpo create` / `polpo link`.
   */
  projectSlug?: string;
  /**
   * Cloud project UUID. Cache for display purposes (e.g. dashboard URL).
   * Legacy clients pre-subdomain may have only this; the CLI backfills
   * `projectSlug` from it on first read.
   */
  projectId?: string;
  /**
   * Explicit API base URL override. Wins over `projectSlug`-derived URL.
   * Use for self-hosted, dev loopback, or custom domains.
   */
  apiUrl?: string;
  /** Anything else (gateway settings, storage backend, …). */
  [key: string]: unknown;
}

export function polpoDirPath(cwd: string): string {
  return path.resolve(cwd, ".polpo");
}

export function polpoConfigPath(cwd: string): string {
  return path.join(polpoDirPath(cwd), "project.json");
}

export function legacyPolpoConfigPath(cwd: string): string {
  return path.join(polpoDirPath(cwd), "polpo.json");
}

/** Existing config path, preferring v2; canonical v2 path for new projects. */
export function activePolpoConfigPath(cwd: string): string {
  const current = polpoConfigPath(cwd);
  if (fs.existsSync(current)) return current;
  const legacy = legacyPolpoConfigPath(cwd);
  return fs.existsSync(legacy) ? legacy : current;
}

export function readPolpoConfig(cwd: string): PolpoProjectConfig | null {
  const file = activePolpoConfigPath(cwd);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as PolpoProjectConfig;
  } catch {
    return null;
  }
}

/**
 * Merge `patch` into the active project config, creating `project.json`
 * (and the `.polpo/` dir) if it doesn't exist yet.
 */
export function writePolpoConfig(cwd: string, patch: PolpoProjectConfig): void {
  const dir = polpoDirPath(cwd);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const existing = readPolpoConfig(cwd) ?? {};
  const target = activePolpoConfigPath(cwd);
  const merged = target === polpoConfigPath(cwd)
    ? { schemaVersion: 2, ...existing, ...patch }
    : { ...existing, ...patch };
  fs.writeFileSync(target, JSON.stringify(merged, null, 2) + "\n", "utf-8");
}
