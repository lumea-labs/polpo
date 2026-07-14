"use client";

import { useQuery } from "@tanstack/react-query";
import { useDashboardHost } from "../../host.js";
import { usePolpoClient } from "../host.js";
import { PageBody } from "../ui/page-header.js";
import { AgentDetail, type AgentDetailData } from "./agent-detail.js";

type VaultEntry = {
  service: string;
  type: string;
  label?: string | null;
  keys?: string[];
};

export function SelfHostAgentDetailView({ name }: { name: string }) {
  const host = useDashboardHost();
  const polpo = usePolpoClient(host.project.id);
  const { data, isLoading, error } = useQuery({
    queryKey: ["agent-detail-bootstrap", host.project.id, name],
    queryFn: async () => {
      const [agent, memory, vault] = await Promise.all([
        polpo.getAgent(name) as unknown as Promise<AgentDetailData>,
        polpo.getAgentMemory(name).catch(() => ({ content: "" })),
        polpo.listVaultEntries(name).catch(() => [] as VaultEntry[]),
      ]);
      return {
        agent,
        memory: memory.content ?? "",
        vault: vault as VaultEntry[],
      };
    },
  });

  if (isLoading) {
    return (
      <PageBody>
        <div className="space-y-5">
          <div className="h-4 w-20 animate-pulse rounded bg-muted" />
          <div className="h-14 w-full animate-pulse rounded-lg bg-muted" />
          <div className="h-9 w-full animate-pulse rounded bg-muted" />
          <div className="h-64 w-full animate-pulse rounded-lg bg-muted" />
        </div>
      </PageBody>
    );
  }

  if (!data || error) {
    return (
      <PageBody>
        <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          Agent not found.
        </div>
      </PageBody>
    );
  }

  return (
    <AgentDetail
      projectId={host.project.id}
      agent={data.agent}
      initialMemory={data.memory}
      initialVault={data.vault}
    />
  );
}
