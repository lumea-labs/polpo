/**
 * Read/write helpers for `.polpo/polpo.json` — the per-project config file
 * that links a directory to a cloud project.
 *
 * Schema kept minimal on purpose — whatever fields exist already are
 * preserved on partial updates.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface PolpoProjectConfig {
  /** Project name shown in dashboards/logs. */
  project?: string;
  /** Cloud project UUID. Set after `polpo create` or `polpo link`. */
  projectId?: string;
  /** API base URL override (defaults to https://api.polpo.sh). */
  apiUrl?: string;
  /** Anything else (gateway settings, storage backend, …). */
  [key: string]: unknown;
}

export function polpoDirPath(cwd: string): string {
  return path.resolve(cwd, ".polpo");
}

export function polpoConfigPath(cwd: string): string {
  return path.join(polpoDirPath(cwd), "polpo.json");
}

export function readPolpoConfig(cwd: string): PolpoProjectConfig | null {
  const file = polpoConfigPath(cwd);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as PolpoProjectConfig;
  } catch {
    return null;
  }
}

/**
 * Merge `patch` into the existing `.polpo/polpo.json`, creating the file
 * (and the `.polpo/` dir) if it doesn't exist yet.
 */
export function writePolpoConfig(cwd: string, patch: PolpoProjectConfig): void {
  const dir = polpoDirPath(cwd);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const existing = readPolpoConfig(cwd) ?? {};
  const merged = { ...existing, ...patch };
  fs.writeFileSync(polpoConfigPath(cwd), JSON.stringify(merged, null, 2) + "\n", "utf-8");
}
