/**
 * polpo link — attach the current directory to an existing cloud project.
 *
 *   polpo link --project-id <uuid>
 *
 * Full setup in one command:
 *   1. Update check (reuse cached registry probe)
 *   2. Auth (device-code login if needed)
 *   3. Verify the cloud project exists
 *   4. Write .polpo/polpo.json with project reference
 *   5. Pull all resources from cloud → local .polpo/
 *   6. Generate a project-scoped API key + .env.local
 *   7. Install coding-agent skills (global/project/skip)
 *   8. Install CLI globally (if not already on PATH)
 *   9. Outro with next steps (modify, not deploy)
 *
 * The pull step (5) is the key difference from the old link: it
 * downloads agents.json, teams.json, memory, skills, missions, etc.
 * from the cloud so the user can start modifying immediately.
 * Think of it as `drizzle-kit introspect` — cloud → local filesystem.
 */
import type { Command } from "commander";
import * as path from "node:path";
import * as clack from "@clack/prompts";
import pc from "picocolors";
import { requireAuth } from "../util/auth.js";
import { createApiClient } from "./cloud/api.js";
import { getProject } from "../util/project.js";
import { writePolpoConfig, readPolpoConfig } from "../util/polpo-config.js";
import { createProjectApiKey } from "../util/api-keys.js";
import { pullProject } from "../util/pull.js";
import { friendlyError } from "../util/errors.js";
import { installCodingAgentSkills, skillsInstallHint, type SkillsScope } from "../util/skills.js";
import { promptForUpdateIfAvailable } from "../update-check.js";
import { isPolpoOnPath, installPolpoGlobally, globalInstallHint } from "../util/install-cli.js";
import { POLPO_API_DOMAIN } from "../util/base-url.js";
import * as fs from "node:fs";

