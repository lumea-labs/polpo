"use client";

import { PolpoClient } from "@polpo-ai/sdk";
import { useMemo } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const API_PREFIX = process.env.NEXT_PUBLIC_POLPO_API_PREFIX ?? "/api/v1";
const API_KEY = process.env.NEXT_PUBLIC_POLPO_API_KEY;

/**
 * Dashboard PolpoClient for single-tenant self-host: points straight at the OSS
 * server with a Bearer key. `projectId` is accepted for call-site parity but
 * ignored (one instance, no per-project routing). The cloud build swaps this
 * factory for its session-proxy variant.
 *
 * It's the same SDK we publish to customers — every bug they'd hit, we hit first.
 */
export function createPolpoClient(_projectId: string): PolpoClient {
  return new PolpoClient({
    baseUrl: API_URL,
    apiPrefix: API_PREFIX,
    apiKey: API_KEY,
  });
}

/** Memoized hook variant — stable instance per projectId. */
export function usePolpoClient(projectId: string): PolpoClient {
  return useMemo(() => createPolpoClient(projectId), [projectId]);
}
