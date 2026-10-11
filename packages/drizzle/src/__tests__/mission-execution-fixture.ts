import { randomUUID } from "node:crypto";
import type { Mission, Task } from "@polpo-ai/core/types";
import type { MissionExecutionCommit } from "@polpo-ai/core/mission-store";

export function executionPlan(mission: Mission, key = "occurrence-a"): MissionExecutionCommit {
  const sequence = (mission.executionCount ?? 0) + 1;
  const group = sequence > 1 ? `${mission.name} #${sequence}` : mission.name;
  const createdAt = new Date().toISOString(), first = randomUUID();
  const task = (id: string, title: string, dependsOn: string[]): Task => ({ id, title, description: title, assignTo: "support",
    missionId: mission.id, group, user: mission.user, dependsOn, status: "pending", retries: 0, maxRetries: 0,
    expectations: [], metrics: [], createdAt, updatedAt: createdAt });
  return { expected: mission, receipt: { executionId: randomUUID(), missionId: mission.id, idempotencyKey: key,
    group, sequence, user: mission.user, createdAt, tasks: [task(first, "First", []), task(randomUUID(), "Second", [first])] } };
}
