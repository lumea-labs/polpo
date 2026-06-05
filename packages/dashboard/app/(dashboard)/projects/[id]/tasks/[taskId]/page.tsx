import { Suspense } from "react";
import { dataApi } from "../../../../../../lib/api";
import type { Task } from "@polpo-ai/core";
import { TaskDetailSkeleton } from "../../../../../../components/dashboard/skeletons";
import { resolveBlueprint, type BlueprintContext } from "./blueprint";
import type { TaskActivityPayload } from "./activity/view";
import { TaskStudio, type TaskStudioInitialData } from "../../../../../../components/dashboard/task-studio";

/**
 * Task detail = the Task Studio (fast client surface, like the Agent
 * Studio). One server fetch (the activity payload already carries the full
 * task) hydrates a client component with client-switched tabs; pure dogfood
 * from there via the published SDK.
 */
async function TaskData({ id, taskId }: { id: string; taskId: string }) {
  let task: Task | null = null;
  let activity: TaskActivityPayload = {
    task: null,
    run: null,
    sessionId: null,
    sessionResolution: "missing",
    entries: [],
  };
  try {
    // The activity payload already contains the full task — one call.
    const res = await dataApi<{ ok: boolean; data: TaskActivityPayload }>(
      id,
      `/v1/tasks/${taskId}/activity`,
    );
    activity = res.data ?? activity;
    task = activity.task;
  } catch {
    /* falls through to blueprint resolution below */
  }

  // Draft/blueprint tasks aren't persisted yet — synthesise from the mission.
  let blueprint: BlueprintContext | null = null;
  if (!task) {
    const bp = await resolveBlueprint(id, taskId);
    if (bp) {
      task = bp.task;
      blueprint = bp.context;
      activity = { ...activity, task: bp.task, blueprint: bp.context };
    }
  }

  const initialData: TaskStudioInitialData = { task, activity, blueprint };
  return <TaskStudio projectId={id} taskId={taskId} initialData={initialData} />;
}

export default async function TaskDetailPage({
  params,
}: {
  params: Promise<{ id: string; taskId: string }>;
}) {
  const { id, taskId } = await params;

  return (
    <Suspense fallback={<TaskDetailSkeleton />}>
      <TaskData id={id} taskId={taskId} />
    </Suspense>
  );
}
