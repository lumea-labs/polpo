/**
 * Project resolution + creation helpers.
 *
 * Centralises the "list projects → pick one, or create a new one" flow
 * that both `polpo deploy` (today) and `polpo create` (incoming) need.
 */
import * as clack from "@clack/prompts";
import type { ApiClient } from "../commands/cloud/api.js";
import { slugify } from "./slugify.js";

export interface CloudProject {
  id: string;
  name: string;
  slug?: string;
  orgId?: string;
  status?: string;
}

export async function listProjects(client: ApiClient, orgId: string): Promise<CloudProject[]> {
  const res = await client.get<CloudProject[]>(`/v1/projects?orgId=${orgId}`);
  return Array.isArray(res.data) ? res.data : [];
}

export async function getProject(client: ApiClient, projectId: string): Promise<CloudProject | null> {
  const res = await client.get<CloudProject>(`/v1/projects/${projectId}`);
  if (res.status === 404) return null;
  return (res.data ?? null) as CloudProject | null;
}

export interface CreateProjectOptions {
  name: string;
  orgId: string;
  slug?: string;
}

export async function createProject(
  client: ApiClient,
  opts: CreateProjectOptions,
): Promise<CloudProject> {
  const slug = opts.slug ?? slugify(opts.name);
  const res = await client.post<CloudProject>("/v1/projects", {
    name: opts.name,
    slug,
    orgId: opts.orgId,
  });
  if (!res.data?.id) {
    throw new Error(`Failed to create project: ${(res.data as any)?.error ?? `HTTP ${res.status}`}`);
  }
  return res.data;
}

/**
 * Poll `GET /v1/projects/{id}` until `status === "active"` (or timeout).
 * Projects usually become active within 30–60s of creation.
 */
export async function waitForProjectActive(
  client: ApiClient,
  projectId: string,
  timeoutMs = 120_000,
): Promise<CloudProject> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const project = await getProject(client, projectId);
    if (project?.status === "active") return project;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("Project creation timed out. Check the dashboard for status.");
}

export interface ResolveOrCreateProjectOptions {
  client: ApiClient;
  orgId: string;
  /** Name used when auto-creating a project in the zero-projects case. */
  name: string;
  /** When true, skip confirmation prompts (CI / --yes). */
  force?: boolean;
  /** When true, prompt the user to pick when multiple projects exist. */
  interactive: boolean;
}

/**
 * Canonical flow used by `polpo deploy` when no projectId is set locally:
 *   - 0 projects → create one (prompts unless `force`)
 *   - 1 project  → auto-select, log, return
 *   - >1         → picker if interactive; error if not
 */
export async function resolveOrCreateProject(
  opts: ResolveOrCreateProjectOptions,
): Promise<CloudProject> {
  const { client, orgId, name, force, interactive } = opts;
  const projects = await listProjects(client, orgId);

  if (projects.length === 1) {
    return projects[0];
  }

  if (projects.length > 1) {
    if (!interactive) {
      throw new Error(
        "Multiple projects found. Set projectId in .polpo/polpo.json or run interactively.",
      );
    }
    const choice = await clack.select<string>({
      message: "Select a project:",
      options: projects.map((p) => ({ value: p.id, label: p.name })),
    });
    if (clack.isCancel(choice)) {
      clack.cancel("Cancelled.");
      process.exit(0);
    }
    const selected = projects.find((p) => p.id === choice);
    if (!selected) throw new Error("Invalid project selection");
    return selected;
  }

  // Zero projects — create one.
  if (!force && interactive) {
    const ok = await clack.confirm({
      message: `No projects found. Create "${name}"?`,
      initialValue: true,
    });
    if (clack.isCancel(ok) || !ok) {
      clack.cancel("Aborted.");
      process.exit(0);
    }
  }

  return await createProject(client, { name, orgId });
}
