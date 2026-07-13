"use client";

import { useMemo, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { DashboardProvider } from "@polpo-ai/dashboard";
import { PolpoProvider } from "@polpo-ai/react";

export function Providers({ children }: { children: ReactNode }) {
  const router = useRouter();
  const host = useMemo(() => ({
    project: { id: "local", name: "Local runtime" },
    capabilities: {
      multiProject: false,
      billing: false,
      managedConnections: false,
      managedGateway: false,
      provisioning: false,
    },
    navigate: (path: string) => router.push(path),
  }), [router]);

  return (
    <PolpoProvider baseUrl="" apiPrefix="/api/polpo" autoConnect>
      <DashboardProvider host={host}>{children}</DashboardProvider>
    </PolpoProvider>
  );
}
