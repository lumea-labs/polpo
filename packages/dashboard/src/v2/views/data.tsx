"use client";

import { useDashboardHost } from "../../host.js";
import { DataView } from "../data/data-view.js";
import { PageBody } from "../ui/page-header.js";
import { TooltipProvider } from "../ui/tooltip.js";

export function SelfHostDataView() {
  const { project, capabilities } = useDashboardHost();
  return <TooltipProvider><PageBody><DataView projectId={project.id} enabled={capabilities?.data !== false} /></PageBody></TooltipProvider>;
}
