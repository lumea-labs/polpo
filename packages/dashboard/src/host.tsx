"use client";

import {
  createContext,
  useContext,
  type ComponentType,
  type ReactNode,
} from "react";

export interface DashboardCapabilities {
  multiProject?: boolean;
  billing?: boolean;
  settings?: boolean;
  managedConnections?: boolean;
  managedGateway?: boolean;
  provisioning?: boolean;
}

export interface DashboardMutationOptions {
  method: string;
  body?: unknown;
}

export interface DashboardApi {
  fetchDataPlane<T>(projectId: string, path: string): Promise<T>;
  mutateDataPlane<T>(
    projectId: string,
    path: string,
    options: DashboardMutationOptions,
  ): Promise<T>;
  fetchControlPlane<T>(path: string): Promise<T>;
  mutateControlPlane<T>(
    path: string,
    options: DashboardMutationOptions,
  ): Promise<T>;
  controlPlaneBaseUrl(): string;
  dataPlaneBaseUrl(projectId: string): string;
  runtimeUrl(projectId: string, path: string): string;
}

export interface AgentRunChatProps {
  baseUrl: string;
  agent: string | undefined;
  initialMessage?: string;
  seedKey?: string;
  onRawChunk?: (chunk: string) => void;
  onRawDone?: () => void;
  onRawError?: () => void;
}

export interface DashboardHost {
  project: { id: string; name?: string };
  api: DashboardApi;
  components?: {
    AgentRunChat?: ComponentType<AgentRunChatProps>;
  };
  capabilities?: DashboardCapabilities;
  navigate: (path: string) => void;
  href?: (path: string) => string;
}

const DashboardHostContext = createContext<DashboardHost | null>(null);

export function DashboardProvider({
  host,
  children,
}: {
  host: DashboardHost;
  children: ReactNode;
}) {
  return (
    <DashboardHostContext.Provider value={host}>
      {children}
    </DashboardHostContext.Provider>
  );
}

export function useDashboardHost(): DashboardHost {
  const host = useContext(DashboardHostContext);
  if (!host) throw new Error("Dashboard views require <DashboardProvider>");
  return host;
}

export function useDashboardHref(path: string): string {
  const host = useDashboardHost();
  return host.href?.(path) ?? path;
}

export function useDashboardApi(): DashboardApi {
  return useDashboardHost().api;
}
