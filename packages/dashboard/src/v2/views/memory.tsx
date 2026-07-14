"use client";

import { useState } from "react";
import { useMemory } from "@polpo-ai/react";
import { useDashboardHost } from "../../host.js";
import { ProjectMemory } from "./memory-project.js";
import { PageBody, PageHeader, RefreshButton } from "./memory-host.js";

export function MemoryView() {
  const { project } = useDashboardHost();
  const { memory, isLoading, error, refetch } = useMemory();
  const [refreshing, setRefreshing] = useState(false);
  return (
    <PageBody>
      <PageHeader
        title="Memory"
        description="Shared context injected into every agent in this project."
        actions={<RefreshButton busy={refreshing} onClick={() => { setRefreshing(true); void refetch().finally(() => setRefreshing(false)); }} />}
      />
      <div className="mt-6">
        {error ? <p className="text-[12px] text-destructive">{error.message}</p> : isLoading && !memory ? <div className="h-[360px] animate-pulse rounded-lg border border-border bg-muted" /> : <ProjectMemory projectId={project.id} initial={memory?.content ?? ""} />}
      </div>
    </PageBody>
  );
}
