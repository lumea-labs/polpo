/**
 * polpo logout — clear stored credentials.
 */
import type { Command } from "commander";
import pc from "picocolors";
import { loadCredentials, clearCredentials } from "./config.js";

export function registerLogoutCommand(program: Command): void {
  program
    .command("logout")
    .description("Clear stored credentials")
    .action(() => {
      const had = loadCredentials() !== null;
      clearCredentials();
      console.log(had ? pc.green("✓ Logged out.") : pc.dim("You weren't logged in."));
    });
}
