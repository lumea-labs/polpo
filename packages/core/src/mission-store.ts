/**
 * MissionStore — canonical persistence contract for missions.
 *
 * Historically missions were bolted onto TaskStore as OPTIONAL methods,
 * which forced every consumer into defensive `store.getMission?.()` calls
 * and left "does this deployment support missions?" implicit. This module
 * makes the contract explicit:
 *
 * - `MissionStore` is the non-optional interface.
 * - `taskStoreMissionAdapter` adapts the legacy TaskStore mission block to
 *   it (missing write methods throw descriptive errors on use).
 * - `resolveMissionStore(ctx)` picks the explicit port when a runtime
 *   provides one, otherwise falls back to the task-store adapter.
 * - `resolveMissionForTask` is the ONE home of the missionId/group legacy
 *   fallback (tasks created before the missionId FK existed resolve their
 *   mission by group name).
 */

import type { Mission } from "./types.js";
import type { TaskStore } from "./task-store.js";

export interface MissionStore {
  createMission(mission: Omit<Mission, "id" | "createdAt" | "updatedAt">): Promise<Mission>;
  getMission(missionId: string): Promise<Mission | undefined>;
  getMissionByName(name: string): Promise<Mission | undefined>;
  listMissions(): Promise<Mission[]>;
  updateMission(missionId: string, updates: Partial<Omit<Mission, "id">>): Promise<Mission>;
  deleteMission(missionId: string): Promise<boolean>;
  nextMissionName(): Promise<string>;
}

/**
 * Adapt a TaskStore's legacy (optional) mission methods to the canonical
 * MissionStore contract. Reads degrade gracefully (undefined / empty);
 * writes on a store without mission support throw a descriptive error.
 */
export function taskStoreMissionAdapter(store: TaskStore & Partial<MissionStore>): MissionStore {
  const unsupported = (): never => {
    throw new Error("Store does not support missions");
  };
  return {
    createMission: async (mission) => store.createMission ? store.createMission(mission) : unsupported(),
    getMission: async (missionId) => store.getMission?.(missionId),
    getMissionByName: async (name) => store.getMissionByName?.(name),
    listMissions: async () => (await store.listMissions?.()) ?? [],
    updateMission: async (missionId, updates) =>
      store.updateMission ? store.updateMission(missionId, updates) : unsupported(),
    deleteMission: async (missionId) => store.deleteMission ? store.deleteMission(missionId) : unsupported(),
    nextMissionName: async () => (await store.nextMissionName?.()) ?? `mission-${Date.now()}`,
  };
}

/**
 * Resolve the mission store for an orchestrator context: the explicit
 * `missionStore` port when the runtime provides one, otherwise the
 * task-store adapter (legacy layout — file and Drizzle task stores both
 * implement the mission block).
 */
export function resolveMissionStore(ctx: { missionStore?: MissionStore; taskStore: TaskStore }): MissionStore {
  // The legacy file/drizzle task stores still carry the mission methods on the class.
  return ctx.missionStore ?? taskStoreMissionAdapter(ctx.taskStore as TaskStore & Partial<MissionStore>);
}

/**
 * Resolve the mission a task belongs to via the missionId FK.
 * (The legacy group-name fallback was removed in 0.12.)
 */
export async function resolveMissionForTask(
  missions: MissionStore,
  task: { missionId?: string },
): Promise<Mission | undefined> {
  if (task.missionId) return missions.getMission(task.missionId);
  return undefined;
}

/**
 * Resolve the Mission for a group of tasks.
 * Uses task.missionId (direct FK) when available, falls back to getMissionByName
 * for legacy tasks that pre-date the missionId field.
 */
export async function resolveMissionForGroup(
  missions: MissionStore,
  groupTasks: Array<{ missionId?: string }>,
  group: string,
): Promise<Mission | undefined> {
  // Prefer the direct ID reference from any task in the group
  const mid = groupTasks.find(t => t.missionId)?.missionId;
  if (mid) return missions.getMission(mid);
  // Fallback: strip run-number suffix (e.g. "Mission #3" → "Mission") for legacy compat
  return missions.getMissionByName(group.replace(/ #\d+$/, ""));
}
