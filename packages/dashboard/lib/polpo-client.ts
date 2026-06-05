"use client";

import { PolpoClient } from "@polpo-ai/sdk";
import { useMemo } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/**
 * Dashboard-flavored PolpoClient — points at the session-proxy URL
 * (`/v1/projects/:projectId/data/*`) and forwards cookies instead of an
 * API key. The data plane on the other end strips the `data/` prefix
 * and routes to the per-project Polpo instance.
 *
 * Use this everywhere the dashboard needs to talk to a project's data
 * plane. It's the same SDK we publish to customers — every bug they'd
 * hit, we hit first.
 */
export function createPolpoClient(projectId: string): PolpoClient {
  return new PolpoClient({
    baseUrl: `${API_URL}/v1/projects/${projectId}/data`,
    apiPrefix: "/v1",
    fetch: (input, init) =>
      fetch(input, {
        ...init,
        credentials: "include",
      }),
  });
}

/** Memoized hook variant — stable instance per projectId. */
export function usePolpoClient(projectId: string): PolpoClient {
  return useMemo(() => createPolpoClient(projectId), [projectId]);
}
