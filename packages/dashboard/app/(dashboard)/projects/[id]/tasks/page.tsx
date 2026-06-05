import { Suspense } from "react";
import { dataApi } from "../../../../../lib/api";
import type { Task, Mission } from "@polpo-ai/core";
import { TasksListSkeleton } from "../../../../../components/dashboard/skeletons";
import TasksView from "./view";

async function TasksData({ id }: { id: string }) {
  let tasks: Task[] = [];
  let missions: Mission[] = [];

  try {
    const [tasksRes, missionsRes] = await Promise.all([
      dataApi<{ ok: boolean; data: Task[] }>(id, "/v1/tasks").catch(() => ({
        ok: false,
        data: [] as Task[],
      })),
      dataApi<{ ok: boolean; data: Mission[] }>(id, "/v1/missions").catch(
        () => ({ ok: false, data: [] as Mission[] }),
      ),
    ]);
    tasks = tasksRes.data ?? [];
    missions = missionsRes.data ?? [];
  } catch {}

  return <TasksView initialTasks={tasks} initialMissions={missions} />;
}

export default async function TasksPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <Suspense fallback={<TasksListSkeleton />}>
      <TasksData id={id} />
    </Suspense>
  );
}
