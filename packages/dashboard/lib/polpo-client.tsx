"use client";

import { PolpoClient } from "@polpo-ai/sdk";
import { createContext, useContext, useMemo, type ReactNode } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const API_PREFIX = process.env.NEXT_PUBLIC_POLPO_API_PREFIX ?? "/api/v1";
const API_KEY = process.env.NEXT_PUBLIC_POLPO_API_KEY;

export type PolpoClientFactory = (projectId: string) => PolpoClient;

/**
 * Default factory: single-tenant self-host. Points straight at the OSS server
 * with a Bearer key. `projectId` is accepted for parity but ignored.
 *
 * Same SDK we publish to customers — every bug they'd hit, we hit first.
 */
export function createPolpoClient(_projectId: string): PolpoClient {
  return new PolpoClient({
    baseUrl: API_URL,
    apiPrefix: API_PREFIX,
    apiKey: API_KEY,
  });
}

/**
 * Lets a host app inject its own client factory so the SAME view components can
 * run against a different transport. OSS renders with no provider (→ the direct
 * factory above); the cloud wraps the shared views in
 * `<DataClientProvider factory={sessionProxyFactory}>` so they route through its
 * per-project session proxy. This is the Phase-2 seam for de-duping the views.
 */
const DataClientContext = createContext<PolpoClientFactory | null>(null);

export function DataClientProvider({
  factory,
  children,
}: {
  factory: PolpoClientFactory;
  children: ReactNode;
}) {
  return <DataClientContext.Provider value={factory}>{children}</DataClientContext.Provider>;
}

/** Memoized client — uses the injected factory if present, else the OSS default. */
export function usePolpoClient(projectId: string): PolpoClient {
  const factory = useContext(DataClientContext) ?? createPolpoClient;
  return useMemo(() => factory(projectId), [factory, projectId]);
}