export function registerLinkCommand(program: Command): void {
  program
    .command("link")
    .description("Link the current directory to an existing cloud project")
    .requiredOption("--project-id <id>", "Cloud project UUID")
    .option("-d, --dir <path>", "Working directory", ".")
    .option("--api-url <url>", "Override the API base URL (self-hosted, custom domain, dev)")
    .option("-y, --yes", "Skip confirmations (use defaults)")
    .action(async (opts) => {
      clack.intro(pc.bold("Polpo — Link project"));

      // Step 1: Update check
      const { updated } = await promptForUpdateIfAvailable(program.version() ?? "0.0.0");
      if (updated) process.exit(0);

      // Step 2: Auth
      const creds = await requireAuth({
        apiUrl: opts.apiUrl,
        context: "Linking a project requires an authenticated session.",
      });

      const cpClient = createApiClient({
        apiKey: creds.apiKey,
        baseUrl: opts.apiUrl ?? creds.baseUrl,
      });

      // Step 3: Verify project
      const s = clack.spinner();
      s.start("Verifying project...");
      let project;
      try {
        project = await getProject(cpClient, opts.projectId);
        if (!project) {
          s.stop("Project not found.");
          clack.outro(
            pc.red(`No project with id ${opts.projectId} — check the URL or run `) +
              pc.bold("polpo projects list"),
          );
          process.exit(1);
        }
        s.stop(`Project: ${project.name}`);
      } catch (err) {
        s.stop("Failed to verify project.");
        clack.outro(pc.red(friendlyError((err as Error).message)));
        process.exit(1);
      }

      const cwd = path.resolve(opts.dir);

      // Warn if already linked to a different project.
      const existing = readPolpoConfig(cwd);
      if (existing?.projectId && existing.projectId !== project.id) {
        const ok = await clack.confirm({
          message: `This directory is already linked to "${existing.project ?? existing.projectId}". Replace?`,
          initialValue: false,
        });
        if (clack.isCancel(ok) || !ok) {
          clack.cancel("Cancelled.");
          process.exit(0);
        }
      }

      // Step 4: Write polpo.json
      writePolpoConfig(cwd, {
        project: project.name,
        projectSlug: project.slug,
        projectId: project.id,
      });
      clack.log.success(`Wrote ${pc.bold(".polpo/polpo.json")}`);

      // Step 5: Pull resources from cloud
      const polpoDir = path.join(cwd, ".polpo");
      const dpClient = createApiClient(creds, project.id);

      const isInteractive = !opts.yes && !!process.stdin.isTTY;
      s.start("Pulling resources from cloud...");
      const pullResult = await pullProject(dpClient, polpoDir, {
        force: !!opts.yes,
        interactive: isInteractive,
      });
      if (pullResult.pulled.length > 0) {
        s.stop(`Pulled: ${pullResult.pulled.join(", ")}`);
      } else {
        s.stop("No resources to pull (empty project)");
      }
      if (pullResult.errors.length > 0) {
        for (const err of pullResult.errors) {
          clack.log.warn(err);
        }
      }

      // Step 6: Generate API key + .env.local
      const tenantUrl = project.slug
        ? `https://${project.slug}.${POLPO_API_DOMAIN}`
        : creds.baseUrl;

      s.start("Generating API key...");
      let apiKey;
      try {
        apiKey = await createProjectApiKey(cpClient, project.orgId ?? "", project.id, "Created by polpo link");
        s.stop("API key generated");
      } catch (err) {
        s.stop("API key generation failed.");
        clack.log.warn(`Could not auto-create a project API key: ${(err as Error).message}`);
        clack.log.info("You can create one later from the dashboard.");
      }

      if (apiKey) {
        const envLocal = path.join(cwd, ".env.local");
        const envContent =
          `POLPO_API_KEY=${apiKey.rawKey}\n` +
          `POLPO_API_URL=${tenantUrl}\n`;
        try {
          fs.writeFileSync(envLocal, envContent, { flag: "wx" });
          clack.log.info(`Wrote ${pc.bold(".env.local")} with project credentials`);
        } catch {
          clack.log.warn(".env.local exists — not overwriting. Your key:");
          console.log(pc.bold(`    POLPO_API_KEY=${apiKey.rawKey}`));
        }
      }

      // Step 7: Coding-agent skills
      let skillsScope: SkillsScope;
      if (opts.yes) {
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
        skillsInstalled = await installCodingAgentSkills({ scope: skillsScope, cwd });
        if (skillsInstalled) {
          s.stop("Coding-agent skills installed");
        } else {
          s.stop("Coding-agent skills install failed.");
          clack.log.warn(`Install manually later: ${pc.bold(skillsInstallHint())}`);
        }
      }

      // Step 8: Install CLI globally
      let cliInstalled = false;
      let cliInstallCommand = globalInstallHint();
      if (!isPolpoOnPath()) {
        let doInstall: boolean;
        if (opts.yes) doInstall = true;
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
        cliInstalled = true;
      }

      // Step 9: Outro — focus on MODIFY, not deploy
      const polpoRun = cliInstalled ? "polpo" : "npx @polpo-ai/cli";
      const lines: string[] = [];
      lines.push(pc.green(`✓ Linked to "${project.name}"`));
      lines.push("");

      if (pullResult.pulled.length > 0) {
        lines.push(pc.dim("  Your project resources are in .polpo/"));
      }
      lines.push("");

      lines.push(pc.dim("  Modify your agents:"));
      lines.push(`    ${pc.dim("Edit")} ${pc.bold(".polpo/agents.json")} ${pc.dim("to change agents, tools, and system prompts")}`);
      if (skillsInstalled) {
        lines.push(`    ${pc.dim("Or ask your coding agent:")} ${pc.bold('"Update the Polpo agents for this project"')}`);
      }
      lines.push("");

      lines.push(pc.dim("  When ready, push changes to cloud:"));
      lines.push(`    ${pc.bold(`${polpoRun} deploy`)}`);
      lines.push("");

      if (skillsScope === "skip") {
        lines.push(pc.dim(`  Install coding-agent skills later: ${pc.bold(skillsInstallHint())}`));
      }
      if (!cliInstalled) {
        lines.push(pc.dim(`  Install CLI globally: ${pc.bold(cliInstallCommand)}`));
      }

      clack.outro(lines.join("\n"));
    });
}
