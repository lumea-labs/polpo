"use client";

import { useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ThemeProvider } from "next-themes";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createSelfHostedDashboardApi,
  DashboardProvider,
} from "@polpo-ai/dashboard";
import { PolpoProvider } from "@polpo-ai/react";

export function Providers({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [queryClient] = useState(() => new QueryClient());
  const host = useMemo(() => ({
    project: { id: "local", name: "Local runtime" },
    api: createSelfHostedDashboardApi(),
    capabilities: {
      multiProject: false,
      billing: false,
      settings: false,
      managedConnections: false,
      managedGateway: false,
      provisioning: false,
    },
    navigate: (path: string) => router.push(path.replace(/^\/projects\/local(?=\/|$)/, "")),
    href: (path: string) => path.replace(/^\/projects\/local(?=\/|$)/, ""),
  }), [router]);

  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <QueryClientProvider client={queryClient}>
        <PolpoProvider baseUrl="" apiPrefix="/api/polpo" autoConnect>
          <DashboardProvider host={host}>{children}</DashboardProvider>
        </PolpoProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
