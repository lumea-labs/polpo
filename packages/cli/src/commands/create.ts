/**
 * polpo create — interactive wizard that creates a new cloud project,
 * scaffolds local files (blank or from a template repo), generates a
 * project-scoped API key, and wires everything up so the user can
 * `cd my-project && npm dev` immediately.
 *
 * Flow:
 *   1. requireAuth()         — auto-browser login if needed
 *   2. pickOrg()             — select organization (auto if one)
 *   3. Project name          — default = dir name
 *   4. Template picker       — blank or remote example
 *   5. Directory name        — where to scaffold
 *   6. Create cloud project  — POST /v1/projects + wait active
 *   7. Generate scoped API key
 *   8. Scaffold files        — inline (blank) or shell to create-polpo-app
 *   9. Write project.json + .env.local
 *  10. Install coding-agent skills (optional wizard step)
 */
import type { Command } from "commander";
import * as fs from "node:fs";
import * as path from "node:path";
import * as clack from "@clack/prompts";
import pc from "picocolors";
import { requireAuth } from "../util/auth.js";
import { createApiClient } from "./cloud/api.js";
import { pickOrg } from "../util/org.js";
import { createProject, waitForProjectActive } from "../util/project.js";
import { createProjectApiKey } from "../util/api-keys.js";
import { writePolpoConfig } from "../util/polpo-config.js";
import {
  TEMPLATES,
  findTemplate,
  writeBlankScaffold,
  scaffoldRemoteTemplate,
  type TemplateDefinition,
} from "../util/template.js";
import { SCENARIOS, findScenario, type Scenario } from "../util/scenarios.js";
import { friendlyError } from "../util/errors.js";
import { slugify } from "../util/slugify.js";
import { installCodingAgentSkills, skillsInstallHint, type SkillsScope } from "../util/skills.js";
import { promptForUpdateIfAvailable } from "../update-check.js";
import { isPolpoOnPath, installPolpoGlobally, globalInstallHint, detectPackageManager } from "../util/install-cli.js";
import { POLPO_API_DOMAIN } from "../util/base-url.js";

interface CreateOptions {
  name?: string;
  orgId?: string;
  template?: string;
  scenario?: string;   // "none" or one of SCENARIOS[].id
  apiUrl?: string;
  skills?: string;
  installCli?: string; // "yes" | "no"
  yes?: boolean;
}

