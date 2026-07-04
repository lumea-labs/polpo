import { describe, it, expect } from "vitest";
import {
  taskStoreMissionAdapter,
  resolveMissionStore,
  resolveMissionForTask,
  type MissionStore,
} from "../mission-store.js";
import type { TaskStore } from "../task-store.js";
import type { Mission } from "../types.js";

const mission = (id: string, name: string): Mission =>
  ({ id, name, data: "", status: "active", createdAt: "", updatedAt: "" }) as Mission;

function storeWithMissions(): TaskStore {
  const byId = new Map([["m1", mission("m1", "Launch")]]);
  return {
    getMission: async (id: string) => byId.get(id),
    getMissionByName: async (name: string) => [...byId.values()].find((m) => m.name === name),
    listMissions: async () => [...byId.values()],
  } as unknown as TaskStore;
}

function storeWithoutMissions(): TaskStore {
  return {} as TaskStore;
}

describe("taskStoreMissionAdapter", () => {
  it("delegates reads and degrades gracefully on missing read methods", async () => {
    const withMissions = taskStoreMissionAdapter(storeWithMissions());
    expect((await withMissions.getMission("m1"))?.name).toBe("Launch");
    expect((await withMissions.getMissionByName("Launch"))?.id).toBe("m1");
    expect(await withMissions.listMissions()).toHaveLength(1);

    const without = taskStoreMissionAdapter(storeWithoutMissions());
    expect(await without.getMission("m1")).toBeUndefined();
    expect(await without.listMissions()).toEqual([]);
  });

  it("throws descriptive errors for writes on stores without mission support", async () => {
    const adapter = taskStoreMissionAdapter(storeWithoutMissions());
    await expect(adapter.createMission({} as never)).rejects.toThrow("Store does not support missions");
    await expect(adapter.updateMission("m1", {})).rejects.toThrow("Store does not support missions");
    await expect(adapter.deleteMission("m1")).rejects.toThrow("Store does not support missions");
  });

  it("nextMissionName falls back to a generated name", async () => {
    const adapter = taskStoreMissionAdapter(storeWithoutMissions());
    expect(await adapter.nextMissionName()).toMatch(/^mission-\d+$/);
  });
});

describe("resolveMissionStore", () => {
  it("prefers the explicit missionStore port", async () => {
    const explicit = { getMission: async () => mission("mx", "Explicit") } as unknown as MissionStore;
    const resolved = resolveMissionStore({ missionStore: explicit, taskStore: storeWithMissions() });
    expect((await resolved.getMission("whatever"))?.name).toBe("Explicit");
  });

  it("falls back to the task-store adapter", async () => {
    const resolved = resolveMissionStore({ taskStore: storeWithMissions() });
    expect((await resolved.getMission("m1"))?.name).toBe("Launch");
  });
});

describe("resolveMissionForTask", () => {
  const missions = taskStoreMissionAdapter(storeWithMissions());

  it("resolves via the missionId FK", async () => {
    const m = await resolveMissionForTask(missions, { missionId: "m1" });
    expect(m?.id).toBe("m1");
  });

  it("returns undefined for tasks outside any mission", async () => {
    expect(await resolveMissionForTask(missions, {})).toBeUndefined();
  });
});
