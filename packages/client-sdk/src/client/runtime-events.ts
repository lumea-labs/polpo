import type {
  RuntimeContextAccounting,
  RuntimePlan,
  RuntimePlanResolvedEvent,
} from "@polpo-ai/core";
import { normalizeRuntimePlan } from "@polpo-ai/core/runtime-plan";
import type { SSEEvent } from "./types.js";

export type {
  RuntimeContextAccounting,
  RuntimePlan,
  RuntimePlanResolvedEvent,
};

export type RuntimePlanSSEEvent = SSEEvent<
  "runtime:plan",
  RuntimePlanResolvedEvent
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Conservative wire guard for runtime plan events. It validates enough of the
 * immutable public contract to make SDK narrowing safe without accepting
 * arbitrary `runtime:plan` payloads as trusted decisions.
 */
export function isRuntimePlanSSEEvent(
  event: SSEEvent,
): event is RuntimePlanSSEEvent {
  if (event.event !== "runtime:plan" || !isRecord(event.data)) return false;
  if (event.data.type !== "runtime.plan.resolved" || !isRecord(event.data.plan)) {
    return false;
  }
  try {
    normalizeRuntimePlan(event.data.plan);
    return true;
  } catch {
    return false;
  }
}
