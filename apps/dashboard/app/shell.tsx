"use client";

import { usePathname } from "next/navigation";
import { DashboardShell } from "@polpo-ai/dashboard";

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return <DashboardShell pathname={pathname}>{children}</DashboardShell>;
}
