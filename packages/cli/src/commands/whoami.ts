/**
 * polpo whoami — print the authenticated user + default organization.
 *
 * Quick sanity check that credentials are valid and the CLI is pointing
 * at the right cloud. Honours --json for scripting.
 */
import type { Command } from "commander";
import pc from "picocolors";
import { getAuth } from "../util/auth.js";
import { createApiClient } from "./cloud/api.js";

interface User {
  id?: string;
  email?: string;
  name?: string;
}

interface Org {
  id: string;
  name: string;
}

export function registerWhoamiCommand(program: Command): void {
  program
    .command("whoami")
    .description("Show the authenticated user + default organization")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      const creds = getAuth();
      if (!creds) {
        if (opts.json) {
          console.log(JSON.stringify({ loggedIn: false }));
        } else {
          console.log(pc.red("Not logged in.") + " Run: " + pc.bold("polpo login"));
        }
        process.exit(1);
      }

      const client = createApiClient({ apiKey: creds.apiKey, baseUrl: creds.baseUrl });

      let user: User | null = null;
      let orgs: Org[] = [];
      try {
        const meRes = await client.get<User>("/v1/me");
        user = (meRes.data as User) ?? null;
      } catch { /* endpoint may not exist — graceful */ }
      try {
        const orgsRes = await client.get<Org[]>("/v1/orgs");
        orgs = Array.isArray(orgsRes.data) ? orgsRes.data : [];
      } catch { /* graceful */ }

      if (opts.json) {
        console.log(JSON.stringify({
          loggedIn: true,
          apiUrl: creds.baseUrl,
          user,
          orgs,
        }, null, 2));
        return;
      }

      console.log();
      if (user?.email) {
        console.log(pc.bold("  User:   ") + user.email + (user.name ? pc.dim(` (${user.name})`) : ""));
      }
      console.log(pc.bold("  API:    ") + creds.baseUrl);
      if (orgs.length === 0) {
        console.log(pc.bold("  Orgs:   ") + pc.dim("none"));
      } else if (orgs.length === 1) {
        console.log(pc.bold("  Org:    ") + orgs[0].name + pc.dim(` (${orgs[0].id})`));
      } else {
        console.log(pc.bold(`  Orgs:   ${orgs.length}`));
        for (const o of orgs) {
          console.log(pc.dim(`    · ${o.name} (${o.id})`));
        }
      }
      console.log();
    });
}
