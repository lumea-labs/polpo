/**
 * polpo install — one-shot command that makes a user's coding agent
 * "Polpo-aware". It bundles the two steps that, individually, leave the
 * user in a broken state:
 *
 *   1. Device-code auth. Idempotent via `requireAuth()` — no-op if already
 *      signed in. Without this, the skills would instruct the coding agent
 *      to run `polpo` CLI commands that immediately fail for lack of
 *      `~/.polpo/credentials.json`.
 *
 *   2. Skills install. Shells out to the upstream `skills` CLI with
 *      `-a <client>` flags (when the user targeted specific agents) or
 *      `-g` (when they want global auto-detection).
 *
 * Deliberately separate from `polpo link` — `install` is a per-machine /
 * once-per-environment setup; `link` binds a directory to a specific
 * cloud project. Trying to combine them would force machine-setup users
 * to pick a project they don't have yet.
 *
 * Non-interactive by default. `-i` / `--interactive` opts into prompts.
 */
import type { Command } from "commander";
import * as path from "node:path";
import * as clack from "@clack/prompts";
import pc from "picocolors";
import { requireAuth } from "../util/auth.js";
import {
  installCodingAgentSkills,
  skillsInstallHint,
  type SkillsScope,
} from "../util/skills.js";
import { promptForUpdateIfAvailable } from "../update-check.js";

interface InstallOptions {
  client?: string;
  scope?: string;
  dir?: string;
  apiUrl?: string;
  interactive?: boolean;
}

const KNOWN_CLIENTS = [
  { id: "claude-code", label: "Claude Code" },
  { id: "cursor", label: "Cursor" },
  { id: "codex", label: "Codex" },
  { id: "copilot", label: "Copilot" },
  { id: "windsurf", label: "Windsurf" },
  { id: "cline", label: "Cline" },
  { id: "trae", label: "Trae" },
  { id: "roo-code", label: "Roo Code" },
  { id: "qoder", label: "Qoder" },
  { id: "opencode", label: "OpenCode" },
];

function parseClientsCsv(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const list = raw
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  return list.length > 0 ? list : undefined;
}

function normalizeScope(raw: string | undefined): SkillsScope {
  if (raw === "project") return "project";
  return "global";
}

export function registerInstallCommand(program: Command): void {
  program
    .command("install")
    .description(
      "Install Polpo skills for your coding agent (browser sign-in + skills install)",
    )
    .option("--client <list>", "Comma-separated coding agents (e.g. claude-code,cursor)")
    .option("--scope <mode>", "Install scope: global | project", "global")
    .option("-d, --dir <path>", "Working directory when --scope project", ".")
    .option("--api-url <url>", "Override the API base URL (self-hosted / dev)")
    .option("-i, --interactive", "Prompt interactively for choices")
    .action(async (opts: InstallOptions) => {
      clack.intro(pc.bold("Polpo — Install"));

      // Offer an in-flow upgrade if the cached registry check spotted a
      // newer CLI. Smart default: YES (press Enter to update). If the user
      // updates, we exit so they re-run with the new binary.
      const { updated } = await promptForUpdateIfAvailable(program.version() ?? "0.0.0");
      if (updated) process.exit(0);

      let scope = normalizeScope(opts.scope);
      let clients = parseClientsCsv(opts.client);

      if (opts.interactive) {
        const scopeChoice = await clack.select<SkillsScope>({
          message: "Install scope?",
          options: [
            { value: "global", label: "Global", hint: "once per machine, across all projects" },
            { value: "project", label: "Project", hint: "this directory only" },
          ],
          initialValue: scope === "project" ? "project" : "global",
        });
        if (clack.isCancel(scopeChoice)) {
          clack.cancel("Cancelled.");
          process.exit(0);
        }
        scope = scopeChoice;

        const picks = await clack.multiselect<string>({
          message: "Which coding agents?",
          options: KNOWN_CLIENTS.map((c) => ({ value: c.id, label: c.label })),
          initialValues: clients ?? ["claude-code"],
          required: false,
        });
        if (clack.isCancel(picks)) {
          clack.cancel("Cancelled.");
          process.exit(0);
        }
        clients = picks.length > 0 ? picks : undefined;
      }

      // Step 1 — auth. Idempotent: no-op if already signed in.
      await requireAuth({
        apiUrl: opts.apiUrl,
        context: "Installing skills requires a signed-in Polpo session.",
      });

      // Step 2 — skills install.
      const s = clack.spinner();
      const target = clients?.length
        ? `for ${clients.join(", ")}`
        : scope === "project"
          ? "(project)"
          : "(auto-detecting installed agents)";
      s.start(`Installing Polpo skills ${target}…`);

      const ok = await installCodingAgentSkills({
        scope,
        clients,
        cwd: path.resolve(opts.dir ?? "."),
      });

      if (!ok) {
        s.stop("Skills install failed.");
        clack.log.warn(`Try manually: ${pc.bold(skillsInstallHint())}`);
        clack.outro(pc.red("Install failed."));
        process.exit(1);
      }

      s.stop("Polpo skills installed");
      clack.outro(
        pc.green("✓ Your coding agent now knows how to work with Polpo. ") +
          pc.dim("Try: ") +
          pc.bold("\"List the Polpo agents in this project\""),
      );
    });
}
