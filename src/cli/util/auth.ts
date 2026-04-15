/**
 * Shared auth helper for cloud commands.
 *
 * `requireAuth()` ensures the user is logged in before running a cloud-scoped
 * command. If credentials are missing, prints a clear hint and exits with 1.
 *
 * Returns the loaded credentials so callers don't need to reload them.
 */
import chalk from "chalk";
import { loadCredentials, type Credentials } from "../commands/cloud/config.js";

export interface RequireAuthOptions {
  /** If true, prints a custom message before the default hint. */
  context?: string;
}

export function requireAuth(opts?: RequireAuthOptions): Credentials {
  const creds = loadCredentials();
  if (!creds) {
    if (opts?.context) {
      console.error(chalk.red(opts.context));
    }
    console.error(chalk.red("Not logged in. Run: ") + chalk.bold("polpo login"));
    process.exit(1);
  }
  return creds;
}

/** Non-fatal variant: returns null instead of exiting. Useful for commands that work both logged-in and out. */
export function getAuth(): Credentials | null {
  return loadCredentials();
}
