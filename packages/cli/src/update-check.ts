/**
 * Non-blocking update checker.
 *
 * Fires a single HTTP GET to the npm registry at CLI startup.
 * If a newer version exists, prints a one-liner after the command finishes.
 * Never blocks, never throws, never slows anything down.
 *
 * Rate-limited to once per 24 hours via a tiny timestamp file in ~/.polpo/.
 */

import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import * as clack from "@clack/prompts";
import pc from "picocolors";
import { runSelfUpdate } from "./util/self-update.js";

const PACKAGE_NAME = "polpo-ai";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** File where we store the last check timestamp + latest version. */
function stateFilePath(): string {
  const dir = join(homedir(), ".polpo");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return resolve(dir, ".update-check");
}

interface CheckState {
  lastCheck: number;
  latestVersion?: string;
}

function readState(): CheckState {
  try {
    const raw = readFileSync(stateFilePath(), "utf-8");
    return JSON.parse(raw);
  } catch {
    return { lastCheck: 0 };
  }
}

function writeState(state: CheckState): void {
  try {
    writeFileSync(stateFilePath(), JSON.stringify(state));
  } catch { /* best-effort */ }
}

/**
 * Compare two semver strings. Returns true if `remote` is newer than `local`.
 */
function isNewer(local: string, remote: string): boolean {
  const a = local.split(".").map(Number);
  const b = remote.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((b[i] || 0) > (a[i] || 0)) return true;
    if ((b[i] || 0) < (a[i] || 0)) return false;
  }
  return false;
}

/**
 * Start a non-blocking update check. Returns a function you call at exit
 * to print the update notice (if any). Safe to ignore the return value.
 */
export function startUpdateCheck(currentVersion: string): () => void {
  // Respect POLPO_NO_UPDATE_CHECK=1 or CI environments
  if (
    process.env.POLPO_NO_UPDATE_CHECK === "1" ||
    process.env.CI === "true" ||
    process.env.NO_COLOR !== undefined
  ) {
    return () => {};
  }

  const state = readState();
  const now = Date.now();

  // Already checked recently — use cached result
  if (now - state.lastCheck < CHECK_INTERVAL_MS && state.latestVersion) {
    if (isNewer(currentVersion, state.latestVersion)) {
      return () => printNotice(currentVersion, state.latestVersion!);
    }
    return () => {};
  }

  // Fire-and-forget fetch — never awaited, never blocks
  let latestVersion: string | undefined;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, {
    signal: controller.signal,
    headers: { Accept: "application/json" },
  })
    .then((r) => r.json())
    .then((data: any) => {
      clearTimeout(timeout);
      latestVersion = data.version;
      writeState({ lastCheck: now, latestVersion });
    })
    .catch(() => {
      clearTimeout(timeout);
      /* offline, timeout, etc. — silently ignore */
    });

  // Return a sync function that the caller invokes when the CLI is about to exit
  return () => {
    if (latestVersion && isNewer(currentVersion, latestVersion)) {
      printNotice(currentVersion, latestVersion);
    }
  };
}

/**
 * Interactive update prompt intended to run at the **start** of long-lived
 * commands (`install`, `create`). Reuses the cached npm registry probe
 * written by `startUpdateCheck` — zero extra network round-trips.
 *
 * Flow when cached version > current:
 *   1. TTY check + respect POLPO_NO_UPDATE_CHECK / CI → otherwise no-op
 *   2. `clack.confirm` with default = yes (smart default: update)
 *   3. Run the upgrade in-process via the detected package manager
 *   4. On success → instruct the user to re-run their original command
 *      (we don't auto re-exec: argv0 can be anything from `node`, `npx`,
 *      a symlink, the Electron desktop app, etc. Safer to let the user
 *      re-invoke explicitly.)
 *
 * Returns:
 *   - `{ updated: true }`  → caller should `process.exit(0)` so the user
 *     lands back on the shell to re-run with the new binary
 *   - `{ updated: false }` → no update needed or declined; keep going
 */
export async function promptForUpdateIfAvailable(
  currentVersion: string,
): Promise<{ updated: boolean }> {
  // Bail fast on non-interactive contexts — we never trap scripts in prompts.
  if (
    !process.stdin.isTTY ||
    process.env.POLPO_NO_UPDATE_CHECK === "1" ||
    process.env.CI === "true"
  ) {
    return { updated: false };
  }

  const state = readState();
  if (!state.latestVersion || !isNewer(currentVersion, state.latestVersion)) {
    return { updated: false };
  }

  const latest = state.latestVersion;
  const answer = await clack.confirm({
    message: `A newer version of Polpo is available: ${currentVersion} → ${latest}. Update now?`,
    initialValue: true,
  });

  if (clack.isCancel(answer) || !answer) {
    clack.log.info(
      pc.dim(`Skipping update. Run ${pc.bold("polpo update")} later to install ${latest}.`),
    );
    return { updated: false };
  }

  const s = clack.spinner();
  s.start(`Updating Polpo to ${latest}…`);
  const result = runSelfUpdate(latest);
  if (!result.success) {
    s.stop("Update failed.");
    clack.log.warn(
      `Could not update automatically: ${result.error ?? "unknown error"}.`,
    );
    clack.log.info(
      pc.dim(`Try manually: ${pc.bold(result.cmd)}`) +
        pc.dim(`  (continuing with ${currentVersion}…)`),
    );
    return { updated: false };
  }
  s.stop(`Updated to ${latest}`);
  clack.outro(
    pc.green("✓ Update installed. ") +
      pc.dim("Re-run your command to use the new version."),
  );
  return { updated: true };
}

function printNotice(current: string, latest: string): void {
  // Plain ANSI escapes — no color lib needed for a single-line notice
  const yellow = "\x1b[33m";
  const cyan = "\x1b[36m";
  const dim = "\x1b[2m";
  const bold = "\x1b[1m";
  const reset = "\x1b[0m";

  process.stderr.write(
    `\n${yellow}${bold}  Update available!${reset} ${dim}${current}${reset} → ${cyan}${bold}${latest}${reset}\n` +
    `${dim}  Run ${reset}${cyan}polpo update${reset}${dim} to upgrade${reset}\n\n`,
  );
}
