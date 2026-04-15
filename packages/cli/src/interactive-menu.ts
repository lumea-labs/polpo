/**
 * Interactive bare-command menu.
 *
 * When the user runs `polpo` with no arguments on an interactive TTY,
 * we present a picker of the likely next actions instead of dumping
 * help text. Non-TTY invocations (CI, pipe) fall through to commander's
 * default help — no magic there.
 *
 * The menu is state-aware:
 *   - "Log in" shows only when the user is NOT authenticated
 *   - "Deploy this project" shows only when the cwd has .polpo/polpo.json
 *   - Other actions are always offered
 *
 * Selection dispatches to the real subcommand via `program.parseAsync`,
 * so the action lives in one place (its own command file), not duplicated.
 */
import type { Command } from "commander";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import * as clack from "@clack/prompts";
import chalk from "chalk";
import { loadCredentials } from "./commands/cloud/config.js";

function hasLinkedProject(cwd: string = process.cwd()): boolean {
  return existsSync(resolve(cwd, ".polpo", "polpo.json"));
}

export function isBareInteractiveInvocation(): boolean {
  return process.argv.length <= 2 && !!process.stdout.isTTY && !process.env.CI;
}

export async function runInteractiveMenu(program: Command): Promise<void> {
  const isLoggedIn = !!loadCredentials();
  const linked = hasLinkedProject();

  clack.intro(chalk.bold("Polpo"));

  const options: { value: string; label: string; hint?: string }[] = [];

  if (!isLoggedIn) {
    options.push({ value: "login", label: "Log in to Polpo Cloud" });
  }
  options.push({
    value: "create",
    label: "Create a new project",
    hint: !isLoggedIn ? "requires login" : undefined,
  });
  options.push({
    value: "link",
    label: "Link an existing project",
    hint: !isLoggedIn ? "requires login" : undefined,
  });
  if (linked) {
    options.push({ value: "deploy", label: "Deploy this project" });
  }
  options.push({ value: "projects", label: "List projects" });
  options.push({ value: "docs", label: "View documentation" });
  options.push({ value: "help", label: "Show all commands" });

  const choice = await clack.select<string>({
    message: "What would you like to do?",
    options,
  });

  if (clack.isCancel(choice)) {
    clack.cancel("Cancelled.");
    process.exit(0);
  }

  if (choice === "docs") {
    const { openBrowser } = await import("./util/browser.js");
    await openBrowser("https://docs.polpo.sh");
    clack.outro(chalk.dim("Opened https://docs.polpo.sh"));
    return;
  }

  if (choice === "help") {
    clack.outro(chalk.dim("Showing full command list."));
    program.outputHelp();
    return;
  }

  // Dispatch to the real subcommand. Commander consumes argv shape
  // ['node', 'polpo', '<cmd>', ...args], so we rebuild that here.
  const args = choice === "link" ? [choice, "--help"] : [choice];
  await program.parseAsync([process.argv[0], process.argv[1], ...args]);
}
