import { describe, expect, it, vi } from "vitest";
import {
  InMemoryRunCancellationStore,
  InMemoryRunEventStore,
  InMemoryRunExecutionLeaseStore,
  RunEventCursorExpiredError,
} from "./run-delivery.js";
import { RunEventJournal } from "./run-delivery-follower.js";
import { executeOwnedRun } from "./run-delivery-owner.js";
import { ToolReceiptSettlementError } from "./tool-execution-receipts.js";

const lease = {
  owner: "worker-a",
  token: "token-a",
};

describe("executeOwnedRun", () => {
  it("does not admit the producer when a reconciler superseded its lease around run.started", async () => {
    const base = new InMemoryRunEventStore();
    const leases = new InMemoryRunExecutionLeaseStore();
    const events = {
      append: async (runId: string, event: Parameters<typeof base.append>[1]) => {
        const appended = await base.append(runId, event);
        if (event.type === "run.started") {
          // The owner stalled past its lease; a reconciler fenced it out.
          const stalled = await leases.get(runId);
          if (stalled) await leases.release(runId, stalled);
          await leases.claim(runId, {
            owner: "run-delivery-reconciler",
            token: "recovery",
            expiresAt: new Date(Date.now() + 10_000).toISOString(),
          });
        }
        return appended;
      },
      listAfter: base.listAfter.bind(base),
      bounds: base.bounds.bind(base),
    };
    const producer = vi.fn();

    const result = await executeOwnedRun({
      runId: "run-superseded",
      ...lease,
      journal: new RunEventJournal(events),
      leaseStore: leases,
      producer,
    });

    expect(result).toEqual({ status: "lost-lease" });
    expect(producer).not.toHaveBeenCalled();
    await expect(leases.get("run-superseded")).resolves.toMatchObject({
      owner: "run-delivery-reconciler",
    });
  });

  it("claims one owner, journals lifecycle events, and releases its lease", async () => {
    const events = new InMemoryRunEventStore();
    const leases = new InMemoryRunExecutionLeaseStore();
    const journal = new RunEventJournal(events);
    const result = await executeOwnedRun({
      runId: "run-a",
      ...lease,
      journal,
      leaseStore: leases,
      producer: async ({ journal: producerJournal }) => {
        await producerJournal.append("run-a", {
          type: "output.text.delta",
          data: { text: "hello" },
        });
      },
    });

    expect(result).toEqual({ status: "completed" });
    expect((await events.listAfter("run-a")).events.map((event) => event.type)).toEqual([
      "run.started",
      "output.text.delta",
      "run.completed",
    ]);
    expect(await leases.get("run-a")).toBeNull();
  });

  it("does not execute a second producer while another lease is active", async () => {
    const events = new InMemoryRunEventStore();
    const leases = new InMemoryRunExecutionLeaseStore();
    const now = new Date();
    await leases.claim("run-a", {
      owner: "worker-other",
      token: "token-other",
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    });
    let called = false;

    const result = await executeOwnedRun({
      runId: "run-a",
      ...lease,
      journal: new RunEventJournal(events),
      leaseStore: leases,
      producer: async () => { called = true; },
    });

    expect(result).toEqual({ status: "not-owner" });
    expect(called).toBe(false);
    expect((await events.listAfter("run-a")).events).toEqual([]);
  });

  it("rechecks terminal history after acquiring a lease and never executes a replayed producer", async () => {
    const events = new InMemoryRunEventStore();
    const leases = new InMemoryRunExecutionLeaseStore();
    const journal = new RunEventJournal(events);
    await journal.append("run-terminal", {
      id: "run.started",
      type: "run.started",
      data: {},
    });
    await journal.append("run-terminal", {
      id: "run.completed",
      type: "run.completed",
      data: {},
    });
    const original = (await events.listAfter("run-terminal")).events;
    let producerCalls = 0;

    const result = await executeOwnedRun({
      runId: "run-terminal",
      ...lease,
      journal,
      leaseStore: leases,
      producer: async () => { producerCalls += 1; },
    });

    expect(result).toEqual({ status: "not-owner" });
    expect(producerCalls).toBe(0);
    expect((await events.listAfter("run-terminal")).events).toEqual(original);
    expect(await leases.get("run-terminal")).toBeNull();
  });

  it("does not append after an earlier terminal event even when legacy history is polluted", async () => {
    const events = new InMemoryRunEventStore();
    const leases = new InMemoryRunExecutionLeaseStore();
    const journal = new RunEventJournal(events);
    await journal.append("run-polluted", {
      id: "run.started",
      type: "run.started",
      data: {},
    });
    await journal.append("run-polluted", {
      id: "run.completed",
      type: "run.completed",
      data: {},
    });
    await journal.append("run-polluted", {
      type: "output.text.delta",
      data: { text: "legacy late write" },
    });
    const original = (await events.listAfter("run-polluted")).events;
    let producerCalls = 0;

    const result = await executeOwnedRun({
      runId: "run-polluted",
      ...lease,
      journal,
      leaseStore: leases,
      producer: async () => { producerCalls += 1; },
    });

    expect(result).toEqual({ status: "not-owner" });
    expect(producerCalls).toBe(0);
    expect((await events.listAfter("run-polluted")).events).toEqual(original);
  });

  it("terminalizes a started ownerless run instead of reexecuting its producer", async () => {
    const events = new InMemoryRunEventStore();
    const leases = new InMemoryRunExecutionLeaseStore();
    const journal = new RunEventJournal(events);
    await journal.append("run-ownerless", {
      id: "run.started",
      type: "run.started",
      data: {},
    });
    let producerCalls = 0;

    const result = await executeOwnedRun({
      runId: "run-ownerless",
      ...lease,
      journal,
      leaseStore: leases,
      producer: async () => { producerCalls += 1; },
    });

    expect(result).toEqual({
      status: "failed",
      error: "Run execution was interrupted before completion",
    });
    expect(producerCalls).toBe(0);
    expect((await events.listAfter("run-ownerless")).events).toMatchObject([
      { type: "run.started" },
      {
        id: "run.failed:execution-interrupted",
        type: "run.failed",
        data: {
          code: "run_execution_interrupted",
          message: "Run execution was interrupted before completion",
          retryable: true,
        },
      },
    ]);
    expect(await leases.get("run-ownerless")).toBeNull();
  });

  it("fences a delayed second claimant after the first claimant completes", async () => {
    const events = new InMemoryRunEventStore();
    const baseLeases = new InMemoryRunExecutionLeaseStore();
    let claimCalls = 0;
    let secondClaimEntered!: () => void;
    const secondClaimWaiting = new Promise<void>((resolve) => { secondClaimEntered = resolve; });
    let releaseSecondClaim!: () => void;
    const secondClaimReleased = new Promise<void>((resolve) => { releaseSecondClaim = resolve; });
    const leaseStore = {
      get: baseLeases.get.bind(baseLeases),
      renew: baseLeases.renew.bind(baseLeases),
      release: baseLeases.release.bind(baseLeases),
      claim: async (...args: Parameters<typeof baseLeases.claim>) => {
        claimCalls += 1;
        if (claimCalls === 2) {
          secondClaimEntered();
          await secondClaimReleased;
        }
        return baseLeases.claim(...args);
      },
    };
    let finishFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => { finishFirst = resolve; });
    let producerCalls = 0;
    const first = executeOwnedRun({
      runId: "run-concurrent-replay",
      owner: "worker-a",
      token: "token-a",
      journal: new RunEventJournal(events),
      leaseStore,
      producer: async () => {
        producerCalls += 1;
        await firstMayFinish;
      },
    });
    const second = executeOwnedRun({
      runId: "run-concurrent-replay",
      owner: "worker-b",
      token: "token-b",
      journal: new RunEventJournal(events),
      leaseStore,
      producer: async () => { producerCalls += 1; },
    });

    await secondClaimWaiting;
    finishFirst();
    await expect(first).resolves.toEqual({ status: "completed" });
    releaseSecondClaim();
    await expect(second).resolves.toEqual({ status: "not-owner" });

    expect(producerCalls).toBe(1);
    expect((await events.listAfter("run-concurrent-replay")).events.map(
      (event) => event.type,
    )).toEqual(["run.started", "run.completed"]);
  });

  it("fails closed when run.started committed but its acknowledgement was lost", async () => {
    const persistedEvents = new InMemoryRunEventStore();
    let loseStartedAcknowledgement = true;
    const events = {
      bounds: persistedEvents.bounds.bind(persistedEvents),
      listAfter: persistedEvents.listAfter.bind(persistedEvents),
      appendMany: persistedEvents.appendMany.bind(persistedEvents),
      append: async (...args: Parameters<typeof persistedEvents.append>) => {
        const event = await persistedEvents.append(...args);
        if (event.type === "run.started" && loseStartedAcknowledgement) {
          loseStartedAcknowledgement = false;
          throw new Error("run.started acknowledgement lost");
        }
        return event;
      },
    };
    const leases = new InMemoryRunExecutionLeaseStore();
    let producerCalls = 0;

    await expect(executeOwnedRun({
      runId: "run-started-ack-lost",
      ...lease,
      journal: new RunEventJournal(events),
      leaseStore: leases,
      producer: async () => { producerCalls += 1; },
    })).rejects.toThrow("run.started acknowledgement lost");
    expect(await leases.get("run-started-ack-lost")).toBeNull();

    await expect(executeOwnedRun({
      runId: "run-started-ack-lost",
      owner: "worker-b",
      token: "token-b",
      journal: new RunEventJournal(events),
      leaseStore: leases,
      producer: async () => { producerCalls += 1; },
    })).resolves.toEqual({
      status: "failed",
      error: "Run execution was interrupted before completion",
    });

    expect(producerCalls).toBe(0);
    expect((await persistedEvents.listAfter("run-started-ack-lost")).events.map(
      (event) => event.type,
    )).toEqual(["run.started", "run.failed"]);
  });

  it("fails closed when retained history no longer proves whether execution started", async () => {
    const retained = new InMemoryRunEventStore();
    await retained.append("run-retained-suffix", {
      type: "run.accepted",
      data: {},
    });
    const eventStore = {
      append: retained.append.bind(retained),
      appendMany: retained.appendMany.bind(retained),
      listAfter: retained.listAfter.bind(retained),
      bounds: async () => ({ firstCursor: "5", lastCursor: "5", count: 1 }),
    };
    const leases = new InMemoryRunExecutionLeaseStore();
    const producer = vi.fn(async () => undefined);

    await expect(executeOwnedRun({
      runId: "run-retained-suffix",
      ...lease,
      journal: new RunEventJournal(eventStore),
      leaseStore: leases,
      producer,
    })).rejects.toBeInstanceOf(RunEventCursorExpiredError);

    expect(producer).not.toHaveBeenCalled();
    expect((await retained.listAfter("run-retained-suffix")).events).toHaveLength(1);
    expect(await leases.get("run-retained-suffix")).toBeNull();
  });

  it("records a safe failure event and still releases the lease", async () => {
    const events = new InMemoryRunEventStore();
    const leases = new InMemoryRunExecutionLeaseStore();
    const result = await executeOwnedRun({
      runId: "run-a",
      ...lease,
      journal: new RunEventJournal(events),
      leaseStore: leases,
      producer: async () => { throw new Error("provider unavailable"); },
    });

    expect(result).toEqual({ status: "failed", error: "provider unavailable" });
    const persisted = (await events.listAfter("run-a")).events;
    expect(persisted.map((event) => event.type)).toEqual(["run.started", "run.failed"]);
    expect(persisted[1]?.data).toEqual({ message: "provider unavailable" });
    expect(await leases.get("run-a")).toBeNull();
  });

  it("records structured receipt diagnostics without SQL, parameters, or tool output", async () => {
    const events = new InMemoryRunEventStore();
    const leases = new InMemoryRunExecutionLeaseStore();
    const databaseCause = Object.assign(
      new Error("UPDATE tool_execution_receipts params: secret tool result", {
        cause: Object.assign(new Error("serialization failure"), { code: "40001" }),
      }),
      { query: "UPDATE tool_execution_receipts", params: ["secret tool result"] },
    );
    const result = await executeOwnedRun({
      runId: "run-receipt-failure",
      ...lease,
      journal: new RunEventJournal(events),
      leaseStore: leases,
      producer: async () => { throw new ToolReceiptSettlementError(3, databaseCause); },
    });

    expect(result).toEqual({ status: "failed", error: "Tool receipt settlement failed" });
    const failure = (await events.listAfter("run-receipt-failure")).events.at(-1);
    expect(failure).toMatchObject({
      type: "run.failed",
      data: {
        message: "Tool receipt settlement failed",
        code: "tool_receipt_settlement_failed",
        causeCode: "40001",
        errorClass: "ToolReceiptSettlementError",
        operation: "tool_receipt_settle",
        attempts: 3,
      },
    });
    expect(JSON.stringify(failure)).not.toContain("secret tool result");
    expect(JSON.stringify(failure)).not.toContain("UPDATE tool_execution_receipts");
  });

  it("turns an explicit cancellation request into producer abort and run.cancelled", async () => {
    const events = new InMemoryRunEventStore();
    const leases = new InMemoryRunExecutionLeaseStore();
    const cancellations = new InMemoryRunCancellationStore();
    let producerStarted!: () => void;
    const started = new Promise<void>((resolve) => { producerStarted = resolve; });
    const execution = executeOwnedRun({
      runId: "run-a",
      ...lease,
      journal: new RunEventJournal(events),
      leaseStore: leases,
      cancellationStore: cancellations,
      heartbeatIntervalMs: 5,
      leaseDurationMs: 50,
      producer: async ({ signal }) => {
        producerStarted();
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      },
    });
    await started;

    await cancellations.request("run-a", {
      requestedAt: new Date().toISOString(),
      reason: "user_request",
    });
    expect(await execution).toEqual({ status: "cancelled" });
    expect((await events.listAfter("run-a")).events.map((event) => event.type)).toEqual([
      "run.started",
      "run.cancelling",
      "run.cancelled",
    ]);
    expect(await cancellations.get("run-a")).toBeNull();
  });

  it("contains a heartbeat transport failure, aborts the producer and writes one retryable terminal", async () => {
    const events = new InMemoryRunEventStore();
    const baseLeases = new InMemoryRunExecutionLeaseStore();
    let renewCount = 0;
    const release = vi.fn(baseLeases.release.bind(baseLeases));
    const leaseStore = {
      claim: baseLeases.claim.bind(baseLeases),
      get: baseLeases.get.bind(baseLeases),
      release,
      renew: async (...args: Parameters<typeof baseLeases.renew>) => {
        renewCount += 1;
        if (renewCount === 2) {
          throw new Error("secret postgres heartbeat diagnostics");
        }
        return baseLeases.renew(...args);
      },
    };
    let abortReason: unknown;

    const result = await executeOwnedRun({
      runId: "run-heartbeat-failure",
      ...lease,
      journal: new RunEventJournal(events),
      leaseStore,
      heartbeatIntervalMs: 5,
      leaseDurationMs: 50,
      producer: async ({ signal }) => {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => {
          abortReason = signal.reason;
          resolve();
        }, { once: true }));
      },
    });

    expect(result).toEqual({
      status: "failed",
      error: "Run execution heartbeat failed",
    });
    expect(abortReason).toBe("run_heartbeat_failed");
    const history = (await events.listAfter("run-heartbeat-failure")).events;
    expect(history.map((event) => event.type)).toEqual(["run.started", "run.failed"]);
    expect(history.at(-1)).toMatchObject({
      data: {
        code: "run_heartbeat_failed",
        message: "Run execution heartbeat failed",
        retryable: true,
      },
    });
    expect(JSON.stringify(history)).not.toContain("secret postgres heartbeat diagnostics");
    expect(release).toHaveBeenCalledOnce();
    expect(await baseLeases.get("run-heartbeat-failure")).toBeNull();
  });

  it("fails closed when cancellation polling throws during a heartbeat", async () => {
    const events = new InMemoryRunEventStore();
    const leases = new InMemoryRunExecutionLeaseStore();
    const baseCancellations = new InMemoryRunCancellationStore();
    let pollCount = 0;
    const cancellations = {
      request: baseCancellations.request.bind(baseCancellations),
      clear: baseCancellations.clear.bind(baseCancellations),
      get: async (...args: Parameters<typeof baseCancellations.get>) => {
        pollCount += 1;
        if (pollCount === 2) throw new Error("cancellation backend unavailable");
        return baseCancellations.get(...args);
      },
    };

    const result = await executeOwnedRun({
      runId: "run-cancellation-poll-failure",
      ...lease,
      journal: new RunEventJournal(events),
      leaseStore: leases,
      cancellationStore: cancellations,
      heartbeatIntervalMs: 5,
      leaseDurationMs: 50,
      producer: async ({ signal }) => {
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true })
        );
      },
    });

    expect(result).toEqual({
      status: "failed",
      error: "Run execution heartbeat failed",
    });
    expect((await events.listAfter("run-cancellation-poll-failure")).events)
      .toMatchObject([
        { type: "run.started" },
        { type: "run.failed", data: { code: "run_heartbeat_failed", retryable: true } },
      ]);
    expect(await leases.get("run-cancellation-poll-failure")).toBeNull();
  });

  it("drains an in-flight heartbeat failure before choosing run.completed", async () => {
    const events = new InMemoryRunEventStore();
    const leases = new InMemoryRunExecutionLeaseStore();
    const baseCancellations = new InMemoryRunCancellationStore();
    let pollCount = 0;
    let heartbeatPollStarted!: () => void;
    const heartbeatPoll = new Promise<void>((resolve) => { heartbeatPollStarted = resolve; });
    let rejectHeartbeatPoll!: (reason?: unknown) => void;
    const pendingHeartbeatPoll = new Promise<null>((_resolve, reject) => {
      rejectHeartbeatPoll = reject;
    });
    const cancellations = {
      request: baseCancellations.request.bind(baseCancellations),
      clear: baseCancellations.clear.bind(baseCancellations),
      get: async (...args: Parameters<typeof baseCancellations.get>) => {
        pollCount += 1;
        if (pollCount === 2) {
          heartbeatPollStarted();
          return pendingHeartbeatPoll;
        }
        return baseCancellations.get(...args);
      },
    };
    let finishProducer!: () => void;
    const producerMayFinish = new Promise<void>((resolve) => { finishProducer = resolve; });

    const execution = executeOwnedRun({
      runId: "run-heartbeat-finalization-race",
      ...lease,
      journal: new RunEventJournal(events),
      leaseStore: leases,
      cancellationStore: cancellations,
      heartbeatIntervalMs: 5,
      leaseDurationMs: 50,
      producer: async () => producerMayFinish,
    });

    await heartbeatPoll;
    finishProducer();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    rejectHeartbeatPoll(new Error("late private database failure"));

    await expect(execution).resolves.toEqual({
      status: "failed",
      error: "Run execution heartbeat failed",
    });
    const history = (await events.listAfter("run-heartbeat-finalization-race")).events;
    expect(history.map((event) => event.type)).toEqual(["run.started", "run.failed"]);
    expect(JSON.stringify(history)).not.toContain("late private database failure");
  });

  it("does not terminalize a heartbeat failure after ownership moved", async () => {
    const events = new InMemoryRunEventStore();
    const baseLeases = new InMemoryRunExecutionLeaseStore();
    let renewCount = 0;
    const leaseStore = {
      claim: baseLeases.claim.bind(baseLeases),
      get: baseLeases.get.bind(baseLeases),
      release: baseLeases.release.bind(baseLeases),
      renew: async (...args: Parameters<typeof baseLeases.renew>) => {
        renewCount += 1;
        if (renewCount === 2) {
          const current = await baseLeases.get(args[0]);
          if (current) await baseLeases.release(args[0], current);
          await baseLeases.claim(args[0], {
            owner: "replacement-worker",
            token: "replacement-token",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          });
          throw new Error("heartbeat acknowledgement lost during owner replacement");
        }
        return baseLeases.renew(...args);
      },
    };

    const result = await executeOwnedRun({
      runId: "run-heartbeat-owner-replaced",
      ...lease,
      journal: new RunEventJournal(events),
      leaseStore,
      heartbeatIntervalMs: 5,
      leaseDurationMs: 50,
      producer: async ({ signal }) => {
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true })
        );
      },
    });

    expect(result).toEqual({ status: "lost-lease" });
    expect((await events.listAfter("run-heartbeat-owner-replaced")).events.map(
      (event) => event.type,
    )).toEqual(["run.started"]);
    await expect(baseLeases.get("run-heartbeat-owner-replaced")).resolves.toMatchObject({
      owner: "replacement-worker",
      token: "replacement-token",
    });
  });

  it("does not turn a durable completion into a request failure when lease release fails", async () => {
    const events = new InMemoryRunEventStore();
    const baseLeases = new InMemoryRunExecutionLeaseStore();
    const leaseStore = {
      claim: baseLeases.claim.bind(baseLeases),
      get: baseLeases.get.bind(baseLeases),
      renew: baseLeases.renew.bind(baseLeases),
      release: vi.fn(async () => {
        throw new Error("release acknowledgement lost");
      }),
    };

    await expect(executeOwnedRun({
      runId: "run-release-ack-lost",
      ...lease,
      journal: new RunEventJournal(events),
      leaseStore,
      producer: async () => undefined,
    })).resolves.toEqual({ status: "completed" });
    expect((await events.listAfter("run-release-ack-lost")).events.map(
      (event) => event.type,
    )).toEqual(["run.started", "run.completed"]);
    expect(leaseStore.release).toHaveBeenCalledOnce();
  });

  it("does not terminalize after losing its lease to another owner", async () => {
    let renewCount = 0;
    const baseLeases = new InMemoryRunExecutionLeaseStore();
    const leaseStore = {
      claim: baseLeases.claim.bind(baseLeases),
      get: baseLeases.get.bind(baseLeases),
      release: baseLeases.release.bind(baseLeases),
      renew: async (...args: Parameters<typeof baseLeases.renew>) => {
        renewCount += 1;
        if (renewCount === 2) return false;
        return baseLeases.renew(...args);
      },
    };
    const events = new InMemoryRunEventStore();
    const result = await executeOwnedRun({
      runId: "run-a",
      ...lease,
      journal: new RunEventJournal(events),
      leaseStore,
      heartbeatIntervalMs: 5,
      leaseDurationMs: 50,
      producer: async ({ signal }) => {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      },
    });

    expect(result).toEqual({ status: "lost-lease" });
    expect((await events.listAfter("run-a")).events.map((event) => event.type)).toEqual([
      "run.started",
    ]);
  });

  it("revalidates lease ownership before writing a terminal event", async () => {
    const baseLeases = new InMemoryRunExecutionLeaseStore();
    let renewCount = 0;
    const leaseStore = {
      claim: baseLeases.claim.bind(baseLeases),
      get: baseLeases.get.bind(baseLeases),
      release: baseLeases.release.bind(baseLeases),
      renew: async (...args: Parameters<typeof baseLeases.renew>) => {
        renewCount += 1;
        if (renewCount === 2) return false;
        return baseLeases.renew(...args);
      },
    };
    const events = new InMemoryRunEventStore();

    const result = await executeOwnedRun({
      runId: "run-finalize-race",
      ...lease,
      journal: new RunEventJournal(events),
      leaseStore,
      heartbeatIntervalMs: 20_000,
      leaseDurationMs: 30_000,
      producer: async () => undefined,
    });

    expect(result).toEqual({ status: "lost-lease" });
    expect((await events.listAfter("run-finalize-race")).events.map(
      (event) => event.type,
    )).toEqual(["run.started"]);
  });
});
