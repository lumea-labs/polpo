import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  InMemoryRunCancellationStore,
  InMemoryRunEventStore,
  InMemoryRunExecutionLeaseStore,
  type RunEventStore,
} from "@polpo-ai/core/run-delivery";
import {
  InMemoryRunEventNotifier,
  RunEventJournal,
} from "@polpo-ai/core/run-delivery-follower";
import { executeOwnedRun } from "@polpo-ai/core/run-delivery-owner";
import { MemoryLoopRunStore } from "@polpo-ai/core/loop-run-store";
import { RuntimeHookEngine } from "@polpo-ai/core/runtime-hooks";
import { completionRoutes, type CompletionRouteDeps } from "../completions.js";
import { reconcileInterruptedRun } from "../run-delivery.js";
import { resumeProjectLoopRun } from "./project-loop-runner.js";

/**
 * D-03: attached (request-bound) Project Loop runs must converge to a terminal
 * state after their process dies at any point, and must never be replayed.
 * A "crash" abandons the in-memory owner: its pending work never settles and
 * fake timers stop its heartbeat, so the lease simply expires.
 */

const T0 = new Date("2026-10-24T10:00:00.000Z");
const LEASE_MS = 30_000;

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

interface Harness {
  eventStore: RunEventStore;
  leaseStore: InMemoryRunExecutionLeaseStore;
  cancellationStore: InMemoryRunCancellationStore;
  loopRunStore: MemoryLoopRunStore;
  executed: string[];
  deps: CompletionRouteDeps;
}

function harness(options: {
  tool?: (name: string) => Promise<string>;
  stepBefore?: (step: unknown) => Promise<void>;
  eventStore?: RunEventStore;
} = {}): Harness {
  const eventStore = options.eventStore ?? new InMemoryRunEventStore();
  const leaseStore = new InMemoryRunExecutionLeaseStore();
  const cancellationStore = new InMemoryRunCancellationStore();
  const notifier = new InMemoryRunEventNotifier();
  const loopRunStore = new MemoryLoopRunStore();
  const executed: string[] = [];
  let attempt = 0;
  const hooks = options.stepBefore
    ? new RuntimeHookEngine({
        definitions: [{
          id: "observe-step",
          event: "step:before",
          mode: "observe",
          handler: { type: "tool", tool: "audit" },
        }],
        host: {
          execute: async ({ envelope }) => {
            await options.stepBefore!(envelope.data.step);
          },
        },
      })
    : undefined;
  const deps = {
    getAgents: async () => [{
      name: "publisher",
      model: "mock",
      assignedLoops: ["release"],
      allowedTools: ["prepare", "publish"],
    }],
    getConfig: () => ({}),
    getMemoryStore: () => null,
    getSessionStore: () => null,
    getStore: () => null,
    emit: () => {},
    getProjectLoop: async (name: string) => ({
      name,
      start: "prepare",
      steps: {
        prepare: { type: "tool", tool: "prepare", next: "publish" },
        publish: { type: "tool", tool: "publish", next: "end" },
      },
    }),
    ...(hooks ? { resolveRuntimeHooks: async () => hooks } : {}),
    resolveAgentTools: async () => ({
      tools: ["prepare", "publish"].map((name) => ({
        name,
        description: name,
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      })),
      executor: async (name: string) => {
        executed.push(name);
        return options.tool ? options.tool(name) : JSON.stringify({ ok: name });
      },
    }),
    getLoopRunStore: () => loopRunStore,
    createRunDeliveryScope: async () => ({
      eventStore,
      leaseStore,
      cancellationStore,
      notifier,
      owner: "replica-a",
      token: `attempt-${++attempt}`,
    }),
  } as unknown as CompletionRouteDeps;
  return { eventStore, leaseStore, cancellationStore, loopRunStore, executed, deps };
}

function startAttachedLoop(h: Harness, options: { stream?: boolean } = {}) {
  return completionRoutes(() => h.deps).request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agent: "publisher",
      loop: "release",
      messages: [{ role: "user", content: "ship it" }],
      ...(options.stream ? { stream: true } : {}),
    }),
  });
}

/** Host reconciler pass, mirroring the managed runtime's Loop projection. */
async function reconcileLoopRuns(h: Harness) {
  const active = [
    ...await h.loopRunStore.listRuns({ status: "running" }),
    ...await h.loopRunStore.listRuns({ status: "resuming" }),
  ];
  const results: string[] = [];
  for (const run of active) {
    const deliveryRunId = run.metadata?.deliveryRunId;
    if (typeof deliveryRunId !== "string") continue;
    results.push(await reconcileInterruptedRun({
      runId: deliveryRunId,
      eventStore: h.eventStore,
      leaseStore: h.leaseStore,
      cancellationStore: h.cancellationStore,
      onTerminal: async (_runId, terminal) => {
        await h.loopRunStore.updateRunIfCurrent(run.id, {
          status: run.status,
          updatedAt: run.updatedAt,
          deliveryRunId,
        }, {
          status: terminal.type === "run.cancelled" ? "cancelled" : "failed",
          error: typeof terminal.data.message === "string"
            ? terminal.data.message
            : "Run delivery completed without a persisted Loop result",
          completedAt: terminal.createdAt,
        });
      },
    }));
  }
  return results;
}

