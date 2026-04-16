/**
 * Self-update primitives shared by `polpo update` and the interactive
 * update prompt at the start of long-running commands (`install`, `create`).
 *
 * Kept here (not in `update-check.ts`) so both the synchronous `update`
 * command and the interactive prompt can reuse the same package-manager
 * detection + install logic without circular imports.
 */
import { execSync } from "node:child_process";

export const PACKAGE_NAME = "polpo-ai";

/**
 * Detect which package manager installed polpo globally. Falls back to
 * `npm` when detection fails — npm ships with Node.js so it's a safe bet.
 */
export function detectPackageManager(): "pnpm" | "npm" {
  try {
    const out = execSync("pnpm list -g polpo-ai --depth=0 2>/dev/null", {
      encoding: "utf-8",
      timeout: 10_000,
    });
    if (out.includes("polpo-ai")) return "pnpm";
  } catch {
    // pnpm absent or listing failed — fall through.
  }
  return "npm";
}

/**
 * Fetch the latest published version from the npm registry.
 */
export async function getLatestVersion(): Promise<string> {
  const res = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Registry returned ${res.status}`);
  const data = (await res.json()) as { version: string };
  return data.version;
}

/**
 * Install `polpo-ai@{version}` globally via the detected package manager.
 * Returns `{ success: true, cmd }` on success, `{ success: false, cmd, error }`
 * on failure. Never throws — callers typically want to warn + continue.
 */
export function runSelfUpdate(version: string): {
  success: boolean;
  cmd: string;
  error?: string;
} {
  const pm = detectPackageManager();
  const cmd =
    pm === "pnpm"
      ? `pnpm add -g polpo-ai@${version}`
      : `npm install -g polpo-ai@${version}`;

  if (pm === "npm") {
    try {
      execSync("npm cache clean --force", { stdio: "ignore", timeout: 30_000 });
    } catch {
      // Best effort — stale cache is recoverable by re-running.
    }
  }

  try {
    execSync(cmd, { stdio: "inherit", timeout: 120_000 });
    return { success: true, cmd };
  } catch (err) {
    return {
      success: false,
      cmd,
      error: (err as Error).message ?? "unknown error",
    };
  }
}
