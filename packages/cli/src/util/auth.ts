/**
 * Smart auth helper for cloud commands.
 *
 * `requireAuth()` ensures the user is logged in before a cloud-scoped
 * command runs. Behaviour:
 *
 *   - Credentials present → returns them.
 *   - Credentials missing + interactive TTY → prints a notice, triggers
 *     the device-code browser flow, retries once on failure, returns
 *     the new credentials on success.
 *   - Credentials missing + non-interactive (CI, pipe) → exits with a
 *     clear hint pointing at `polpo login`.
 *
 * The retry loop keeps the user unblocked without a separate "run login
 * and come back" round-trip.
 */
import pc from "picocolors";
import * as clack from "@clack/prompts";
import { loadCredentials, type Credentials } from "../commands/cloud/config.js";
import { performDeviceCodeLogin, DeviceCodeError } from "./device-code.js";

export interface RequireAuthOptions {
  /** Override the API base URL (default from env or creds). */
  apiUrl?: string;
  /** Override the dashboard URL hosting the approval page. */
  dashboardUrl?: string;
  /** Optional context line printed before the login hint (e.g. "Deploying requires an account"). */
  context?: string;
}

function isInteractive(): boolean {
  return !!process.stdout.isTTY && !process.env.CI;
}

export async function requireAuth(
  opts: RequireAuthOptions = {},
): Promise<Credentials> {
  const existing = loadCredentials();
  if (existing) return existing;

  if (!isInteractive()) {
    if (opts.context) console.error(pc.red(opts.context));
    console.error(pc.red("Not logged in. Run: ") + pc.bold("polpo login"));
    process.exit(1);
  }

  // Interactive: trigger login inline, retry once on recoverable failure.
  if (opts.context) clack.log.info(opts.context);
  clack.log.info("You need to log in to continue.");

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await performDeviceCodeLogin({
        apiUrl: opts.apiUrl,
        dashboardUrl: opts.dashboardUrl,
      });
    } catch (err) {
      if (err instanceof DeviceCodeError) {
        clack.log.warn(`Login failed: ${err.message}`);
        if (attempt === 0 && (err.reason === "expired" || err.reason === "timeout")) {
          const retry = await clack.confirm({
            message: "Would you like to try again?",
            initialValue: true,
          });
          if (clack.isCancel(retry) || !retry) break;
          continue;
        }
        break;
      }
      throw err;
    }
  }

  clack.outro(
    pc.red("Authentication required. Run ") +
      pc.bold("polpo login") +
      pc.red(" to try again."),
  );
  process.exit(1);
}

/** Non-fatal variant: returns null when not logged in. For commands that work both ways. */
export function getAuth(): Credentials | null {
  return loadCredentials();
}
