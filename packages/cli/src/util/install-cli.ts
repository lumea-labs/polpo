/**
 * Detect + install the `@polpo-ai/cli` package globally.
 *
 * Called at the end of `polpo create`: if the user ran via
 * `npx @polpo-ai/cli create` they DON'T have the `polpo` bin on PATH
 * after the wizard ends — they'd have to keep using `npx`. Offering a
 * one-shot global install saves them from that.
 *
 * Skipped when `polpo` is already on PATH (user already installed it).
 */
import { exec, execSync } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export const CLI_PACKAGE = "@polpo-ai/cli";

/** `true` when the `polpo` bin is already on PATH globally. */
export function isPolpoOnPath(): boolean {
  try {
    const cmd = process.platform === "win32" ? "where polpo" : "which polpo";
    execSync(cmd, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect the user's preferred package manager from `npm_config_user_agent`
 * so we install via the same tool they launched the wizard with.
 * Falls back to `npm`.
 */
export function detectPackageManager(): "npm" | "pnpm" | "yarn" | "bun" {
  const ua = process.env.npm_config_user_agent ?? "";
  if (ua.includes("pnpm")) return "pnpm";
  if (ua.includes("yarn")) return "yarn";
  if (ua.includes("bun")) return "bun";
  return "npm";
}

function globalInstallCommand(pm: ReturnType<typeof detectPackageManager>): string {
  switch (pm) {
    case "pnpm": return `pnpm add -g ${CLI_PACKAGE}`;
    case "yarn": return `yarn global add ${CLI_PACKAGE}`;
    case "bun":  return `bun add -g ${CLI_PACKAGE}`;
    default:     return `npm install -g ${CLI_PACKAGE}`;
  }
}

/**
 * Run the global install. Never throws — returns `false` on any failure
 * (permissions, offline, pkg manager not on PATH). Callers should log
 * the failure + show the manual command as fallback.
 */
export async function installPolpoGlobally(): Promise<{ ok: boolean; pm: string; command: string }> {
  const pm = detectPackageManager();
  const command = globalInstallCommand(pm);
  try {
    await execAsync(command, { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
    return { ok: true, pm, command };
  } catch {
    return { ok: false, pm, command };
  }
}

export function globalInstallHint(): string {
  return globalInstallCommand(detectPackageManager());
}
