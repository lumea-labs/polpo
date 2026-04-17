/**
 * polpo projects — manage cloud projects.
 */
import type { Command } from "commander";
import pc from "picocolors";
import * as clack from "@clack/prompts";
import { createApiClient } from "./api.js";
import { requireAuth } from "../../util/auth.js";
import { pickOrg } from "../../util/org.js";
import { friendlyError } from "../../util/errors.js";

export function registerProjectsCommand(program: Command): void {
  const projects = program
    .command("projects")
    .description("Manage cloud projects");

  projects
    .command("list")
    .description("List projects")
    .option("--org <org-id>", "Organization ID (auto-detected if omitted)")
    .action(async (opts) => {
      clack.intro(pc.bold("Polpo — List projects"));

      const creds = await requireAuth({
        context: "Listing projects requires an authenticated session.",
      });
      const client = createApiClient(creds);

      const s = clack.spinner();

      try {
        // pickOrg handles 0/1/N orgs gracefully (creates one inline if zero).
        const orgId = opts.org ?? (await pickOrg(client)).id;

        s.start("Fetching projects...");
        const res = await client.get<any[]>(
          `/v1/projects?orgId=${encodeURIComponent(orgId)}`,
        );

        if (res.status === 200) {
          const list = Array.isArray(res.data) ? res.data : [];
          if (list.length === 0) {
            s.stop("No projects found");
            clack.log.info(
              pc.dim("Run ") + pc.bold("polpo create") + pc.dim(" to scaffold one."),
            );
          } else {
            s.stop(`Found ${list.length} project${list.length === 1 ? "" : "s"}`);
            for (const p of list) {
              const status = p.status ? ` [${p.status}]` : "";
              clack.log.info(`${p.name ?? p.id}${status}`);
            }
          }
        } else {
          const data = res.data as { error?: string };
          s.stop("Failed to fetch projects");
          clack.outro(pc.red(friendlyError(data?.error ?? `HTTP ${res.status}`)));
          process.exit(1);
        }
      } catch (err) {
        s.stop("Failed to fetch projects");
        clack.outro(pc.red(friendlyError((err as Error).message)));
        process.exit(1);
      }

      clack.outro(pc.green("Done"));
    });

  projects
    .command("create <name>")
    .description("Create a project")
    .option("--org <org-id>", "Organization ID (auto-detected if omitted)")
    .action(async (name: string, opts) => {
      clack.intro(pc.bold("Polpo — Create project"));

      const creds = await requireAuth({
        context: "Creating a project requires an authenticated session.",
      });
      const client = createApiClient(creds);

      const s = clack.spinner();

      try {
        const orgId = opts.org ?? (await pickOrg(client)).id;

        // Slug is server-generated (Supabase ref format) — no longer sent.
        s.start("Creating project...");
        const res = await client.post<any>("/v1/projects", { orgId, name });

        if (res.status >= 200 && res.status < 300) {
          const project = res.data;
          s.stop(`Project "${name}" created`);
          if (project?.id) clack.log.info(pc.dim(`ID:   ${project.id}`));
          if (project?.slug) clack.log.info(pc.dim(`Slug: ${project.slug}`));
        } else {
          const data = res.data as { error?: string };
          s.stop("Project creation failed");
          clack.outro(pc.red(friendlyError(data?.error ?? `HTTP ${res.status}`)));
          process.exit(1);
        }
      } catch (err) {
        s.stop("Project creation failed");
        clack.outro(pc.red(friendlyError((err as Error).message)));
        process.exit(1);
      }

      clack.outro(pc.green(`Project "${name}" ready`));
    });
}
