import { Suspense } from "react";
import { api, dataApi } from "../../../../../lib/api";
import type { Project } from "../../../../../lib/api";
import type { AgentConfig } from "@polpo-ai/core";
import PlaygroundView from "./view";
import { PlaygroundSkeleton } from "./skeleton";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

async function PlaygroundData({ id }: { id: string }) {
  let project: Project | null = null;
  let agents: AgentConfig[] = [];

  try {
    const [projectRes, agentsRes] = await Promise.all([
      api<Project>(`/v1/projects/${id}`).catch(() => null),
      dataApi<{ ok: boolean; data: AgentConfig[] }>(id, "/v1/agents").catch(
        () => ({ ok: false, data: [] as AgentConfig[] }),
      ),
    ]);
    project = projectRes;
    agents = agentsRes.data ?? [];
  } catch {}

  return (
    <PlaygroundView
      projectId={id}
      apiUrl={API_URL}
      projectName={project?.name ?? "Your project"}
      initialAgents={agents}
    />
  );
}

export default async function PlaygroundPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <Suspense fallback={<PlaygroundSkeleton />}>
      <PlaygroundData id={id} />
    </Suspense>
  );
}
