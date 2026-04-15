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
 *   9. Write polpo.json + .env.local
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
import { friendlyError } from "../util/errors.js";
import { slugify } from "../util/slugify.js";
import { installCodingAgentSkills, skillsInstallHint, type SkillsScope } from "../util/skills.js";
import { isPolpoOnPath, installPolpoGlobally, globalInstallHint } from "../util/install-cli.js";
import { POLPO_API_DOMAIN } from "../util/base-url.js";

interface CreateOptions {
  name?: string;
  orgId?: string;
  template?: string;
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
    .option("--skills <scope>", "Coding-agent skills install: global | project | skip", "")
    .option("--install-cli <yes|no>", "Install the polpo CLI globally after scaffold", "")
    .option("-y, --yes", "Skip confirmations (use defaults)")
    .action(async (opts: CreateOptions) => {
      clack.intro(pc.bold("Polpo — Create a new project"));

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

      // Step 5: Directory
      // Blank templates can scaffold into cwd; remote templates always
      // get their own subdirectory.
      const originalCwd = process.cwd();
      let targetDir = originalCwd;
      let dirName: string | null = null;
      if (template.kind === "remote") {
        const defaultDir = slugify(projectName);
        const input = opts.yes
          ? defaultDir
          : await clack.text({
              message: "Directory name",
              initialValue: defaultDir,
              validate: (v) => (!v || v === "." || v === ".." ? "Invalid directory" : undefined),
            });
        if (clack.isCancel(input)) {
          clack.cancel("Cancelled.");
          process.exit(0);
        }
        dirName = path.basename(input as string).replace(/[^a-zA-Z0-9._-]/g, "-");
        targetDir = path.resolve(originalCwd, dirName);
        if (fs.existsSync(targetDir)) {
          clack.outro(pc.red(`Directory "${dirName}" already exists.`));
          process.exit(1);
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
        s.message("Waiting for project to become active...");
        await waitForProjectActive(client, project.id);
        s.stop(`Project "${project.name}" created`);
      } catch (err) {
        s.stop("Project creation failed.");
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
          writeBlankScaffold(targetDir, projectName);
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
          writeBlankScaffold(targetDir, projectName);
        }
      }

      // Step 9: Write polpo.json + .env.local
      // The data plane URL is derived from the slug — `{slug}.polpo.cloud`.
      // For self-hosted or custom-domain users, set `apiUrl` in polpo.json
      // (or the POLPO_API_URL env var at runtime) to override.
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
        const envContent =
          `POLPO_API_KEY=${apiKey.rawKey}\n` +
          `POLPO_API_URL=${tenantUrl}\n`;
        try {
          fs.writeFileSync(envLocal, envContent, { flag: "wx" });
          clack.log.info(`Wrote ${pc.bold(".env.local")} with project credentials`);
        } catch {
          // .env.local exists already — leave it alone, just log the key once.
          clack.log.warn(".env.local exists — not overwriting. Your key:");
          console.log(pc.bold(`    POLPO_API_KEY=${apiKey.rawKey}`));
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

      // Outro
      const relDir = dirName ?? ".";
      const polpoRun = cliInstalled ? "polpo" : `npx ${CLI_PACKAGE_FOR_OUTRO}`;
      const nextSteps = [
        dirName ? `cd ${dirName}` : undefined,
        template.installsDeps ? "npm run dev" : undefined,
        `${polpoRun} deploy`,
        skillsScope === "skip" ? `# skills: ${skillsInstallHint()}` : undefined,
        !cliInstalled ? `# install polpo: ${cliInstallCommand}` : undefined,
      ].filter(Boolean) as string[];
      clack.outro(
        pc.green(`✓ Project "${project.name}" ready in ${relDir}\n`) +
          pc.dim("  Next:\n") +
          nextSteps.map((step) => pc.dim(`    ${step}\n`)).join(""),
      );
    });
}

const CLI_PACKAGE_FOR_OUTRO = "@polpo-ai/cli";
