/**
 * polpo orgs — list the organizations the authenticated user belongs to.
 *
 * Placeholder for richer org management (create/rename/delete) which
 * lives in the dashboard for now. The CLI exposes list-only so scripts
 * can resolve orgIds without hitting the dashboard.
 */
import type { Command } from "commander";
import * as clack from "@clack/prompts";
import pc from "picocolors";
import { requireAuth } from "../util/auth.js";
import { createApiClient } from "./cloud/api.js";

interface Org {
  id: string;
  name: string;
  slug?: string;
  createdAt?: string;
}

export function registerOrgsCommand(program: Command): void {
  const orgs = program
    .command("orgs")
    .description("List organizations you belong to");

  orgs
    .command("list", { isDefault: true })
    .alias("ls")
    .description("List organizations")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      if (!opts.json) {
        clack.intro(pc.bold("Polpo — Organizations"));
      }

      const creds = await requireAuth();
      const client = createApiClient({ apiKey: creds.apiKey, baseUrl: creds.baseUrl });

      const s = clack.spinner();
      s.start("Fetching organizations");

      let list: Org[] = [];
      try {
        const res = await client.get<Org[]>("/v1/orgs");
        list = Array.isArray(res.data) ? res.data : [];
      } catch (err) {
        s.stop("Failed");
        clack.log.error(pc.red(`Failed to list orgs: ${(err as Error).message}`));
        process.exit(1);
      }

      s.stop("Organizations fetched");

      if (opts.json) {
        console.log(JSON.stringify(list, null, 2));
        return;
      }

      if (list.length === 0) {
        clack.outro(pc.dim("No organizations found."));
        return;
      }

      for (const o of list) {
        const slug = o.slug ? pc.dim(`  (${o.slug})`) : "";
        clack.log.info(`${pc.bold(o.name)}${slug}\n${pc.dim(`  id: ${o.id}`)}`);
      }
      clack.outro(`${list.length} organization${list.length === 1 ? "" : "s"}`);
    });
}
