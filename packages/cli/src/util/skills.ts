/**
 * Install the `lumea-labs/polpo-skills` rule pack for coding agents
 * (Cursor, Claude Code, Windsurf, Codex, Roo, etc.) via the canonical
 * `skills` CLI.
 *
 * Rule packs teach the user's coding agent how to work with Polpo
 * (agents.json schema, `polpo deploy` flow, playbook YAML conventions,
 * ...). They are additive: the `skills` tool merges into existing
 * agent configs rather than replacing them.
 *
 * Scope:
 *   - `global`  → user's machine (~/.claude, ~/.cursor, etc.)
 *                 best when the user works on multiple Polpo projects
 *   - `project` → current directory (.claude/, .cursor/, ...)
 *                 best for repos that want self-contained agent rules
 *   - `skip`    → do nothing, we just print the one-liner in the outro
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export const POLPO_SKILLS_REPO = "lumea-labs/polpo-skills";

export type SkillsScope = "global" | "project" | "skip";

export interface InstallSkillsOptions {
  scope: SkillsScope;
  /** Working directory when scope="project" (defaults to cwd). */
  cwd?: string;
  /** Timeout for the npx subprocess (ms). Default 90s. */
  timeoutMs?: number;
  /**
   * Explicit coding agents to target. Each becomes a `-a <client>` flag.
   * When omitted + `scope="global"`, the upstream `skills` CLI auto-detects
   * every installed agent on the machine (filesystem probe).
   */
  clients?: string[];
}

/**
 * Shell out to `npx skills@latest add lumea-labs/polpo-skills [-g] [-a <c>]... -y`.
 *
 * Returns `true` on success, `false` on failure. We never throw — skills
 * install is an enhancement, not a prerequisite. Callers should log
 * the failure as a warning and continue.
 */
export async function installCodingAgentSkills(opts: InstallSkillsOptions): Promise<boolean> {
  if (opts.scope === "skip") return false;

  const flags: string[] = [
    "--yes", // non-interactive across all prompts inside `skills`
  ];
  if (opts.scope === "global") flags.push("--global");
  for (const client of opts.clients ?? []) {
    flags.push("-a", client);
  }

  const cmd = `npx --yes skills@latest add ${POLPO_SKILLS_REPO} ${flags.join(" ")}`;

  try {
    await execAsync(cmd, {
      cwd: opts.cwd ?? process.cwd(),
      timeout: opts.timeoutMs ?? 90_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

export function skillsInstallHint(): string {
  return `npx skills@latest add ${POLPO_SKILLS_REPO} --global`;
}
