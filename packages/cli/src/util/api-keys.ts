/**
 * Create project-scoped API keys on the control plane.
 *
 * Used by `polpo create` after provisioning a new cloud project — we
 * generate a key scoped strictly to that project and write it into the
 * scaffolded `.env.local`, so the user's app can talk to Polpo Cloud
 * without leaking the user's personal CLI credentials.
 *
 * Request shape verified from the production dashboard caller:
 *   POST /v1/api-keys
 *   { orgId, name, scopes: [{type:"project", projectId}], environment:"development" }
 *
 * Response returns the secret token ONCE as `rawKey` — the dashboard
 * explicitly tells users "copy this now, you won't see it again".
 */
import type { ApiClient } from "../commands/cloud/api.js";
import { parseProjectEnvironment, type ProjectEnvironment } from "@polpo-ai/core/project-environment";

export type ApiKeyScope =
  | { type: "platform" }
  | { type: "project"; projectId: string };

export interface CreatedApiKey {
  /** UUID of the key record (for future rotate / delete). */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Public prefix safe to display (e.g. "sk_live_abc12345"). */
  keyPrefix: string;
  /** Applied scopes. */
  scopes: ApiKeyScope[];
  /** The full secret token — returned ONCE on creation, store it immediately. */
  rawKey: string;
  environment: string;
  createdAt: string;
}

export interface CreateApiKeyOptions {
  orgId: string;
  name: string;
  scopes: ApiKeyScope[];
  /** CLI default: Development. The key covers all authorized runtime surfaces, including Data. */
  environment?: ProjectEnvironment;
}

export async function createApiKey(
  client: ApiClient,
  opts: CreateApiKeyOptions,
): Promise<CreatedApiKey> {
  const environment = parseProjectEnvironment(opts.environment ?? "development");
  const res = await client.post<CreatedApiKey>("/v1/api-keys", {
    orgId: opts.orgId,
    name: opts.name,
    scopes: opts.scopes,
    environment,
  });
  if (res.status < 200 || res.status >= 300 || !res.data?.rawKey) {
    throw new Error(
      `Failed to create API key: ${(res.data as any)?.error ?? `HTTP ${res.status}`}`,
    );
  }
  if (res.data.environment !== environment) {
    throw new Error("The server returned a key for a different environment; it was not saved or used. Check the key in the dashboard.");
  }
  return res.data;
}

/** Convenience wrapper for the common "one project, one key" case. */
export async function createProjectApiKey(
  client: ApiClient,
  orgId: string,
  projectId: string,
  name: string = "CLI generated",
  environment: ProjectEnvironment = "development",
): Promise<CreatedApiKey> {
  return createApiKey(client, {
    orgId,
    name,
    scopes: [{ type: "project", projectId }],
    environment,
  });
}
