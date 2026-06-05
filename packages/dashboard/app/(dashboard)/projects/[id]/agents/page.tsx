import { Suspense } from "react";
import { dataApi } from "@/lib/api";
import type { AgentConfig } from "@polpo-ai/core";
import { AgentsListSkeleton } from "@/components/dashboard/skeletons";
import AgentsView, { type Team } from "./view";

async function AgentsData({ id }: { id: string }) {
  let agents: AgentConfig[] = [];
  let teams: Team[] = [];

  try {
    const [agentsRes, teamsRes] = await Promise.all([
      dataApi<{ ok: boolean; data: AgentConfig[] }>(id, "/v1/agents").catch(
        () => ({ ok: false, data: [] as AgentConfig[] }),
      ),
      dataApi<{ ok: boolean; data: Team[] }>(id, "/v1/agents/teams").catch(
        () => ({ ok: false, data: [] as Team[] }),
      ),
    ]);
    agents = agentsRes.data ?? [];
    teams = teamsRes.data ?? [];
  } catch {}

  return <AgentsView initialAgents={agents} initialTeams={teams} />;
}

export default async function AgentsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <Suspense fallback={<AgentsListSkeleton />}>
      <AgentsData id={id} />
    </Suspense>
  );
}
