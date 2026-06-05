import { Suspense } from "react";
import { api, dataApi } from "../../../../lib/api";
import type { Project } from "../../../../lib/api";
import type { AgentConfig, Task, Mission } from "@polpo-ai/core";
import { ProjectOverviewSkeleton } from "../../../../components/dashboard/skeletons";
import ProjectOverviewView from "./view";
import WelcomeBanner from "./welcome-banner";

async function OverviewData({ id }: { id: string }) {
  let agents: AgentConfig[] = [];
  let tasks: Task[] = [];
  let missions: Mission[] = [];
  let project: Project | null = null;

  try {
    const [agentsRes, tasksRes, missionsRes, projectRes] = await Promise.all([
      dataApi<{ ok: boolean; data: AgentConfig[] }>(id, "/v1/agents").catch(
        () => ({ ok: false, data: [] as AgentConfig[] }),
      ),
      dataApi<{ ok: boolean; data: Task[] }>(id, "/v1/tasks").catch(() => ({
        ok: false,
        data: [] as Task[],
      })),
      dataApi<{ ok: boolean; data: Mission[] }>(id, "/v1/missions").catch(
        () => ({ ok: false, data: [] as Mission[] }),
      ),
      api<Project>(`/v1/projects/${id}`).catch(() => null),
    ]);
    agents = agentsRes.data ?? [];
    tasks = tasksRes.data ?? [];
    missions = missionsRes.data ?? [];
    project = projectRes;
  } catch {}

  return (
    <ProjectOverviewView
      initialAgents={agents}
      initialTasks={tasks}
      initialMissions={missions}
      projectName={project?.name ?? "Your project"}
      projectSlug={project?.slug}
      initialChecklist={project?.onboardingChecklist ?? {}}
      welcomeBanner={
        <WelcomeBanner
          key={`welcome-${id}`}
          projectId={id}
          projectName={project?.name ?? "Your project"}
          projectSlug={project?.slug}
          agentName={agents[0]?.name ?? null}
        />
      }
    />
  );
}

export default async function ProjectOverviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <Suspense fallback={<ProjectOverviewSkeleton />}>
      <OverviewData id={id} />
    </Suspense>
  );
}
