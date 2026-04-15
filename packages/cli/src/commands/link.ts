/**
 * polpo link — attach the current directory to an existing cloud project.
 *
 *   polpo link --project-id <uuid>
 *
 * Writes `.polpo/polpo.json` with the linked project info so subsequent
 * `polpo deploy` runs target the right project automatically.
 *
 * Does NOT scaffold any code — pairs with `polpo create` (which scaffolds
 * + links in one step). Use this when you already have a codebase and
 * want to bolt Polpo onto it.
 */
import type { Command } from "commander";
import * as path from "node:path";
import * as clack from "@clack/prompts";
import pc from "picocolors";
import { requireAuth } from "../util/auth.js";
import { createApiClient } from "./cloud/api.js";
import { getProject } from "../util/project.js";
import { writePolpoConfig, readPolpoConfig } from "../util/polpo-config.js";
import { friendlyError } from "../util/errors.js";

export function registerLinkCommand(program: Command): void {
  program
    .command("link")
    .description("Link the current directory to an existing cloud project")
    .requiredOption("--project-id <id>", "Cloud project UUID")
    .option("-d, --dir <path>", "Working directory", ".")
    .option("--api-url <url>", "Override the API base URL (self-hosted, custom domain, dev)")
    .action(async (opts) => {
      clack.intro(pc.bold("Polpo — Link project"));

      const creds = await requireAuth({
        apiUrl: opts.apiUrl,
        context: "Linking a project requires an authenticated session.",
      });

      const client = createApiClient({
        apiKey: creds.apiKey,
        baseUrl: opts.apiUrl ?? creds.baseUrl,
      });

      const s = clack.spinner();
      s.start("Verifying project...");
      let project;
      try {
        project = await getProject(client, opts.projectId);
        if (!project) {
          s.stop("Project not found.");
          clack.outro(
            pc.red(`No project with id ${opts.projectId} — check the URL or run `) +
              pc.bold("polpo projects"),
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

      // Persist slug as the canonical identifier; UUID is kept for display.
      // Don't pin apiUrl — the slug derives the data plane URL automatically.
      // Self-hosted users can add `apiUrl` manually to override.
      writePolpoConfig(cwd, {
        project: project.name,
        projectSlug: project.slug,
        projectId: project.id,
      });

      clack.log.success(`Wrote ${pc.bold(".polpo/polpo.json")}`);
      clack.outro(
        pc.green("✓ Linked. Next: ") +
          pc.bold("polpo deploy") +
          pc.dim(" to push your agents."),
      );
    });
}