export function registerCreateCommand(program: Command): void {
  program
    .command("create")
    .description("Create a new cloud project + local scaffold")
    .option("--name <name>", "Project name (default: current dir name)")
    .option("--org-id <id>", "Organization ID")
    .option(
      "--template <id>",
      `Template: ${TEMPLATES.map((t) => t.id).join(", ")}`,
    )
    .option("--api-url <url>", "Override the API base URL (self-hosted, custom domain, dev)")
    .option(
      "--scenario <id>",
      `Seed example data: none | ${SCENARIOS.map((s) => s.id).join(" | ")}`,
      "",
    )
    .option("--skills <scope>", "Coding-agent skills install: global | project | skip", "")
    .option("--install-cli <yes|no>", "Install the polpo CLI globally after scaffold", "")
    .option("-y, --yes", "Skip confirmations (use defaults)")
    .action(async (opts: CreateOptions) => {
      clack.intro(pc.bold("Polpo — Create a new project"));

      // Offer an in-flow upgrade before the wizard eats minutes on an
      // outdated binary. Smart default: YES. Exits on successful update
      // so the user lands back on the shell and re-runs with the new CLI.
      const { updated } = await promptForUpdateIfAvailable(program.version() ?? "0.0.0");
      if (updated) process.exit(0);

      // Step 1: Auth (auto-browser if needed)
      const creds = await requireAuth({
        apiUrl: opts.apiUrl,
        context: "Creating a project requires an authenticated session.",
      });
      const client = createApiClient({
        apiKey: creds.apiKey,
        baseUrl: opts.apiUrl ?? creds.baseUrl,
      });

      // Step 2: Organization
      let orgId = opts.orgId;
      if (!orgId) {
        const org = await pickOrg(client);
        orgId = org.id;
      }

      // Step 3: Project name
      let projectName = opts.name;
      if (!projectName) {
        const defaultName = path.basename(process.cwd());
        const name = await clack.text({
          message: "Project name",
          initialValue: defaultName,
          validate: (v) => (v.length < 2 ? "Name must be at least 2 characters" : undefined),
        });
        if (clack.isCancel(name)) {
          clack.cancel("Cancelled.");
          process.exit(0);
        }
        projectName = name;
      }

      // Step 4: Template
      let template: TemplateDefinition | undefined;
      if (opts.template) {
        template = findTemplate(opts.template);
        if (!template) {
          clack.outro(
            pc.red(`Unknown template "${opts.template}". Valid: ${TEMPLATES.map((t) => t.id).join(", ")}`),
          );
          process.exit(1);
        }
      } else {
        const choice = await clack.select<string>({
          message: "How would you like to start?",
          options: TEMPLATES.map((t) => ({
            value: t.id,
            label: t.label,
            hint: t.hint,
          })),
        });
        if (clack.isCancel(choice)) {
          clack.cancel("Cancelled.");
          process.exit(0);
        }
        template = findTemplate(choice)!;
      }

      // Step 4b: Scenario (blank template only — remote templates ship their
      // own .polpo/ scaffold). User can opt into seeded example data: agent +
      // project/agent memory + a single draft task + a multi-step draft mission.
      // Default: none (single empty agent, legacy behavior).
      let scenario: Scenario | undefined;
      if (template.kind === "blank") {
        if (opts.scenario) {
          if (opts.scenario !== "none") {
            scenario = findScenario(opts.scenario);
            if (!scenario) {
              clack.outro(
                pc.red(
                  `Unknown scenario "${opts.scenario}". Valid: none, ${SCENARIOS.map((s) => s.id).join(", ")}`,
                ),
              );
              process.exit(1);
            }
          }
        } else if (!opts.yes) {
          const choice = await clack.select<string>({
            message: "Seed example data? (project memory + draft task + multi-step draft mission)",
            options: [
              { value: "none", label: "No — single empty agent", hint: "current default" },
              ...SCENARIOS.map((s) => ({ value: s.id, label: `Yes — ${s.label}`, hint: s.hint })),
            ],
            initialValue: "none",
          });
          if (clack.isCancel(choice)) {
            clack.cancel("Cancelled.");
            process.exit(0);
          }
          if (choice !== "none") scenario = findScenario(choice);
        }
      }

      // Step 5: Directory
      // Both blank and remote templates ask for a target directory.
      // Blank offers "current directory" as the default (add .polpo/ to
      // an existing project); remote templates always get a subdirectory.
      const originalCwd = process.cwd();
      let targetDir = originalCwd;
      let dirName: string | null = null;

      if (template.kind === "blank" && !opts.yes) {
        const dirChoice = await clack.select<string>({
          message: "Where should we scaffold?",
          options: [
            { value: ".", label: "Current directory", hint: path.basename(originalCwd) },
            { value: "new", label: "New directory" },
          ],
          initialValue: ".",
        });
        if (clack.isCancel(dirChoice)) {
          clack.cancel("Cancelled.");
          process.exit(0);
        }
        if (dirChoice === "new") {
          const defaultDir = slugify(projectName);
          const input = await clack.text({
            message: "Directory name",
            initialValue: defaultDir,
            validate: (v) => (!v || v === "." || v === ".." ? "Invalid directory" : undefined),
          });
          if (clack.isCancel(input)) {
            clack.cancel("Cancelled.");
            process.exit(0);
          }
          const candidate = path.basename(input as string).replace(/[^a-zA-Z0-9._-]/g, "-");
          const resolved = path.resolve(originalCwd, candidate);
          if (fs.existsSync(resolved)) {
            clack.log.warn(`"${candidate}" already exists — scaffolding into it.`);
          } else {
            fs.mkdirSync(resolved, { recursive: true });
          }
          dirName = candidate;
          targetDir = resolved;
        }
      } else if (template.kind === "remote") {
        const defaultDir = slugify(projectName);
        let candidate = opts.yes ? defaultDir : null;
        // Loop until we land on a non-existing directory (or the user cancels).
        while (true) {
          if (candidate === null) {
            const input = await clack.text({
              message: "Directory name",
              initialValue: defaultDir,
              validate: (v) => (!v || v === "." || v === ".." ? "Invalid directory" : undefined),
            });
            if (clack.isCancel(input)) {
              clack.cancel("Cancelled.");
              process.exit(0);
            }
            candidate = path.basename(input as string).replace(/[^a-zA-Z0-9._-]/g, "-");
          }
          const resolved = path.resolve(originalCwd, candidate);
          if (!fs.existsSync(resolved)) {
            dirName = candidate;
            targetDir = resolved;
            break;
          }
          if (opts.yes) {
            clack.outro(pc.red(`Directory "${candidate}" already exists.`));
            process.exit(1);
          }
          clack.log.warn(`"${candidate}" already exists in this folder.`);
          candidate = null; // re-prompt
        }
      }

      // Step 6: Create cloud project
      const s = clack.spinner();
      s.start("Creating project...");
      let project;
      try {
        project = await createProject(client, {
          orgId,
          name: projectName,
        });
      } catch (err) {
        s.stop("Project creation failed.");
        clack.outro(pc.red(friendlyError((err as Error).message)));
        process.exit(1);
      }
      // Project row exists in the cloud now even if `waitForActive` times out.
      // We surface a recovery path so the user can finish the bootstrap manually
      // instead of orphaning a half-provisioned project in the dashboard.
      try {
        s.message("Waiting for project to become active...");
        await waitForProjectActive(client, project.id);
        s.stop(`Project "${project.name}" created`);
      } catch (err) {
        s.stop("Project provisioning timed out — but the project was created.");
        clack.log.warn(`Project ID: ${pc.bold(project.id)} (check it in the dashboard)`);
        clack.log.info(
          `Once it shows as active, finish setup with: ${pc.bold(`polpo link --project-id ${project.id}`)}`,
        );
        clack.outro(pc.red(friendlyError((err as Error).message)));
        process.exit(1);
      }

      // Step 7: Project-scoped API key
      s.start("Generating API key...");
      let apiKey;
      try {
        apiKey = await createProjectApiKey(client, orgId, project.id, "Created by polpo create");
        s.stop("API key generated");
      } catch (err) {
        s.stop("API key generation failed.");
        clack.log.warn(
          `Could not auto-create a project API key: ${(err as Error).message}`,
        );
        clack.log.info("You can create one later from the dashboard → /keys");
      }

      // Step 8: Scaffold
      if (template.kind === "blank") {
        s.start("Writing .polpo/ scaffold...");
        try {
          writeBlankScaffold(targetDir, projectName, scenario);
          s.stop(".polpo/ scaffold written");
        } catch (err) {
          s.stop("Scaffold failed.");
          clack.outro(pc.red((err as Error).message));
          process.exit(1);
        }
      } else {
        s.start(`Scaffolding template (${template.id})...`);
        try {
          // Delegates to `create-polpo-app` which handles download + npm install.
          await scaffoldRemoteTemplate({
            templateId: template.id,
            targetDir,
          });
          s.stop("Template ready");
        } catch (err) {
          s.stop("Template scaffold failed.");
          clack.log.warn(`${(err as Error).message}`);
          clack.log.info("You can retry manually: `npx create-polpo-app@latest`. Falling back to blank scaffold.");
          if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
          writeBlankScaffold(targetDir, projectName, scenario);
        }
      }

      // Step 9: Write project.json + .env.local
      // The data plane URL is derived from the slug — `{slug}.polpo.cloud`.
      // For self-hosted or custom-domain users, set `apiUrl` in project.json
      // (or the POLPO_URL env var at runtime) to override.
      const tenantUrl = project.slug
        ? `https://${project.slug}.${POLPO_API_DOMAIN}`
        : creds.baseUrl;

      writePolpoConfig(targetDir, {
        project: project.name,
        projectSlug: project.slug,
        projectId: project.id,
      });

      if (apiKey) {
        const envLocal = path.join(targetDir, ".env.local");

        // Env var names — consistent across templates (Supabase pattern):
        // - POLPO_URL (the project endpoint)
        // - POLPO_API_KEY (the scoped key)
        // Remote templates prefix with NEXT_PUBLIC_ so the Next.js app
        // can read them client-side. Blank template stays unprefixed.
        const prefix = template.kind === "remote" ? "NEXT_PUBLIC_" : "";
        const urlVar = `${prefix}POLPO_URL`;
        const keyVar = `${prefix}POLPO_API_KEY`;

        const envContent = `${keyVar}=${apiKey.rawKey}\n${urlVar}=${tenantUrl}\n`;

        // Overwrite: remote templates (via create-polpo-app) write an
        // incomplete .env.local with just the key placeholder. We need
        // to replace it with the full, correct credentials.
        try {
          fs.writeFileSync(envLocal, envContent, { flag: "w" });
          clack.log.info(`Wrote ${pc.bold(".env.local")} with project credentials`);
        } catch (err) {
          clack.log.warn(`Could not write .env.local: ${(err as Error).message}`);
          console.log(pc.bold(`    ${keyVar}=${apiKey.rawKey}`));
        }
      }

      // Step 10: Coding-agent skills
      let skillsScope: SkillsScope;
      if (opts.skills === "global" || opts.skills === "project" || opts.skills === "skip") {
        skillsScope = opts.skills;
      } else if (opts.yes) {
        skillsScope = "global";
      } else {
        const choice = await clack.select<SkillsScope>({
          message: "Install skills for your coding agent? (Cursor, Claude Code, Windsurf, …)",
          options: [
            { value: "global", label: "Yes, globally", hint: "recommended — once per machine" },
            { value: "project", label: "Yes, just for this project" },
            { value: "skip", label: "Skip" },
          ],
          initialValue: "global",
        });
        if (clack.isCancel(choice)) {
          skillsScope = "skip";
        } else {
          skillsScope = choice;
        }
      }

      let skillsInstalled = false;
      if (skillsScope !== "skip") {
        s.start(`Installing coding-agent skills (${skillsScope})...`);
        skillsInstalled = await installCodingAgentSkills({ scope: skillsScope, cwd: targetDir });
        if (skillsInstalled) {
          s.stop("Coding-agent skills installed");
        } else {
          s.stop("Coding-agent skills install failed.");
          clack.log.warn(`Install manually later: ${pc.bold(skillsInstallHint())}`);
        }
      }

      // Step 11: Install polpo globally (skip if already on PATH)
      let cliInstalled = false;
      let cliInstallCommand = globalInstallHint();
      if (!isPolpoOnPath()) {
        let doInstall: boolean;
        if (opts.installCli === "yes") doInstall = true;
        else if (opts.installCli === "no") doInstall = false;
        else if (opts.yes) doInstall = true;
        else {
          const choice = await clack.confirm({
            message: "Install polpo CLI globally so you can run `polpo` from anywhere?",
            initialValue: true,
          });
          doInstall = !clack.isCancel(choice) && !!choice;
        }

        if (doInstall) {
          s.start("Installing polpo CLI globally...");
          const result = await installPolpoGlobally();
          cliInstallCommand = result.command;
          if (result.ok) {
            s.stop("polpo CLI installed");
            cliInstalled = true;
          } else {
            s.stop("Global install failed.");
            clack.log.warn(`Install manually later: ${pc.bold(result.command)}`);
          }
        }
      } else {
        cliInstalled = true; // already on PATH
      }

      // Step 12: Deploy .polpo/ to cloud
      // Scaffolded agents live on disk but need to be pushed so the
      // project's sandbox/data-plane can actually see them. We call the
      // shared runDeploy() directly — same code path as `polpo deploy`,
      // but without its own intro/outro/process.exit (we're inside the
      // create wizard, still framing the UI).
      let deployOk = false;
      try {
        s.start("Deploying agents to cloud...");
        const { runDeploy } = await import("./cloud/deploy.js");
        const report = await runDeploy({
          dir: targetDir,
          yes: true,
          force: true,
          silent: true,
          // When a scenario was seeded, we also want the standalone draft task
          // pushed alongside the mission so the dashboard lights up immediately.
          // Missions are part of the default scope; tasks are opt-in.
          includeTasks: !!scenario,
        });
        if (report.nothingToDeploy) {
          s.stop("Nothing to deploy.");
        } else if (report.total.failed > 0) {
          s.stop(`Deploy completed with ${report.total.failed} failures.`);
        } else {
          const parts: string[] = [];
          if (report.total.created > 0) parts.push(`${report.total.created} created`);
          if (report.total.updated > 0) parts.push(`${report.total.updated} updated`);
          s.stop(parts.length ? `Deployed (${parts.join(", ")})` : "Deployed");
          deployOk = true;
        }
      } catch (err) {
        s.stop("Deploy failed — you can retry manually.");
        clack.log.warn(`Deploy error: ${(err as Error).message}`);
      }

      // Detect the package manager the remote template used so we can
      // suggest the right `<pm> run dev` in the outro.
      const pm = detectPackageManager();
      const devCmd =
        pm === "bun" ? "bun dev"
        : pm === "pnpm" ? "pnpm dev"
        : pm === "yarn" ? "yarn dev"
        : "npm run dev";

      // Outro
      const relDir = dirName ?? ".";
      const polpoRun = cliInstalled ? "polpo" : `npx ${CLI_PACKAGE_FOR_OUTRO}`;
      const cdLine = dirName ? `cd ${dirName}` : undefined;

      const lines: string[] = [];
      lines.push(pc.green(`✓ Project "${project.name}" ready in ${relDir}`));
      if (deployOk) {
        lines.push(pc.dim("  Agents deployed. Your project is live."));
      }
      lines.push("");

      // Section 1: Navigate + run
      if (template.installsDeps) {
        // Remote template — Next.js / Vite app. Tell the user how to start it.
        lines.push(pc.dim("  Start the app:"));
        if (cdLine) lines.push(`    ${pc.bold(cdLine)}`);
        lines.push(`    ${pc.bold(devCmd)}`);
        lines.push("");
      } else {
        // Blank template — no frontend. Give the user a two-step flow:
        // 1) export both env vars into the current shell (so any subsequent
        //    curl / SDK call just works without sourcing .env.local)
        // 2) a sample curl that references the exported vars
        if (cdLine) {
          lines.push(pc.dim("  Navigate:"));
          lines.push(`    ${pc.bold(cdLine)}`);
          lines.push("");
        }
        const keyValue = apiKey?.rawKey ?? "<your-api-key>";
        lines.push(pc.dim("  Load credentials into your shell:"));
        lines.push(`    ${pc.bold(`export POLPO_API_KEY=${keyValue} POLPO_URL=${tenantUrl}`)}`);
        lines.push("");
        lines.push(pc.dim("  Talk to your agent:"));
        lines.push(`    ${pc.bold(`curl $POLPO_URL/v1/chat/completions \\`)}`);
        lines.push(`      ${pc.bold(`-H "Authorization: Bearer $POLPO_API_KEY" \\`)}`);
        lines.push(`      ${pc.bold(`-H "Content-Type: application/json" \\`)}`);
        const exampleAgent = scenario?.agent.name ?? "agent-1";
        lines.push(`      ${pc.bold(`-d '{"agent":"${exampleAgent}","stream":true,"messages":[{"role":"user","content":"Hello"}]}'`)}`);
        lines.push("");
      }

      // Section 2: Modify
      lines.push(pc.dim("  Modify your agents:"));
      lines.push(`    ${pc.dim("Edit")} ${pc.bold(".polpo/agents/<agent>/")} ${pc.dim("and run")} ${pc.bold(`${polpoRun} deploy`)}`);
      if (skillsInstalled) {
        lines.push(`    ${pc.dim("Or ask your coding agent:")} ${pc.bold('"Modify my Polpo agents"')}`);
      }
      lines.push("");

      // Section 3: Fallbacks
      if (!deployOk) {
        lines.push(pc.dim(`  Deploy now: ${pc.bold(`${polpoRun} deploy`)}`));
      }
      if (skillsScope === "skip") {
        lines.push(pc.dim(`  Install coding-agent skills later: ${pc.bold(skillsInstallHint())}`));
      }
      if (!cliInstalled) {
        lines.push(pc.dim(`  Install CLI globally: ${pc.bold(cliInstallCommand)}`));
      }

      clack.outro(lines.join("\n"));
    });
}

const CLI_PACKAGE_FOR_OUTRO = "@polpo-ai/cli";
