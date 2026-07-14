"use client";

import { createContext, useContext, type ReactNode } from "react";

export interface DashboardCapabilities {
  multiProject?: boolean;
  billing?: boolean;
  settings?: boolean;
  managedConnections?: boolean;
  managedGateway?: boolean;
  provisioning?: boolean;
}

export interface DashboardHost {
  project: { id: string; name?: string };
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
