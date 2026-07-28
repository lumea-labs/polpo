import { freezeRuntimePlan } from "./planner.js";
import type { RuntimePlan, RuntimePlanResolvedEvent } from "./types.js";

export const RUNTIME_PLAN_EVENT = "runtime:plan" as const;
export const RUNTIME_PLAN_RESOLVED_TYPE = "runtime.plan.resolved" as const;

export function createRuntimePlanResolvedEvent(
  plan: RuntimePlan,
): RuntimePlanResolvedEvent {
  return freezeRuntimePlan({
    type: RUNTIME_PLAN_RESOLVED_TYPE,
    plan: freezeRuntimePlan(plan),
  });
}
