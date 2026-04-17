/**
 * polpo whoami — print the authenticated user + default organization.
 *
 * Quick sanity check that credentials are valid and the CLI is pointing
 * at the right cloud. Honours --json for scripting.
 */
import type { Command } from "commander";
import * as clack from "@clack/prompts";
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
          clack.intro(pc.bold("Polpo — Whoami"));
          clack.outro(pc.red("Not logged in.") + " Run: " + pc.bold("polpo login"));
        }
        process.exit(1);
      }

      if (!opts.json) {
        clack.intro(pc.bold("Polpo — Whoami"));
      }

      const client = createApiClient({ apiKey: creds.apiKey, baseUrl: creds.baseUrl });

      const s = clack.spinner();
      s.start("Fetching account info");

      let user: User | null = null;
      let orgs: Org[] = [];
      let staleAuth = false;
      try {
        const meRes = await client.get<User>("/v1/me");
        if (meRes.status === 401 || meRes.status === 403) staleAuth = true;
        else user = (meRes.data as User) ?? null;
      } catch { /* endpoint may not exist — graceful */ }
      try {
        const orgsRes = await client.get<Org[]>("/v1/orgs");
        if (orgsRes.status === 401 || orgsRes.status === 403) staleAuth = true;
        else orgs = Array.isArray(orgsRes.data) ? orgsRes.data : [];
      } catch { /* graceful */ }

      s.stop("Account info fetched");

      if (staleAuth) {
        if (opts.json) {
          console.log(JSON.stringify({ loggedIn: false, reason: "stale_token", apiUrl: creds.baseUrl }, null, 2));
        } else {
          clack.log.error(pc.red("Session expired or invalid."));
          clack.outro(pc.dim("Run ") + pc.bold("polpo login") + pc.dim(" to refresh."));
        }
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify({
          loggedIn: true,
          apiUrl: creds.baseUrl,
          user,
          orgs,
        }, null, 2));
        return;
      }

      if (user?.email) {
        clack.log.info(pc.bold("User:  ") + user.email + (user.name ? pc.dim(` (${user.name})`) : ""));
      }
      clack.log.info(pc.bold("API:   ") + creds.baseUrl);
      if (orgs.length === 0) {
        clack.log.info(pc.bold("Orgs:  ") + pc.dim("none"));
      } else if (orgs.length === 1) {
        clack.log.info(pc.bold("Org:   ") + orgs[0].name + pc.dim(` (${orgs[0].id})`));
      } else {
        clack.log.info(pc.bold(`Orgs:  ${orgs.length}`));
        for (const o of orgs) {
          clack.log.info(pc.dim(`  ${o.name} (${o.id})`));
        }
      }
      clack.outro("Done");
    });
}
