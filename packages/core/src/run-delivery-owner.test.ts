import { describe, expect, it } from "vitest";
import {
  InMemoryRunCancellationStore,
  InMemoryRunEventStore,
  InMemoryRunExecutionLeaseStore,
} from "./run-delivery.js";
import { RunEventJournal } from "./run-delivery-follower.js";
import { executeOwnedRun } from "./run-delivery-owner.js";

const lease = {
  owner: "worker-a",
  token: "token-a",
};

describe("executeOwnedRun", () => {
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

  it("does not terminalize after losing its lease to another owner", async () => {
    let renewCount = 0;
    const baseLeases = new InMemoryRunExecutionLeaseStore();
    const leaseStore = {
      claim: baseLeases.claim.bind(baseLeases),
      get: baseLeases.get.bind(baseLeases),
      release: baseLeases.release.bind(baseLeases),
      renew: async (...args: Parameters<typeof baseLeases.renew>) => {
        renewCount += 1;
        if (renewCount === 1) return false;
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
    const leaseStore = {
      claim: baseLeases.claim.bind(baseLeases),
      get: baseLeases.get.bind(baseLeases),
      release: baseLeases.release.bind(baseLeases),
      renew: async () => false,
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
