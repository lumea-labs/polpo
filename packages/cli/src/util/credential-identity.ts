import type { ProjectEnvironment } from "@polpo-ai/core/project-environment";
import type { ApiClient, ApiResponse } from "../commands/cloud/api.js";

export interface CredentialIdentity {
  credential: {
    id: string;
    type: "account" | "environment" | "legacy" | "mixed";
    environment: ProjectEnvironment | null;
    legacyEnvironment?: "live" | "test";
  };
  organization: { id: string; name: string; slug: string };
  projects: Array<{ id: string; name: string; slug: string;
    environments: Array<{ id: string; name: ProjectEnvironment }> }>;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const environment = (value: unknown): value is ProjectEnvironment => value === "development" || value === "production";

function parseIdentity(value: unknown): CredentialIdentity {
  const invalid = () => new Error("Invalid credential identity response from the API.");
  if (!record(value) || !record(value.credential) || !record(value.organization) || !Array.isArray(value.projects)) throw invalid();
  const key = value.credential, org = value.organization;
  if (!string(key.id) || !["account", "environment", "legacy", "mixed"].includes(String(key.type))
    || (key.type === "environment" || key.type === "mixed" ? !environment(key.environment) : key.environment !== null)
    || ((key.type === "legacy" || key.type === "mixed") && key.legacyEnvironment !== "live" && key.legacyEnvironment !== "test")
    || !string(org.id) || !string(org.name) || !string(org.slug)) throw invalid();
  const projects = value.projects.map(project => {
    if (!record(project) || !string(project.id) || !string(project.name) || !string(project.slug) || !Array.isArray(project.environments)) throw invalid();
    const environments = project.environments.map(candidate => {
      if (!record(candidate) || !string(candidate.id) || !environment(candidate.name)
        || ((key.type === "environment" || key.type === "mixed") && candidate.name !== key.environment)) throw invalid();
      return { id: candidate.id, name: candidate.name };
    });
    if (new Set(environments.map(candidate => candidate.name)).size !== environments.length) throw invalid();
    return { id: project.id, name: project.name, slug: project.slug, environments };
  });
  if (new Set(projects.map(project => project.id)).size !== projects.length) throw invalid();
  return { credential: { id: key.id, type: key.type as CredentialIdentity["credential"]["type"],
    environment: key.environment as ProjectEnvironment | null,
    ...(key.type === "legacy" || key.type === "mixed" ? { legacyEnvironment: key.legacyEnvironment as "live" | "test" } : {}) },
    organization: { id: org.id, name: org.name, slug: org.slug }, projects };
}

/** A 404/405 indicates an older server. Authentication failures, network errors
 * and malformed success responses must never authorize a compatibility fallback. */
export async function readCredentialIdentity(client: ApiClient): Promise<CredentialIdentity | null> {
  const result = await client.get<unknown>("/v1/credentials/current");
  if (result.status === 404 || result.status === 405) return null;
  if (result.status !== 200) throw new Error(`Could not validate the API credential (HTTP ${result.status}).`);
  return parseIdentity(result.data);
}

export async function validateApiCredential(client: ApiClient): Promise<CredentialIdentity | null> {
  const identity = await readCredentialIdentity(client);
  if (identity) return identity;
  const result = await client.get<unknown>("/v1/orgs");
  if (result.status !== 200 || !Array.isArray(result.data)) {
    throw new Error(`Could not validate the API key on this server (HTTP ${result.status}).`);
  }
  return null;
}

export function isEnvironmentAdminDenied(result: ApiResponse<unknown>): boolean {
  return result.status === 403 && record(result.data) && result.data.code === "environment_admin_route_required";
}

export function credentialProjects(identity: CredentialIdentity) {
  return identity.projects.map(({ id, name, slug }) => ({ id, name, slug, orgId: identity.organization.id }));
}

/** Friendly local preflight; the server remains authoritative for every request. */
export function assertCredentialTarget(identity: CredentialIdentity | null, target: ProjectEnvironment, projectId?: string): void {
  if (!identity) return;
  const key = identity.credential;
  if (key.type === "legacy") throw new Error("Legacy API keys require migration before deploying to Development or Production. Run polpo login or create an environment key.");
  if (key.type === "mixed") {
    if (target !== "production") throw new Error("This migrating legacy key authorizes Production only; use a Development key for the Development environment.");
    if (projectId && !identity.projects.some(project => project.id === projectId
      && project.environments.some(candidate => candidate.name === target))) {
      throw new Error(`Project ${projectId} has not migrated this credential to Production yet.`);
    }
    return;
  }
  if (key.type !== "environment") return;
  if (key.environment !== target) {
    throw new Error(`This key belongs to ${key.environment}; ${key.environment === "production" ? "use --prod explicitly or a Development key" : "use a Production key for --prod"}.`);
  }
  if (projectId && !identity.projects.some(project => project.id === projectId
    && project.environments.some(candidate => candidate.name === target))) {
    throw new Error(`This credential has no access to project ${projectId} in ${target}.`);
  }
}
