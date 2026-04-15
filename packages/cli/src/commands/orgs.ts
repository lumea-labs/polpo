/**
 * polpo orgs — list the organizations the authenticated user belongs to.
 *
 * Placeholder for richer org management (create/rename/delete) which
 * lives in the dashboard for now. The CLI exposes list-only so scripts
 * can resolve orgIds without hitting the dashboard.
 */
import type { Command } from "commander";
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
      const creds = await requireAuth();
      const client = createApiClient({ apiKey: creds.apiKey, baseUrl: creds.baseUrl });

      let list: Org[] = [];
      try {
        const res = await client.get<Org[]>("/v1/orgs");
        list = Array.isArray(res.data) ? res.data : [];
      } catch (err) {
        console.error(pc.red(`Failed to list orgs: ${(err as Error).message}`));
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(list, null, 2));
        return;
      }

      if (list.length === 0) {
        console.log(pc.dim("No organizations found."));
        return;
      }

      console.log();
      for (const o of list) {
        const slug = o.slug ? pc.dim(`  (${o.slug})`) : "";
        console.log(`  ${pc.bold(o.name)}${slug}`);
        console.log(pc.dim(`    id: ${o.id}`));
      }
      console.log();
    });
}
