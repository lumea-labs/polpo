/**
 * Client-side data fetching for the (self-hosted) data plane.
 *
 * Dogfoods the public SDK (`@polpo-ai/sdk`): a single `PolpoClient` carries the
 * transport, auth and error handling. We address resources by path via the
 * SDK's `requestPath` escape hatch and re-wrap the result in the `{ ok, data }`
 * envelope the views already expect — so no view changes are needed.
 *
 * OSS (single-tenant): one instance, Bearer key → local server. The `projectId`
 * argument is accepted for signature parity with the cloud proxy but ignored.
 * Cloud overrides this module with its session-proxy variant.
 */

import { PolpoClient } from "@polpo-ai/sdk";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

const client = new PolpoClient({
  baseUrl: API_URL,
  // Views address the data plane with `/v1/...` paths (verbatim, exactly as the
  // cloud proxy forwarded them). The standalone OSS server mounts those under
  // `/api/v1`, so prepend `/api` here → `${baseUrl}/api/v1/...`. Override via
  // NEXT_PUBLIC_POLPO_API_PREFIX if the server is mounted elsewhere.
  apiPrefix: process.env.NEXT_PUBLIC_POLPO_API_PREFIX ?? "/api",
  apiKey: process.env.NEXT_PUBLIC_POLPO_API_KEY,
});

type Envelope<T> = { ok: true; data: T };

/** Fetch from the data plane. Returns the `{ ok, data }` envelope. */
export async function fetchDataPlane<T>(_projectId: string, path: string): Promise<T> {
  const data = await client.requestPath<unknown>("GET", path);
  return { ok: true, data } as Envelope<unknown> as T;
}

/** Mutate (POST/PUT/PATCH/DELETE) on the data plane. Returns the envelope. */
export async function mutateDataPlane<T>(
  _projectId: string,
  path: string,
  opts: { method: string; body?: unknown },
): Promise<T> {
  const data = await client.requestPath<unknown>(opts.method, path, opts.body);
  return { ok: true, data } as Envelope<unknown> as T;
}

/**
 * Control-plane fetch. There is no control plane in single-tenant self-host —
 * orgs, billing and keys live only in the cloud.
 *
 * GATING (temporary): short-circuit with benign single-tenant stubs so the
 * shell (sidebar / copilot project chrome) renders without hitting endpoints
 * that don't exist on the OSS server. This is a band-aid, NOT the final design.
 *
 * TODO — un-mix scope per component instead of gating:
 *   - project name/org (`/v1/projects/:id`) → pure cloud chrome → drop / static.
 *   - BYOK (`/v1/byok/:id`) → has an OSS equivalent: re-point to the data-plane
 *     `vault` route. Same concept, different plane (control in cloud, vault in OSS).
 *   - api-keys / autumn billing → pure cloud → not in the OSS shell.
 * The raw `fetch('/v1/api-keys' | '/v1/byok' | '/v1/integrations')` calls in
 * connect-dialog / settings-form are NOT covered here (they fire on interaction,
 * not load) and are part of the same deferred decision.
 */
export async function fetchControlPlane<T>(path: string): Promise<T> {
  // `/v1/projects/:id` → the chrome only reads { name, orgId } for display.
  if (/^\/v1\/projects\/[^/]+$/.test(path)) {
    return { name: "Local", orgId: "local" } as T;
  }
  return {} as T;
}
