import { describe, expect, it } from "vitest";
import { createRuntimePlan } from "@polpo-ai/core/runtime-plan";
import {
  POLPO_SSE_EVENT_NAMES,
  PolpoStore,
  isRuntimePlanSSEEvent,
  selectLatestRuntimePlan,
  selectRuntimePlan,
  type RuntimePlanSSEEvent,
} from "../index.js";

function runtimePlanEvent(planId = "plan-1"): RuntimePlanSSEEvent {
  const plan = createRuntimePlan(
    {
      id: planId,
      surface: "agent",
      source: "request",
      model: { selection: "openai/gpt-5", source: "default" },
    },
    { now: () => "2026-07-28T10:00:00.000Z" },
  );
  return {
    id: "event-1",
    event: "runtime:plan",
    data: { type: "runtime.plan.resolved", plan },
    timestamp: "2026-07-28T10:00:00.000Z",
  };
}

describe("SDK runtime inspection contracts", () => {
  it("subscribes to runtime plan events", () => {
    expect(POLPO_SSE_EVENT_NAMES).toContain("runtime:plan");
  });

  it("narrows a valid runtime plan SSE event", () => {
    const event = runtimePlanEvent();
    expect(isRuntimePlanSSEEvent(event)).toBe(true);
    if (isRuntimePlanSSEEvent(event)) {
      expect(event.data.plan.id).toBe("plan-1");
      expect(event.data.plan.audit.planner).toBe("runtime-default");
    }
  });

  it.each([
    { event: "message", data: {} },
    { event: "runtime:plan", data: null },
    { event: "runtime:plan", data: { type: "runtime.plan.resolved" } },
    {
      event: "runtime:plan",
      data: { type: "wrong", plan: { id: "plan-1" } },
    },
  ])("rejects malformed runtime plan event %#", ({ event, data }) => {
    expect(isRuntimePlanSSEEvent({
      id: "event",
      event,
      data,
      timestamp: "2026-07-28T10:00:00.000Z",
    })).toBe(false);
  });

  it("stores runtime plans by id and exposes the latest decision", () => {
    const store = new PolpoStore();
    const first = runtimePlanEvent("plan-1");
    const second = {
      ...runtimePlanEvent("plan-2"),
      id: "event-2",
      timestamp: "2026-07-28T10:00:01.000Z",
    };

    store.applyEvent(first);
    store.applyEvent(second);

    expect(selectRuntimePlan(store.getSnapshot(), "plan-1")?.id).toBe("plan-1");
    expect(selectLatestRuntimePlan(store.getSnapshot())?.id).toBe("plan-2");
  });

  it("retains malformed events for diagnostics but never indexes them as plans", () => {
    const store = new PolpoStore();
    store.applyEvent({
      id: "bad-event",
      event: "runtime:plan",
      data: { type: "runtime.plan.resolved", plan: { id: "incomplete" } },
      timestamp: "2026-07-28T10:00:00.000Z",
    });

    expect(store.getSnapshot().recentEvents).toHaveLength(1);
    expect(store.getSnapshot().runtimePlans?.size).toBe(0);
    expect(selectLatestRuntimePlan(store.getSnapshot())).toBeUndefined();
  });

  it("bounds indexed runtime plans while retaining the latest decision", () => {
    const store = new PolpoStore();
    for (let index = 0; index < 201; index += 1) {
      store.applyEvent({
        ...runtimePlanEvent(`plan-${index}`),
        id: `event-${index}`,
      });
    }

    expect(store.getSnapshot().runtimePlans?.size).toBe(200);
    expect(selectRuntimePlan(store.getSnapshot(), "plan-0")).toBeUndefined();
    expect(selectLatestRuntimePlan(store.getSnapshot())?.id).toBe("plan-200");
  });
});
