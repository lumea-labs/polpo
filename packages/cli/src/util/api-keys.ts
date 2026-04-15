/**
 * Create project-scoped API keys on the control plane.
 *
 * Used by `polpo create` after provisioning a new cloud project — we
 * generate a key scoped strictly to that project and write it into the
 * scaffolded `.env.local`, so the user's app can talk to Polpo Cloud
 * without leaking the user's personal CLI credentials.
 */
import type { ApiClient } from "../commands/cloud/api.js";

export interface CreatedApiKey {
  /** UUID of the key record (for future rotate / delete). */
  id: string;
  /** The secret token — shown ONCE on creation, store it immediately. */
  key: string;
  /** Human-readable name. */
  name: string;
}

export async function createProjectApiKey(
  client: ApiClient,
  projectId: string,
  name: string = "CLI generated",
): Promise<CreatedApiKey> {
  const res = await client.post<{ id: string; key: string; name: string }>(
    "/v1/api-keys",
    {
      name,
      scopes: [{ type: "project", projectId }],
    },
  );
  if (!res.data?.key) {
    throw new Error(
      `Failed to create API key: ${(res.data as any)?.error ?? `HTTP ${res.status}`}`,
    );
  }
  return res.data;
}
