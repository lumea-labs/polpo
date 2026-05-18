/**
 * Template system for `polpo create`.
 *
 * Scaffolding is delegated to the separately-published `create-polpo-app`
 * tool (maintained in the polpo-ui repo) — we shell out to it with flags
 * so template logic + download strategy live in one place. Our CLI keeps
 * only the metadata needed to render the wizard picker.
 *
 * For the `empty` option we scaffold a tiny `.polpo/` inline (no network,
 * no external tool) because `create-polpo-app` targets full frontend
 * templates, not blank projects.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Scenario } from "./scenarios.js";

const execAsync = promisify(exec);

export interface TemplateDefinition {
  /** Internal id used in arg `--template` + wizard choice value. */
  id: string;
  /** Label shown in the picker. */
  label: string;
  /** One-line explainer shown as hint. */
  hint?: string;
  /** `blank` uses inline scaffold; `remote` shells to create-polpo-app. */
  kind: "blank" | "remote";
  /** After download, a package.json will exist and deps will get installed. */
  installsDeps?: boolean;
}

/**
 * The picker list. Must be kept in sync manually with the `TEMPLATES`
 * object in polpo-ui/packages/create-app/bin.mjs. If create-polpo-app
 * adds a new template, users can still pass `--template <newname>` —
 * we just won't list it in the interactive picker until updated here.
 */
export const TEMPLATES: TemplateDefinition[] = [
  {
    id: "empty",
    label: "Blank project",
    hint: "just .polpo/ — plug into your existing codebase",
    kind: "blank",
  },
  {
    id: "chat",
    label: "Chat",
    hint: "full-page chat w/ sessions + dark mode (Next.js)",
    kind: "remote",
    installsDeps: true,
  },
  {
    id: "chat-widget",
    label: "Chat widget",
    hint: "embeddable chat widget (Vite/React)",
    kind: "remote",
    installsDeps: true,
  },
  {
    id: "multi-agent",
    label: "Multi-agent",
    hint: "multi-agent workspace (Next.js)",
    kind: "remote",
    installsDeps: true,
  },
];

export function findTemplate(id: string): TemplateDefinition | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

/**
 * Write a minimal .polpo/ scaffold into `targetDir` (blank template).
 * Creates:
 *   .polpo/polpo.json  — project config (projectId added later by create)
 *   .polpo/teams.json  — single "default" team
 *   .polpo/agents.json — array of wrapped agents: [{agent, teamName}]
 *   .env.local.example
 *   README.md
 *
 * Layout follows the canonical format read by FileAgentStore / FileTeamStore
 * and validated by `polpo deploy`: agents live in a single agents.json array
 * with each entry as `{ agent: AgentConfig, teamName: string }`.
 */
