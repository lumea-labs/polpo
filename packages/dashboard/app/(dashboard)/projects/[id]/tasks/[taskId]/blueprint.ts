import { dataApi } from "#/lib/api";
import type { Mission, Task } from "@polpo-ai/core";

export interface BlueprintContext {
  missionName: string;
  missionStatus?: string;
}

interface BlueprintTaskDoc {
  title: string;
  description?: string;
  assignTo?: string;
  dependsOn?: string[];
  expectations?: unknown[];
  expectedOutcomes?: unknown[];
  sideEffects?: boolean;
}

export async function resolveBlueprint(
  projectId: string,
  taskId: string,
): Promise<{ task: Task; mission: Mission; context: BlueprintContext } | null> {
  try {
    const res = await dataApi<{ ok: boolean; data: Mission[] }>(projectId, "/v1/missions");
    const missions = res.data ?? [];

    for (const mission of missions) {
      if (!mission.data) continue;

      let parsed: { tasks?: BlueprintTaskDoc[] };
      try {
        parsed = typeof mission.data === "string"
          ? JSON.parse(mission.data)
          : (mission.data as unknown as { tasks?: BlueprintTaskDoc[] });
      } catch {
        continue;
      }

      const blueprint = parsed.tasks?.find((t) => t.title === taskId);
      if (!blueprint) continue;

      const synthetic: Task = {
        id: blueprint.title,
        title: blueprint.title,
        description: blueprint.description ?? "",
        assignTo: blueprint.assignTo ?? "",
        status: "draft",
        expectations: (blueprint.expectations ?? []) as Task["expectations"],
        expectedOutcomes: (blueprint.expectedOutcomes ?? []) as Task["expectedOutcomes"],
        dependsOn: blueprint.dependsOn ?? [],
        missionId: mission.id,
        retries: 0,
        maxRetries: 0,
        sideEffects: blueprint.sideEffects,
        createdAt: mission.createdAt ?? "",
        updatedAt: mission.updatedAt ?? "",
        metrics: [],
      };

      return {
        task: synthetic,
        mission,
        context: {
          missionName: mission.name,
          missionStatus: mission.status,
        },
      };
    }
  } catch {}

  return null;
}
