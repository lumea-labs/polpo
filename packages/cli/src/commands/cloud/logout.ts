/**
 * polpo logout — clear stored credentials.
 */
import type { Command } from "commander";
import * as clack from "@clack/prompts";
import pc from "picocolors";
import { loadCredentials, clearCredentials } from "./config.js";

export function registerLogoutCommand(program: Command): void {
  program
    .command("logout")
    .description("Clear stored credentials")
    .action(() => {
      clack.intro(pc.bold("Polpo — Logout"));

      const had = loadCredentials() !== null;
      clearCredentials();

      if (had) {
        clack.outro(pc.green("Logged out."));
      } else {
        clack.outro(pc.dim("You weren't logged in."));
      }
    });
}
