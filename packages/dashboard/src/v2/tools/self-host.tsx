"use client";

import { useQuery } from "../host.js";
import { useDashboardApi } from "../../host.js";
import { PageBody } from "../ui/page-header.js";
import { Skeleton } from "../ui/skeleton.js";
import { ToolDetail } from "./tool-detail.js";
import { ToolsView, type ToolRow } from "./tools-view.js";

export function SelfHostToolsView() {
  return (
    <PageBody>
      <ToolsView projectId="local" initialTools={[]} />
    </PageBody>
  );
}

export function SelfHostToolDetailView({ name }: { name: string }) {
  const api = useDashboardApi();
  const { data, isLoading, error } = useQuery({
    queryKey: ["custom-tool", "local", name],
    queryFn: () =>
      api.fetchControlPlane<{
        ok: boolean;
        data: { name: string; source: string; meta?: { parameters?: unknown } | null };
      }>(`/v1/projects/local/tools/${encodeURIComponent(name)}`).then((response) => response.data),
  });

  if (isLoading) {
    return (
      <PageBody>
        <div className="flex flex-col gap-4">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-8 w-72" />
          <Skeleton className="h-[62vh] w-full" />
        </div>
      </PageBody>
    );
  }
  if (error || !data) {
    return (
      <PageBody>
        <div className="py-16 text-center text-sm text-muted-foreground">
          {error instanceof Error ? error.message : "Tool not found."}
        </div>
      </PageBody>
    );
  }

  return (
    <PageBody>
      <ToolDetail
        projectId="local"
        name={data.name}
        initialSource={data.source}
        parameters={data.meta?.parameters}
      />
    </PageBody>
  );
}

export type { ToolRow };
