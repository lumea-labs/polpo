/**
 * Organization resolution helpers.
 *
 * `resolveDefaultOrg()` fetches the user's orgs from the control plane
 * and returns the first one (used by `deploy` today where only one is
 * expected). `pickOrg()` is the interactive variant for `create` where
 * the user may belong to multiple orgs.
 */
import * as clack from "@clack/prompts";
import type { ApiClient } from "../commands/cloud/api.js";

export interface Org {
  id: string;
  name: string;
  slug?: string;
}

async function listOrgs(client: ApiClient): Promise<Org[]> {
  const res = await client.get<Org[]>("/v1/orgs");
  return Array.isArray(res.data) ? res.data : [];
}

/**
 * Return the first (and typically only) org.
 * Throws when the user has no orgs — onboarding should have seeded one.
 */
export async function resolveDefaultOrg(client: ApiClient): Promise<Org> {
  const orgs = await listOrgs(client);
  if (orgs.length === 0) {
    throw new Error("No organization found. Complete onboarding at polpo.sh first.");
  }
  return orgs[0];
}

/**
 * Interactive org picker.
 * - 0 orgs → throws
 * - 1 org → returns it without prompting
 * - >1   → clack.select picker
 */
export async function pickOrg(client: ApiClient): Promise<Org> {
  const orgs = await listOrgs(client);
  if (orgs.length === 0) {
    throw new Error("No organization found. Complete onboarding at polpo.sh first.");
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