export function writeBlankScaffold(targetDir: string, projectName: string, scenario?: Scenario): void {
  fs.mkdirSync(path.join(targetDir, ".polpo"), { recursive: true });

  fs.writeFileSync(
    path.join(targetDir, ".polpo", "polpo.json"),
    JSON.stringify({ project: projectName }, null, 2) + "\n",
  );

  fs.writeFileSync(
    path.join(targetDir, ".polpo", "teams.json"),
    JSON.stringify(
      [{ name: "default", description: "Default team" }],
      null,
      2,
    ) + "\n",
  );

  const agentName = scenario?.agent.name ?? "agent-1";
  const agentRole = scenario?.agent.role ?? "helpful assistant";

  fs.writeFileSync(
    path.join(targetDir, ".polpo", "agents.json"),
    JSON.stringify(
      [
        {
          agent: {
            name: agentName,
            role: agentRole,
            model: "xai/grok-4.1-fast-non-reasoning",
            // Full demo-ready palette: every built-in tool category is
            // enabled out of the box so `polpo create` → first prompt can
            // exercise the whole stack (browser navigation, doc/sheet/pdf
            // creation, web search, image/audio generation, vault lookups,
            // email send). For tighter production agents, strip the
            // categories you don't need.
            allowedTools: [
              "bash", "read", "write", "edit", "glob", "grep", "ls",
              "http_*",
              "browser_*",
              "search_*",
              "vault_*",
              "image_*",
              "audio_*",
              "pdf_*",
              "docx_*",
              "excel_*",
              "email_*",
              "memory_*",
            ],
          },
          teamName: "default",
        },
      ],
      null,
      2,
    ) + "\n",
  );

  fs.writeFileSync(
    path.join(targetDir, ".env.local.example"),
    "# Cloud usage: POLPO_URL is set automatically by `polpo create` to your\n" +
      "# project's subdomain (https://{slug}.polpo.cloud). Override here only for\n" +
      "# self-hosted, custom domains, or local dev.\n" +
      "POLPO_API_KEY=\n" +
      "POLPO_URL=https://your-project-slug.polpo.cloud\n",
  );

  fs.writeFileSync(
    path.join(targetDir, "README.md"),
    `# ${projectName}\n\nBuilt with [Polpo](https://polpo.sh).\n\n` +
      "## Commands\n\n" +
      "```bash\n" +
      "polpo deploy   # push .polpo/ to cloud\n" +
      "polpo logs     # tail cloud logs\n" +
      "```\n",
  );

  if (scenario) writeScenarioSeed(targetDir, scenario);
}

/**
 * Write the scenario's seed data: project + agent memory, a single draft
 * task, and a multi-step draft mission. Caller is responsible for picking
 * `includeTasks: true` when deploying so the task gets pushed alongside
 * the mission (missions are part of the default deploy scope; tasks are
 * opt-in).
 */
function writeScenarioSeed(targetDir: string, scenario: Scenario): void {
  const polpoDir = path.join(targetDir, ".polpo");

  // Project-level shared memory.
  fs.writeFileSync(path.join(polpoDir, "memory.md"), scenario.projectMemory);

  // Per-agent memory under .polpo/memory/<agent>.md
  const memDir = path.join(polpoDir, "memory");
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, `${scenario.agent.name}.md`), scenario.agentMemory);

  // Single draft task.
  const tasksDir = path.join(polpoDir, "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(
    path.join(tasksDir, `${scenario.task.filename}.json`),
    JSON.stringify(scenario.task.payload, null, 2) + "\n",
  );

  // Multi-step draft mission.
  const missionsDir = path.join(polpoDir, "missions");
  fs.mkdirSync(missionsDir, { recursive: true });
  fs.writeFileSync(
    path.join(missionsDir, `${scenario.mission.filename}.json`),
    JSON.stringify(scenario.mission.payload, null, 2) + "\n",
  );
}

export interface RemoteTemplateOptions {
  /** Template id, one of the `kind: "remote"` entries above. */
  templateId: string;
  /** Target directory (must NOT exist yet — create-polpo-app creates it). */
  targetDir: string;
  /** When true, pass `--skip-install` so callers can handle install themselves. */
  skipInstall?: boolean;
}

/**
 * Shell out to `create-polpo-app` with the right flags to scaffold a
 * remote template into `targetDir`.
 *
 * Uses `-y` (non-interactive) so our wizard owns prompts; `create-polpo-app`
 * runs fully scripted.
 */
export async function scaffoldRemoteTemplate(opts: RemoteTemplateOptions): Promise<void> {
  const parent = path.dirname(opts.targetDir);
  const name = path.basename(opts.targetDir);

  const flags = [
    name,
    `--template ${opts.templateId}`,
    "-y",
    opts.skipInstall ? "--skip-install" : null,
  ]
    .filter(Boolean)
    .join(" ");

  await execAsync(`npx --yes create-polpo-app@latest ${flags}`, {
    cwd: parent,
    maxBuffer: 10 * 1024 * 1024,
  });
}
