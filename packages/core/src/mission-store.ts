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
  saveMission(mission: Omit<Mission, "id" | "createdAt" | "updatedAt">): Promise<Mission>;
  getMission(missionId: string): Promise<Mission | undefined>;
  getMissionByName(name: string): Promise<Mission | undefined>;
  getAllMissions(): Promise<Mission[]>;
  updateMission(missionId: string, updates: Partial<Omit<Mission, "id">>): Promise<Mission>;
  deleteMission(missionId: string): Promise<boolean>;
  nextMissionName(): Promise<string>;
}

/**
 * Adapt a TaskStore's legacy (optional) mission methods to the canonical
 * MissionStore contract. Reads degrade gracefully (undefined / empty);
 * writes on a store without mission support throw a descriptive error.
 */
export function taskStoreMissionAdapter(store: TaskStore): MissionStore {
  const unsupported = (): never => {
    throw new Error("Store does not support missions");
  };
  return {
    saveMission: async (mission) => store.saveMission ? store.saveMission(mission) : unsupported(),
    getMission: async (missionId) => store.getMission?.(missionId),
    getMissionByName: async (name) => store.getMissionByName?.(name),
    getAllMissions: async () => (await store.getAllMissions?.()) ?? [],
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
export function resolveMissionStore(ctx: { missionStore?: MissionStore; registry: TaskStore }): MissionStore {
  return ctx.missionStore ?? taskStoreMissionAdapter(ctx.registry);
}

/**
 * Resolve the mission a task belongs to — the single home of the legacy
 * fallback: `missionId` (direct FK) is preferred; tasks created before the
 * missionId field resolve by `group` name.
 */
export async function resolveMissionForTask(
  missions: MissionStore,
  task: { missionId?: string; group?: string },
): Promise<Mission | undefined> {
  if (task.missionId) return missions.getMission(task.missionId);
  if (task.group) return missions.getMissionByName(task.group);
  return undefined;
}
