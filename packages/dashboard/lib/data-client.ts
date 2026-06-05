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
  // Paths are passed verbatim (they already carry their own prefix, exactly as
  // the cloud proxy forwarded them to the data plane). No extra prefix here.
  apiPrefix: "",
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
 * orgs, billing and keys live only in the cloud. The cloud build overrides this
 * module; in OSS this is wired to local equivalents (or no-ops) as the shell is
 * adapted. Kept as a thin direct call for now.
 */
export async function fetchControlPlane<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}
