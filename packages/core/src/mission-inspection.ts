import type { Mission, Task, ActiveCheckpoint, ActiveDelay, MissionRuntimeIdentity } from "./types.js";
import type { MissionStore } from "./mission-store.js";
import type { TaskStore } from "./task-store.js";
import type { CheckpointStore, CheckpointState } from "./checkpoint-store.js";
import type { DelayStore, DelayState } from "./delay-store.js";
import { assertMissionExecutionTask, MissionExecutionError, type MissionExecutionStore, type MissionExecutionCommit } from "./mission-execution.js";

type ExecutionReader = Pick<MissionExecutionStore, "getMissionExecutionById">;

/** Selection shared by runtime controls and read-only hosts. Display labels are
 * a fallback only for tasks that predate durable execution identities. */
export async function currentMissionExecutionTasks(mission: Mission, tasks: Task[], executions?: ExecutionReader): Promise<Task[]> {
  const current: Task[] = [];
  const receipts = new Map<string, MissionExecutionCommit | undefined>();
  const legacyGroup = (mission.executionCount ?? 0) > 1 ? `${mission.name} #${mission.executionCount}` : mission.name;
  for (const task of tasks) {
    if (task.missionId !== mission.id && (task.missionId || task.group !== legacyGroup)) continue;
    if (task.missionExecutionId) {
      if (!receipts.has(task.missionExecutionId)) receipts.set(task.missionExecutionId,
        await executions?.getMissionExecutionById(task.missionExecutionId));
      const admission = receipts.get(task.missionExecutionId);
      if (!admission) throw new MissionExecutionError("mission_execution_invalid", "Mission execution receipt is missing");
      const { receipt } = admission;
      assertMissionExecutionTask(task, receipt);
      if (receipt.missionId !== mission.id) throw new MissionExecutionError("mission_execution_invalid", "Mission execution belongs to another Mission");
      if (receipt.sequence !== mission.executionCount) continue;
    } else if (task.group !== legacyGroup) continue;
    current.push(task);
  }
  return current;
}

export async function resumableMissions(missions: Mission[], tasks: Task[], executions?: ExecutionReader): Promise<Mission[]> {
  const result: Mission[] = [];
  for (const mission of missions) {
    if (!["active", "paused", "failed"].includes(mission.status)) continue;
    if ((await currentMissionExecutionTasks(mission, tasks, executions)).some(task => task.status === "pending" || task.status === "failed")) result.push(mission);
  }
  return result;
}

export function activeMissionCheckpoints(state: CheckpointState, identity: (key: string) => MissionRuntimeIdentity): ActiveCheckpoint[] {
  return Object.entries(state.active).map(([key, data]) => {
    const checkpointName = data.checkpoint.name;
    return { ...identity(key.slice(0, -(checkpointName.length + 1))), checkpointName, checkpoint: data.checkpoint, reachedAt: data.reachedAt };
  });
}

export function activeMissionDelays(state: DelayState, identity: (key: string) => MissionRuntimeIdentity): ActiveDelay[] {
  return Object.entries(state.active).map(([key, data]) => {
    const delayName = data.delay.name;
    return { ...identity(key.slice(0, -(delayName.length + 1))), delayName, delay: data.delay, startedAt: data.startedAt, expiresAt: data.expiresAt };
  });
}

/** Cold inspection exposes only read capabilities. Every method loads current
 * persistence independently: reading gates never validates unrelated Missions
 * or starts schedules/ticks, restores agents, expires timers or writes state. */
export function createMissionRuntimeInspector(stores: {
  taskStore: Pick<TaskStore, "listTasks">;
  missionStore: Pick<MissionStore, "listMissions">;
  missionExecutionStore?: ExecutionReader;
  checkpointStore: Pick<CheckpointStore, "load">;
  delayStore: Pick<DelayStore, "load">;
}) {
  async function identitiesFor(keys: Set<string>): Promise<Map<string, MissionRuntimeIdentity>> {
    const identities = new Map<string, MissionRuntimeIdentity>();
    if (!keys.size) return identities;
    let tasks: Task[] | undefined;
    for (const key of keys) {
      const receipt = /^[a-zA-Z0-9_-]{1,200}$/.test(key)
        ? (await stores.missionExecutionStore?.getMissionExecutionById(key))?.receipt : undefined;
      if (receipt) {
        if (receipt.executionId !== key) throw new MissionExecutionError("mission_execution_invalid", "Mission execution receipt does not match its key");
        identities.set(key, { executionId: receipt.executionId, missionId: receipt.missionId, group: receipt.group });
      } else {
        // A valid receipt is sufficient. Unrelated corrupt/unavailable tasks
        // must not hide gates whose accepted identity is already known.
        tasks ??= await stores.taskStore.listTasks();
        if (tasks.some(task => task.missionExecutionId === key)) {
          throw new MissionExecutionError("mission_execution_invalid", "Mission execution receipt is missing");
        }
      }
    }
    return identities;
  }
  return {
    async getActiveCheckpoints(): Promise<ActiveCheckpoint[]> {
      const state = await stores.checkpointStore.load();
      const identities = await identitiesFor(new Set(Object.entries(state.active)
        .map(([key, data]) => key.slice(0, -(data.checkpoint.name.length + 1)))));
      return activeMissionCheckpoints(state, key => identities.get(key) ?? { group: key });
    },
    async getActiveDelays(): Promise<ActiveDelay[]> {
      const state = await stores.delayStore.load();
      const identities = await identitiesFor(new Set(Object.entries(state.active)
        .map(([key, data]) => key.slice(0, -(data.delay.name.length + 1)))));
      return activeMissionDelays(state, key => identities.get(key) ?? { group: key });
    },
    async getResumableMissions(): Promise<Mission[]> {
      const [missions, tasks] = await Promise.all([stores.missionStore.listMissions(), stores.taskStore.listTasks()]);
      return resumableMissions(missions, tasks, stores.missionExecutionStore);
    },
  };
}
