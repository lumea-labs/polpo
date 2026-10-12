import type { MissionStore } from "./mission-store.js";
import type { TaskStore } from "./task-store.js";
import { currentMissionExecutionTasks } from "./mission-inspection.js";
import { isMissionExecutionCancellationStore, MissionExecutionError, validateMissionExecutionKey,
  type MissionAbortOptions, type MissionAbortResult, type MissionExecutionStore } from "./mission-execution.js";
import { TaskExecutionError } from "./task-execution.js";

/** Cancel accepted work from a cold host without starting schedules, restoring
 * agents or dispatching unrelated Tasks. Notify returned Run owners after commit. */
export async function cancelMissionExecution(stores: {
  missionStore: Pick<MissionStore, "getMission">;
  taskStore: Pick<TaskStore, "listTasks">;
  missionExecutionStore?: MissionExecutionStore;
}, missionId: string, options: MissionAbortOptions = {}): Promise<MissionAbortResult & { missionCancelled: boolean; killedRunIds: string[] }> {
  const executionId = options.executionId;
  validateMissionExecutionKey(missionId, "abort");
  if (executionId !== undefined) validateMissionExecutionKey(executionId, "abort");
  const stored = await stores.missionStore.getMission(missionId);
  if (!stored) throw new MissionExecutionError("mission_execution_invalid", "Mission not found");
  const mission = structuredClone(stored);
  const persistence = stores.missionExecutionStore;
  const tasks = structuredClone(await stores.taskStore.listTasks());
  const selected = executionId === undefined ? await currentMissionExecutionTasks(mission, tasks, persistence) : [];
  const ids = new Set(selected.map(task => task.missionExecutionId));
  const target = executionId ?? (ids.size === 1 ? [...ids][0] : undefined);
  if (!target) {
    if (!selected.length && !mission.executionCount && mission.status === "draft") return { aborted: 0, missionCancelled: false, killedRunIds: [] };
    throw new MissionExecutionError("mission_execution_unsupported", "Mission cancellation requires an accepted execution ID; legacy group labels cannot authorize cancellation");
  }
  if (!isMissionExecutionCancellationStore(persistence)) {
    throw new MissionExecutionError("mission_execution_unsupported", "Mission cancellation requires atomic persistence");
  }
  const admission = await persistence.getMissionExecutionById(target);
  if (!admission || admission.receipt.missionId !== missionId || admission.receipt.executionId !== target) {
    throw new MissionExecutionError("mission_execution_invalid", "Execution does not belong to this Mission");
  }
  // Retain the snapshots read above through the commit. Re-reading after an
  // await would acquire authority over a replacement attempt unintentionally.
  const current = new Map(tasks.map(task => [task.id, task]));
  const conditions = admission.receipt.tasks.map(accepted => {
    const snapshot = current.get(accepted.id);
    if (!snapshot) throw new TaskExecutionError("task_execution_conflict", "Accepted Mission task is missing");
    return { taskId: accepted.id, snapshot };
  });
  return persistence.abortMissionExecution({ missionId, executionId: target, tasks: conditions });
}
