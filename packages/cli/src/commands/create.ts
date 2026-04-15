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
 *   8. Scaffold files        — inline (blank) or tiged clone
 *   9. Write polpo.json + .env.local
 *  10. npm install (if template has package.json)
 */
import type { Command } from "commander";
import * as fs from "node:fs";
import * as path from "node:path";
import * as clack from "@clack/prompts";
import chalk from "chalk";
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
import { installPolpoSkills, skillsInstallHint, type SkillsScope } from "../util/skills.js";

interface CreateOptions {
  name?: string;
  orgId?: string;
  template?: string;
  url?: string;
  skills?: string;
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
    .option("--url <base-url>", "API base URL override")
    .option("--skills <scope>", "Editor skills install: global | project | skip", "")
    .option("-y, --yes", "Skip confirmations (use defaults)")
    .action(async (opts: CreateOptions) => {
      clack.intro(chalk.bold("Polpo — Create a new project"));

      // Step 1: Auth (auto-browser if needed)
      const creds = await requireAuth({
        apiUrl: opts.url,
        context: "Creating a project requires an authenticated session.",
      });
      const client = createApiClient({
        apiKey: creds.apiKey,
        baseUrl: opts.url ?? creds.baseUrl,
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
            chalk.red(`Unknown template "${opts.template}". Valid: ${TEMPLATES.map((t) => t.id).join(", ")}`),
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
          clack.outro(chalk.red(`Directory "${dirName}" already exists.`));
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
        clack.outro(chalk.red(friendlyError((err as Error).message)));
        process.exit(1);
      }

      // Step 7: Project-scoped API key
      s.start("Generating API key...");
      let apiKey;
      try {
        apiKey = await createProjectApiKey(client, project.id, "Created by polpo create");
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
          clack.outro(chalk.red((err as Error).message));
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
      writePolpoConfig(targetDir, {
        project: project.name,
        projectId: project.id,
        apiUrl: creds.baseUrl,
      });

      if (apiKey) {
        const envLocal = path.join(targetDir, ".env.local");
        const envContent =
          `POLPO_API_KEY=${apiKey.key}\n` +
          `POLPO_API_URL=${creds.baseUrl}\n`;
        try {
          fs.writeFileSync(envLocal, envContent, { flag: "wx" });
          clack.log.info(`Wrote ${chalk.bold(".env.local")} with project credentials`);
        } catch {
          // .env.local exists already — leave it alone, just log the key once.
          clack.log.warn(".env.local exists — not overwriting. Your key:");
          console.log(chalk.bold(`    POLPO_API_KEY=${apiKey.key}`));
        }
      }

      // Step 10: Editor skills
      let skillsScope: SkillsScope;
      if (opts.skills === "global" || opts.skills === "project" || opts.skills === "skip") {
        skillsScope = opts.skills;
      } else if (opts.yes) {
        skillsScope = "global";
      } else {
        const choice = await clack.select<SkillsScope>({
          message: "Install editor skills? (rules for Cursor, Claude Code, Windsurf, …)",
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
        s.start(`Installing editor skills (${skillsScope})...`);
        skillsInstalled = await installPolpoSkills({ scope: skillsScope, cwd: targetDir });
        if (skillsInstalled) {
          s.stop("Editor skills installed");
        } else {
          s.stop("Editor skills install failed.");
          clack.log.warn(`Install manually later: ${chalk.bold(skillsInstallHint())}`);
        }
      }

      // Outro
      const relDir = dirName ?? ".";
      const nextSteps = [
        dirName ? `cd ${dirName}` : undefined,
        template.installsDeps ? "npm run dev" : undefined,
        "polpo deploy",
        skillsScope === "skip" ? `# skills: ${skillsInstallHint()}` : undefined,
      ].filter(Boolean) as string[];
      clack.outro(
        chalk.green(`✓ Project "${project.name}" ready in ${relDir}\n`) +
          chalk.dim("  Next:\n") +
          nextSteps.map((step) => chalk.dim(`    ${step}\n`)).join(""),
      );
    });
}
