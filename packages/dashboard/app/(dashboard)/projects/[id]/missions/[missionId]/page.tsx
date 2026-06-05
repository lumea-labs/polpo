import { Suspense } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { dataApi } from "#/lib/api";
import type { Mission, Task } from "@polpo-ai/core";
import { MissionGraphSkeleton, MissionHeaderSkeleton } from "#/components/dashboard/skeletons";
import { MissionHeader, MissionTasksPanel } from "./view";

async function MissionHeaderData({
  id,
  missionId,
}: {
  id: string;
  missionId: string;
}) {
  let mission: Mission | null = null;
  try {
    const res = await dataApi<{ ok: boolean; data: Mission }>(
      id,
      `/v1/missions/${missionId}`,
    );
    mission = res.data ?? null;
  } catch {}

  return (
    <MissionHeader projectId={id} missionId={missionId} initialMission={mission} />
  );
}

async function MissionTasksData({
  id,
  missionId,
}: {
  id: string;
  missionId: string;
}) {
  // Fetch both the spawned tasks (live) and the mission record (for the
  // draft-mode preview that parses `mission.data` into the same shape).
  let tasks: Task[] = [];
  let mission: Mission | null = null;
  try {
    const [tasksRes, missionRes] = await Promise.all([
      dataApi<{ ok: boolean; data: Task[] }>(id, "/v1/tasks"),
      dataApi<{ ok: boolean; data: Mission }>(id, `/v1/missions/${missionId}`),
    ]);
    tasks = (tasksRes.data ?? []).filter((t) => t.missionId === missionId);
    mission = missionRes.data ?? null;
  } catch {}

  return (
    <MissionTasksPanel
      projectId={id}
      missionId={missionId}
      initialTasks={tasks}
      initialMission={mission}
    />
  );
}

export default async function MissionDetailPage({
  params,
}: {
  params: Promise<{ id: string; missionId: string }>;
}) {
  const { id, missionId } = await params;

  return (
    <div>
      {/* Back — static, renders immediately */}
      <Link
        href={`/projects/${id}/missions`}
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-3 w-3" />
        Missions
      </Link>

      {/* Two parallel Suspense boundaries — mission metadata and tasks stream independently */}
      <Suspense fallback={<MissionHeaderSkeleton />}>
        <MissionHeaderData id={id} missionId={missionId} />
      </Suspense>

      <Suspense fallback={<MissionGraphSkeleton />}>
        <MissionTasksData id={id} missionId={missionId} />
      </Suspense>
    </div>
  );
}
