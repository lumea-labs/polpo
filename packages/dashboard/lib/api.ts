/**
 * Server-side API client for the Control Plane.
 * Used by Server Components to fetch data directly — no BFF, no API routes proxy.
 *
 * Data plane types (AgentConfig, Task, Mission, Team, etc.) come from @polpo-ai/core.
 * Control plane types (Org, Project, ApiKey, ByokEntry) are defined here.
 */

import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { AgentConfig } from "@polpo-ai/core";

const API_URL = process.env.POLPO_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const API_PREFIX = process.env.NEXT_PUBLIC_POLPO_API_PREFIX ?? "/api/v1";
const API_KEY = process.env.POLPO_API_KEY ?? process.env.NEXT_PUBLIC_POLPO_API_KEY;

/** Control-plane API error carrying the HTTP status, so callers can tell an
 *  auth failure (401) apart from a transient backend error (5xx/network). */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Authenticated server-side fetch to the control plane.
 * Forwards session cookies from the incoming request.
 */
export async function api<T>(path: string, opts?: RequestInit): Promise<T> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.toString();

  const res = await fetch(`${API_URL}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      cookie: cookieHeader,
      ...opts?.headers,
    },
    cache: "no-store",
  });

  if (!res.ok) {
    throw new ApiError(res.status, `API error ${res.status}: ${await res.text()}`);
  }

  return res.json();
}

/**
 * Authenticated fetch to the data plane via session proxy.
 * Routes through /v1/projects/:projectId/data/* which uses session auth.
 * No API key needed — the server resolves the project internally.
 */
export async function dataApi<T>(_projectId: string, path: string, opts?: RequestInit): Promise<T> {
  // Single-tenant self-host: straight at the OSS server (`/api/v1/...`) with a
  // Bearer key. projectId is ignored. Callers pass `/v1/...`, so strip the
  // leading `/v1` and let API_PREFIX carry the root. Cloud overrides with its
  // session-proxy variant.
  const res = await fetch(`${API_URL}${API_PREFIX}${path.replace(/^\/v1(?=\/|$)/, "")}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
      ...opts?.headers,
    },
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error(`Data API error ${res.status}: ${await res.text()}`);
  }

  return res.json();
}

/**
 * Cached fetch of the user's orgs — deduplicated per request via React.cache().
 * Multiple server components in the same render can call this without duplicate HTTP requests.
 */
export const getOrgs = cache(async (): Promise<OrgWithRole[]> => {
  try {
    return await api<OrgWithRole[]>("/v1/orgs");
  } catch (err) {
    // A missing/expired session is NOT "no orgs" — sending the user to
    // onboarding here was the bug that dumped people with a stale `.polpo.sh`
    // cookie onto /onboarding. Re-authenticate instead.
    if (err instanceof ApiError && err.status === 401) redirect("/login");
    // Transient backend failure (5xx / network / DB down): surface it as a
    // real error (error boundary) rather than masquerading as "no orgs".
    throw err;
  }
});

/**
 * Non-throwing org fetch — returns `[]` on ANY failure (auth or transient).
 * For contexts where a redirect/throw is wrong, e.g. API route handlers
 * (billing identify) that must always return a response.
 */
export const getOrgsSafe = cache(() =>
  api<OrgWithRole[]>("/v1/orgs").catch(() => [] as OrgWithRole[])
);

/**
 * Cached fetch of a single agent config — deduplicated per request via
 * React.cache(). The agent detail layout and every tab page (capabilities,
 * identity, tools, skills, prompt) call this with the same args, so within
 * one server render the agent is fetched once instead of N times.
 * Returns null on any error (renders the "Agent not found" empty state).
 */
export const getAgent = cache((projectId: string, name: string) =>
  dataApi<{ ok: boolean; data: AgentConfig }>(
    projectId,
    `/v1/agents/${encodeURIComponent(name)}`,
  )
    .then((r) => r.data ?? null)
    .catch(() => null),
);

// ── Control plane types (cloud-only, match packages/server/src/db/schema.ts) ──

export interface Org {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
}

export interface OrgWithRole extends Org {
  role: "owner" | "admin" | "member";
}

export interface ProjectGatewaySettings {
  url?: string;
  headers?: Record<string, string>;
}

export interface ProjectSettings {
  gateway?: ProjectGatewaySettings;
  [key: string]: unknown;
}

export interface OnboardingChecklist {
  firstCompletion?: string;
  firstSkill?: string;
  firstTool?: string;
  firstTask?: string;
  firstDeploy?: string;
}

export interface Project {
  id: string;
  orgId: string;
  name: string;
  slug: string;
  settings?: ProjectSettings | null;
  status: "active" | "suspended" | "deleted";
  onboardingChecklist?: OnboardingChecklist;
  neonProjectId?: string | null;
  neonConnectionString?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApiKey {
  id: string;
  projectId: string;
  name: string;
  keyPrefix: string;
  keyHash?: string;
  environment: "live" | "test";
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export interface ApiKeyCreated extends Omit<ApiKey, "keyHash"> {
  rawKey: string;
}

export interface ByokEntry {
  provider: string;
  label: string | null;
  maskedKey: string;
  createdAt: string;
  updatedAt: string;
}
