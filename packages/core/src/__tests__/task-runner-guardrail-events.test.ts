import { describe, expect, it, vi } from "vitest";
import { TaskRunner } from "../task-runner.js";
import type { RuntimeGuardrailAuditEvent } from "../guardrails/index.js";

function guardrailEvent(id: string): RuntimeGuardrailAuditEvent {
  return {
    decision: {
      id,
      policyId: "output.secret-pattern",
      phase: "output",
      action: "redact",
      risk: "high",
      reason: "Sensitive value",
    },
    context: {
      runId: "run-guardrail",
      agent: "agent-1",
      source: "task",
      surface: "task",
    },
  };
}

function harness(options?: {
  logEntries?: Array<{ ts: string; event: string; data: unknown }>;
  logError?: Error;
}) {
  const events: Array<[string, unknown]> = [];
  const activityEvent = guardrailEvent("decision-activity");
  const run = {
    id: "run-guardrail",
    taskId: "task-guardrail",
    pid: 1,
    agentName: "agent-1",
    status: "completed",
    startedAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:01.000Z",
    completedAt: "2026-07-29T00:00:01.000Z",
    activity: {
      filesCreated: [],
      filesEdited: [],
      toolCalls: 0,
      totalTokens: 0,
      lastUpdate: "2026-07-29T00:00:01.000Z",
      sessionId: "session-guardrail",
      guardrailDecisions: [activityEvent],
    },
    result: {
      exitCode: 0,
      stdout: "safe",
      stderr: "",
      duration: 1,
    },
    configPath: "memory://run-guardrail",
    delivery: "background",
  };
  const ctx: any = {
    emitter: {
      emit: (name: string, payload: unknown) => {
        events.push([name, payload]);
        return true;
      },
    },
    runStore: {
      getTerminalRuns: vi.fn(async () => [run]),
      markRunCollected: vi.fn(async () => undefined),
    },
    taskStore: {
      updateTask: vi.fn(async () => undefined),
    },
    logStore: {
      getSessionEntries: vi.fn(async () => {
        if (options?.logError) throw options.logError;
        return options?.logEntries ?? [];
      }),
    },
  };
  return { ctx, events };
}

describe("TaskRunner guardrail event collection", () => {
  it("emits deduplicated persisted guardrail decisions before collecting a run", async () => {
    const logged = guardrailEvent("decision-log");
    const duplicate = guardrailEvent("decision-activity");
    const h = harness({
      logEntries: [
        {
          ts: "2026-07-29T00:00:00.500Z",
          event: "transcript:guardrail_decision",
          data: { type: "guardrail_decision", event: logged },
        },
        {
          ts: "2026-07-29T00:00:00.600Z",
          event: "transcript:guardrail_decision",
          data: { type: "guardrail_decision", event: duplicate },
        },
        {
          ts: "2026-07-29T00:00:00.700Z",
          event: "transcript:guardrail_decision",
          data: { type: "guardrail_decision", event: { malformed: true } },
        },
      ],
    });
    const onResult = vi.fn();

    await new TaskRunner(h.ctx).collectResults(onResult);

    expect(h.events.filter(([name]) => name === "runtime:guardrail")).toEqual([
      ["runtime:guardrail", {
        runId: "run-guardrail",
        taskId: "task-guardrail",
        agentName: "agent-1",
        event: logged,
      }],
      ["runtime:guardrail", {
        runId: "run-guardrail",
        taskId: "task-guardrail",
        agentName: "agent-1",
        event: duplicate,
      }],
    ]);
    expect(onResult).toHaveBeenCalledOnce();
  });

  it("falls back to bounded activity decisions when transcript reads fail", async () => {
    const h = harness({ logError: new Error("log store unavailable") });

    await expect(
      new TaskRunner(h.ctx).collectResults(vi.fn()),
    ).resolves.toBeUndefined();

    expect(h.events).toContainEqual([
      "runtime:guardrail",
      expect.objectContaining({
        runId: "run-guardrail",
        event: expect.objectContaining({
          decision: expect.objectContaining({ id: "decision-activity" }),
        }),
      }),
    ]);
  });
});