function crashAndExpireLease() {
  // The owner is abandoned: no timer fires again, so its lease is never
  // renewed, and the wall clock moves past its expiry.
  vi.setSystemTime(new Date(Date.now() + LEASE_MS + 1_000));
}

async function eventTypes(h: Harness, runId: string) {
  return (await h.eventStore.listAfter(runId)).events.map((event) => event.type);
}

describe("attached Project Loop crash recovery (D-03)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("terminalizes a run whose process died mid-tool without replaying it", async () => {
    const inPublish = deferred();
    const h = harness({
      tool: async (name) => {
        if (name !== "publish") return JSON.stringify({ ok: name });
        inPublish.resolve();
        return never();
      },
    });
    void startAttachedLoop(h);
    await inPublish.promise;

    const [running] = await h.loopRunStore.listRuns();
    expect(running?.status).toBe("running");
    const deliveryRunId = running!.metadata!.deliveryRunId as string;
    crashAndExpireLease();

    expect(await reconcileLoopRuns(h)).toEqual(["interrupted"]);
    const recovered = await h.loopRunStore.getRun(running!.id);
    expect(recovered).toMatchObject({
      status: "failed",
      error: "Run execution was interrupted before completion",
    });
    expect(await eventTypes(h, deliveryRunId)).toEqual(["run.started", "run.failed"]);
    expect(h.executed).toEqual(["prepare", "publish"]);

    // A later owner for the same delivery run is fenced, never replayed.
    const producer = vi.fn();
    await expect(executeOwnedRun({
      runId: deliveryRunId,
      owner: "replica-b",
      token: "late",
      journal: new RunEventJournal(h.eventStore),
      leaseStore: h.leaseStore,
      producer,
    })).resolves.toEqual({ status: "not-owner" });
    expect(producer).not.toHaveBeenCalled();
    expect(await reconcileLoopRuns(h)).toEqual([]);
  });

  it("terminalizes a run whose process died between steps", async () => {
    const beforePublish = deferred();
    const h = harness({
      stepBefore: async (step) => {
        if (step !== "publish") return;
        beforePublish.resolve();
        await never();
      },
    });
    void startAttachedLoop(h);
    await beforePublish.promise;
    const [running] = await h.loopRunStore.listRuns();
    crashAndExpireLease();

    expect(await reconcileLoopRuns(h)).toEqual(["interrupted"]);
    expect(await h.loopRunStore.getRun(running!.id)).toMatchObject({ status: "failed" });
    expect(h.executed).toEqual(["prepare"]);
  });

  it("terminalizes an owner that died before recording run.started", async () => {
    const appendingStart = deferred<string>();
    const base = new InMemoryRunEventStore();
    const eventStore: RunEventStore = {
      append: (runId, event) => {
        if (event.type !== "run.started") return base.append(runId, event);
        // The owner holds its lease but dies before run.started is durable.
        appendingStart.resolve(runId);
        return never();
      },
      listAfter: base.listAfter.bind(base),
      bounds: base.bounds.bind(base),
    };
    const h = harness({ eventStore });
    void startAttachedLoop(h);
    const runId = await appendingStart.promise;
    expect(await h.leaseStore.get(runId)).toMatchObject({ owner: "replica-a" });
    // A still-live owner is never mistaken for an orphan.
    await expect(reconcileInterruptedRun({
      runId,
      eventStore: h.eventStore,
      leaseStore: h.leaseStore,
      cancellationStore: h.cancellationStore,
    })).resolves.toBe("not-started");
    crashAndExpireLease();

    await expect(reconcileInterruptedRun({
      runId,
      eventStore: h.eventStore,
      leaseStore: h.leaseStore,
      cancellationStore: h.cancellationStore,
    })).resolves.toBe("interrupted");
    expect(await eventTypes(h, runId)).toEqual(["run.failed"]);
    expect(await h.loopRunStore.listRuns()).toEqual([]);
    expect(h.executed).toEqual([]);

    // Admission is fenced: a retry of the same run never executes.
    const producer = vi.fn();
    await expect(executeOwnedRun({
      runId,
      owner: "replica-b",
      token: "retry",
      journal: new RunEventJournal(base),
      leaseStore: h.leaseStore,
      producer,
    })).resolves.toEqual({ status: "not-owner" });
    expect(producer).not.toHaveBeenCalled();
  });

  it("converges exactly once under two concurrent reconcilers", async () => {
    const inPublish = deferred();
    const h = harness({
      tool: async (name) => {
        if (name !== "publish") return JSON.stringify({ ok: name });
        inPublish.resolve();
        return never();
      },
    });
    void startAttachedLoop(h);
    await inPublish.promise;
    const [running] = await h.loopRunStore.listRuns();
    const deliveryRunId = running!.metadata!.deliveryRunId as string;
    crashAndExpireLease();

    const [first, second] = await Promise.all([reconcileLoopRuns(h), reconcileLoopRuns(h)]);
    expect([...first!, ...second!].filter((result) => result === "interrupted")).toHaveLength(1);
    expect((await eventTypes(h, deliveryRunId)).filter((type) => type === "run.failed")).toHaveLength(1);
    expect(await h.loopRunStore.getRun(running!.id)).toMatchObject({ status: "failed" });
    expect(await h.leaseStore.get(deliveryRunId)).toBeNull();
    expect(await reconcileLoopRuns(h)).toEqual([]);
  });

  it("never touches a live run whose owner keeps renewing its lease", async () => {
    const inPublish = deferred();
    const finishPublish = deferred<string>();
    const h = harness({
      tool: async (name) => {
        if (name !== "publish") return JSON.stringify({ ok: name });
        inPublish.resolve();
        return finishPublish.promise;
      },
    });
    const response = startAttachedLoop(h);
    await inPublish.promise;
    const [running] = await h.loopRunStore.listRuns();
    const deliveryRunId = running!.metadata!.deliveryRunId as string;

    // Three full lease durations elapse while the heartbeat keeps renewing.
    for (let elapsed = 0; elapsed < 3 * LEASE_MS; elapsed += 10_000) {
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await reconcileLoopRuns(h)).toEqual(["active"]);
    }
    expect(await h.loopRunStore.getRun(running!.id)).toMatchObject({ status: "running" });
    expect(await eventTypes(h, deliveryRunId)).toEqual(["run.started"]);

    finishPublish.resolve(JSON.stringify({ ok: "publish" }));
    expect((await response).status).toBe(200);
    expect(await h.loopRunStore.getRun(running!.id)).toMatchObject({ status: "completed" });
    expect(await eventTypes(h, deliveryRunId)).toEqual(["run.started", "run.completed"]);
    expect(await reconcileLoopRuns(h)).toEqual([]);
    expect(h.executed).toEqual(["prepare", "publish"]);
  });

  it("fences a streaming attached run with the same lifecycle", async () => {
    const h = harness();
    const response = await startAttachedLoop(h, { stream: true });
    expect(await response.text()).toContain("[DONE]");
    const [run] = await h.loopRunStore.listRuns();
    expect(run?.status).toBe("completed");
    const deliveryRunId = run!.metadata!.deliveryRunId as string;
    expect(deliveryRunId).toBe(response.headers.get("x-polpo-run-id"));
    expect(await eventTypes(h, deliveryRunId)).toEqual(["run.started", "run.completed"]);
    expect(await h.leaseStore.get(deliveryRunId)).toBeNull();
  });

  it("correlates a resume with its own delivery run so the original outcome cannot fail it", async () => {
    const inPublish = deferred();
    const h = harness({
      tool: async (name) => {
        if (name !== "publish") return JSON.stringify({ ok: name });
        inPublish.resolve();
        return never();
      },
    });
    await h.loopRunStore.createRun({
      id: "looprun-approved",
      loop: { name: "release" },
      agentName: "publisher",
      context: {},
      metadata: { deliveryRunId: "chatcmpl-original" },
    });
    await h.loopRunStore.updateRun("looprun-approved", {
      status: "approval_approved",
      resume: {
        context: {},
        steps: [{ type: "tool", tool: "publish", next: "end" } as any],
        createdAt: T0.toISOString(),
      },
    });
    // The original attached delivery already ended when it suspended for approval.
    await h.eventStore.append("chatcmpl-original", { type: "run.started", data: {} });
    await h.eventStore.append("chatcmpl-original", { type: "run.completed", data: {} });

    void resumeProjectLoopRun({ deps: h.deps, runId: "looprun-approved" }).catch(() => {});
    await inPublish.promise;
    const resuming = await h.loopRunStore.getRun("looprun-approved");
    expect(resuming?.status).toBe("resuming");
    const resumeDeliveryRunId = resuming!.metadata!.deliveryRunId as string;
    expect(resumeDeliveryRunId).toMatch(/^looprun-approved-resume-/);

    expect(await reconcileLoopRuns(h)).toEqual(["active"]);
    expect(await h.loopRunStore.getRun("looprun-approved")).toMatchObject({ status: "resuming" });

    crashAndExpireLease();
    expect(await reconcileLoopRuns(h)).toEqual(["interrupted"]);
    expect(await h.loopRunStore.getRun("looprun-approved")).toMatchObject({ status: "failed" });
    expect(await eventTypes(h, "chatcmpl-original")).toEqual(["run.started", "run.completed"]);
  });
});
