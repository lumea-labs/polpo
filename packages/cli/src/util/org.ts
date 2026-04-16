import * as clack from "@clack/prompts";
import pc from "picocolors";
import type { ApiClient } from "../commands/cloud/api.js";
import { slugify } from "./slugify.js";

export interface Org {
  id: string;
  name: string;
  slug?: string;
}

async function listOrgs(client: ApiClient): Promise<Org[]> {
  const res = await client.get<Org[]>("/v1/orgs");
  return Array.isArray(res.data) ? res.data : [];
}

async function createOrgInline(client: ApiClient, name: string): Promise<Org> {
  const slug = slugify(name);
  const res = await client.post<Org>("/v1/orgs", { name, slug });
  if (!res.data?.id) {
    const err = (res.data as { error?: string } | undefined)?.error ?? `HTTP ${res.status}`;
    throw new Error(`Failed to create organization: ${err}`);
  }
  return res.data;
}

/**
 * Non-interactive: returns the first org. Throws when the user has none —
 * intended for scripted contexts (`polpo deploy` without prompts).
 * Interactive entry points should use `pickOrg()` instead.
 */
export async function resolveDefaultOrg(client: ApiClient): Promise<Org> {
  const orgs = await listOrgs(client);
  if (orgs.length === 0) {
    throw new Error(
      "No organization found. Run `polpo create` interactively to create one, or finish onboarding at polpo.sh.",
    );
  }
  return orgs[0];
}

/**
 * Interactive org resolution used by `polpo create`.
 *
 *   0 orgs → prompt the user to name + create one inline (no detour to web)
 *   1 org  → auto-select, log
 *   >1     → clack.select picker
 *
 * The 0-org case used to throw an opaque error pointing the user back to
 * the dashboard. That broke the "everything from the terminal" promise —
 * inline creation lets a fresh signup go from `polpo login` to a working
 * project without leaving the CLI.
 */
export async function pickOrg(client: ApiClient): Promise<Org> {
  const orgs = await listOrgs(client);

  if (orgs.length === 0) {
    clack.log.info(
      "No organization found on this account — let's create one.",
    );
    const name = await clack.text({
      message: "Organization name",
      placeholder: "Acme Inc",
      validate: (v) => (v.trim().length < 2 ? "Name must be at least 2 characters" : undefined),
    });
    if (clack.isCancel(name)) {
      clack.cancel("Cancelled.");
      process.exit(0);
    }
    const s = clack.spinner();
    s.start("Creating organization...");
    try {
      const org = await createOrgInline(client, name as string);
      s.stop(`Organization "${org.name}" created`);
      return org;
    } catch (err) {
      s.stop("Organization creation failed.");
      clack.log.error((err as Error).message);
      clack.log.info(
        `If this keeps failing, finish onboarding at ${pc.bold("https://polpo.sh")} and re-run.`,
      );
      process.exit(1);
    }
  }

  if (orgs.length === 1) {
    clack.log.info(`Organization: ${orgs[0].name}`);
    return orgs[0];
  }

  const choice = await clack.select<string>({
    message: "Select an organization:",
    options: orgs.map((o) => ({ value: o.id, label: o.name })),
  });
  if (clack.isCancel(choice)) {
    clack.cancel("Cancelled.");
    process.exit(0);
  }
  const selected = orgs.find((o) => o.id === choice);
  if (!selected) throw new Error("Invalid org selection");
  return selected;
}
