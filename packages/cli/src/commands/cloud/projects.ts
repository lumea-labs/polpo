/**
 * polpo projects — manage cloud projects.
 */
import type { Command } from "commander";
import pc from "picocolors";
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
      const creds = await requireAuth({
        context: "Listing projects requires an authenticated session.",
      });
      const client = createApiClient(creds);

      try {
        // pickOrg handles 0/1/N orgs gracefully (creates one inline if zero).
        const orgId = opts.org ?? (await pickOrg(client)).id;
        const res = await client.get<any[]>(
          `/v1/projects?orgId=${encodeURIComponent(orgId)}`,
        );

        if (res.status === 200) {
          const list = Array.isArray(res.data) ? res.data : [];
          if (list.length === 0) {
            console.log(pc.dim("No projects yet."));
            console.log(pc.dim("Run ") + pc.bold("polpo create") + pc.dim(" to scaffold one."));
          } else {
            for (const p of list) {
              const status = p.status ? ` [${p.status}]` : "";
              console.log(`  ${p.name ?? p.id}${status}`);
            }
          }
        } else {
          const data = res.data as { error?: string };
          console.error(pc.red(friendlyError(data?.error ?? `HTTP ${res.status}`)));
          process.exit(1);
        }
      } catch (err) {
        console.error(pc.red(friendlyError((err as Error).message)));
        process.exit(1);
      }
    });

  projects
    .command("create <name>")
    .description("Create a project")
    .option("--org <org-id>", "Organization ID (auto-detected if omitted)")
    .action(async (name: string, opts) => {
      const creds = await requireAuth({
        context: "Creating a project requires an authenticated session.",
      });
      const client = createApiClient(creds);

      try {
        const orgId = opts.org ?? (await pickOrg(client)).id;
        // Slug is server-generated (Supabase ref format) — no longer sent.
        const res = await client.post<any>("/v1/projects", { orgId, name });

        if (res.status >= 200 && res.status < 300) {
          const project = res.data;
          console.log(pc.green(`✓ Project "${name}" created.`));
          if (project?.id) console.log(pc.dim(`  ID:   ${project.id}`));
          if (project?.slug) console.log(pc.dim(`  Slug: ${project.slug}`));
        } else {
          const data = res.data as { error?: string };
          console.error(pc.red(friendlyError(data?.error ?? `HTTP ${res.status}`)));
          process.exit(1);
        }
      } catch (err) {
        console.error(pc.red(friendlyError((err as Error).message)));
        process.exit(1);
      }
    });
}
