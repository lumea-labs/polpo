#!/usr/bin/env node

// Node.js version gate — fail fast with a clear message
const [major] = process.versions.node.split(".").map(Number);
if (major < 20) {
  console.error(`\x1b[31mPolpo requires Node.js >= 20. You have ${process.version}.\x1b[0m`);
  console.error("Install the latest LTS: https://nodejs.org");
  process.exit(1);
}

import { resolve, dirname } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command } from "commander";

const __dirname_cli = dirname(fileURLToPath(import.meta.url));
const pkgPath = resolve(__dirname_cli, "..", "package.json");
const PKG_VERSION = existsSync(pkgPath)
  ? JSON.parse(readFileSync(pkgPath, "utf-8")).version
  : "0.0.0";

// Load .env files from process.cwd() (project-local, then .polpo/.env).
// NOTE: This runs at module top-level, before --dir is parsed. When --dir differs
// from cwd, the correct .env is loaded later via parseConfig/provider overrides.
for (const envPath of [".env", ".polpo/.env"]) {
  try {
    const abs = resolve(envPath);
    if (existsSync(abs)) {
      for (const line of readFileSync(abs, "utf-8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
        if (!process.env[key]) process.env[key] = val;
      }
    }
  } catch { /* ignore */ }
}
import pc from "picocolors";

import { registerModelsCommands } from "./commands/models.js";
// Removed: task, mission, team, memory, config, playbook, skills, schedule,
// agent-onboard, logs, browser-profile — all file-based commands.
// Resources are defined in files and synced via polpo deploy.
import { registerUpdateCommand } from "./commands/update.js";
// Cloud commands (unified CLI)
import { registerLoginCommand } from "./commands/cloud/login.js";
import { registerLogoutCommand } from "./commands/cloud/logout.js";
import { registerDeployCommand } from "./commands/cloud/deploy.js";
import { registerByokCommand } from "./commands/cloud/byok.js";
import { registerProjectsCommand } from "./commands/cloud/projects.js";
import { registerStatusCommand as registerCloudStatusCommand } from "./commands/cloud/status.js";
import { registerLogsCommand as registerCloudLogsCommand } from "./commands/cloud/logs.js";
import { registerLinkCommand } from "./commands/link.js";
import { registerCreateCommand } from "./commands/create.js";
import { registerWhoamiCommand } from "./commands/whoami.js";
import { registerOrgsCommand } from "./commands/orgs.js";
import { startUpdateCheck } from "./update-check.js";
import { isBareInteractiveInvocation, runInteractiveMenu } from "./interactive-menu.js";

// Gradient from pink (#F78B97) to indigo (#3B3E73) — 6 rows
const _logoLines = [
  "██████╗  ██████╗ ██╗     ██████╗  ██████╗",
  "██╔══██╗██╔═══██╗██║     ██╔══██╗██╔═══██╗",
  "██████╔╝██║   ██║██║     ██████╔╝██║   ██║",
  "██╔═══╝ ██║   ██║██║     ██╔═══╝ ██║   ██║",
  "██║     ╚██████╔╝███████╗██║     ╚██████╔╝",
  "╚═╝      ╚═════╝ ╚══════╝╚═╝      ╚═════╝",
];
const _gradColors: [number, number, number][] = [
  [247, 139, 151], // #F78B97
  [209, 119, 135],
  [170, 99, 119],
  [132, 79, 103],
  [93, 59, 87],
  [59, 62, 115],   // #3B3E73
];
/** Apply bold + 24-bit RGB foreground via raw ANSI escapes (picocolors has no truecolor). */
function rgbBold(r: number, g: number, b: number, s: string): string {
  return `\x1b[1;38;2;${r};${g};${b}m${s}\x1b[0m`;
}

function _buildLogo(center = false): string {
  const cols = process.stdout.columns || 80;
  return "\n" + _logoLines.map((l, i) => {
    const pad = center ? " ".repeat(Math.max(0, Math.floor((cols - l.length) / 2))) : "  ";
    const [r, g, b] = _gradColors[i];
    return pad + rgbBold(r, g, b, l);
  }).join("\n") + "\n";
}
const LOGO = _buildLogo(false);

const program = new Command();

program
  .name("polpo-ai")
  .description("The open-source platform for AI agent teams")
  .version(PKG_VERSION)
  .enablePositionalOptions()
  .passThroughOptions()
  // Default (no subcommand): print a short get-started message + help.
  .action(() => {
    console.log(LOGO);
    console.log(
      pc.bold("  Get started:\n") +
      pc.dim("    polpo login                         authenticate\n") +
      pc.dim("    polpo create                        create a new project\n") +
      pc.dim("    polpo link --project-id <id>        link an existing one\n") +
      pc.dim("    polpo deploy                        push to cloud\n"),
    );
    console.log(pc.dim("  See `polpo --help` for all commands."));
  });


// Register subcommand groups
registerModelsCommands(program);
registerUpdateCommand(program);

// Cloud commands
registerLoginCommand(program);
registerLogoutCommand(program);
registerDeployCommand(program);
registerByokCommand(program);
registerProjectsCommand(program);
registerCloudStatusCommand(program);
registerCloudLogsCommand(program);
registerLinkCommand(program);
registerCreateCommand(program);
registerWhoamiCommand(program);
registerOrgsCommand(program);

// Non-blocking update check — prints notice at exit if a new version exists
const printUpdateNotice = startUpdateCheck(PKG_VERSION);
process.on("exit", printUpdateNotice);

// Bare `polpo` on an interactive TTY → show the picker menu.
// Non-TTY (CI/pipe) or any args → standard commander dispatch.
if (isBareInteractiveInvocation()) {
  runInteractiveMenu(program).catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  program.parse();
}
