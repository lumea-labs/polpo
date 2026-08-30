import { describe, expect, it, vi } from "vitest";
import {
  BrainIngestionError,
  BrainStoreConflictError,
  InMemoryBrainStore,
  createBrainIngestionJob,
  processNextBrainIngestionJob,
  type BrainFailure,
  type BrainScope,
} from "./index.js";

const scope: BrainScope = { kind: "project", subjectId: "project-1" };
const baseTime = "2026-08-30T08:00:00.000Z";

function queuedJob(input: {
  id?: string;
  maxAttempts?: number;
} = {}) {
  return createBrainIngestionJob({
    id: input.id ?? "job-1",
    scope,
    sourceId: "source-1",
    version: "v1",
    operation: "ingest",
    dedupeKey: "source-1:v1:ingest",
    maxAttempts: input.maxAttempts ?? 3,
  }, { now: () => baseTime });
}

describe("Brain ingestion worker", () => {
  it("returns idle without invoking the executor when no job is available", async () => {
    const store = new InMemoryBrainStore();
    const execute = vi.fn();

    await expect(processNextBrainIngestionJob({
      jobStore: store,
      scope,
      workerId: "worker-1",
      execute,
      now: () => baseTime,
    })).resolves.toEqual({ outcome: "idle" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("claims, executes, and completes a job exactly once", async () => {
    const store = new InMemoryBrainStore({ createId: () => "claim-1" });
    await store.enqueueJob(queuedJob());
    const execute = vi.fn().mockResolvedValue(undefined);

    await expect(processNextBrainIngestionJob({
      jobStore: store,
      scope,
      workerId: "worker-1",
      execute,
      now: () => baseTime,
    })).resolves.toEqual({
      outcome: "completed",
      jobId: "job-1",
      attempt: 1,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0].job).toMatchObject({
      id: "job-1",
      status: "processing",
      attempt: 1,
    });
    await expect(store.getJob({ scope, jobId: "job-1" })).resolves.toMatchObject({
      status: "completed",
      attempt: 1,
    });

    await expect(processNextBrainIngestionJob({
      jobStore: store,
      scope,
      workerId: "worker-1",
      execute,
      now: () => baseTime,
    })).resolves.toEqual({ outcome: "idle" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("schedules retryable failures without persisting raw provider errors", async () => {
    const store = new InMemoryBrainStore({ createId: () => "claim-1" });
    await store.enqueueJob(queuedJob());

    const result = await processNextBrainIngestionJob({
      jobStore: store,
      scope,
      workerId: "worker-1",
      execute: async () => {
        throw new Error("provider failed with secret=top-secret");
      },
      now: () => baseTime,
      retryDelayMs: () => 1_000,
    });

    expect(result).toEqual({
      outcome: "retry_scheduled",
      jobId: "job-1",
      attempt: 1,
      errorCode: "ingestion_failed",
    });
    const job = await store.getJob({ scope, jobId: "job-1" });
    expect(job).toMatchObject({
      status: "pending",
      availableAt: "2026-08-30T08:00:01.000Z",
    });
    expect(JSON.stringify(job)).not.toContain("top-secret");
  });

  it("persists a bounded classified failure and stops retrying at maxAttempts", async () => {
    let now = baseTime;
    let claim = 0;
    const store = new InMemoryBrainStore({ createId: () => `claim-${++claim}` });
    await store.enqueueJob(queuedJob({ maxAttempts: 2 }));
    const classifyFailure = (): BrainFailure => ({
      code: "provider_rate_limited",
      message: "Embedding provider unavailable",
      retryable: true,
    });

    const first = await processNextBrainIngestionJob({
      jobStore: store,
      scope,
      workerId: "worker-1",
      execute: async () => { throw new Error("429"); },
      classifyFailure,
      retryDelayMs: () => 1,
      now: () => now,
    });
    expect(first.outcome).toBe("retry_scheduled");

    now = "2026-08-30T08:00:00.001Z";
    const second = await processNextBrainIngestionJob({
      jobStore: store,
      scope,
      workerId: "worker-2",
      execute: async () => { throw new Error("429"); },
      classifyFailure,
      retryDelayMs: () => 1,
      now: () => now,
    });
    expect(second).toEqual({
      outcome: "failed",
      jobId: "job-1",
      attempt: 2,
      errorCode: "provider_rate_limited",
    });
    await expect(store.getJob({ scope, jobId: "job-1" })).resolves.toMatchObject({
      status: "failed",
      failure: {
        code: "provider_rate_limited",
        retryable: true,
      },
    });
  });

  it("classifies known ingestion and abort failures deterministically", async () => {
    const errors = [
      new BrainIngestionError("Unsupported source", "parser_not_found"),
      Object.assign(new Error("shutdown detail"), { name: "AbortError" }),
    ];
    const expected = ["parser_not_found", "worker_aborted"];

    for (let index = 0; index < errors.length; index += 1) {
      const store = new InMemoryBrainStore({ createId: () => `claim-${index}` });
      await store.enqueueJob(queuedJob({ id: `job-${index}` }));
      const result = await processNextBrainIngestionJob({
        jobStore: store,
        scope,
        workerId: "worker",
        execute: async () => { throw errors[index]; },
        retryDelayMs: () => 1,
        now: () => baseTime,
      });
      expect(result).toMatchObject({ errorCode: expected[index] });
    }
  });

  it("does not claim work when already aborted", async () => {
    const store = new InMemoryBrainStore();
    await store.enqueueJob(queuedJob());
    const controller = new AbortController();
    controller.abort(new DOMException("Stopped", "AbortError"));

    await expect(processNextBrainIngestionJob({
      jobStore: store,
      scope,
      workerId: "worker",
      execute: async () => undefined,
      signal: controller.signal,
      now: () => baseTime,
    })).rejects.toMatchObject({ name: "AbortError" });
    await expect(store.getJob({ scope, jobId: "job-1" })).resolves.toMatchObject({
      status: "pending",
      attempt: 0,
    });
  });

  it("requeues without executing when shutdown happens while claiming", async () => {
    const store = new InMemoryBrainStore({ createId: () => "claim-1" });
    await store.enqueueJob(queuedJob());
    const originalClaim = store.claimNextJob.bind(store);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(store, "claimNextJob").mockImplementation(async (input) => {
      await waiting;
      return originalClaim(input);
    });
    const controller = new AbortController();
    const execute = vi.fn();

    const pending = processNextBrainIngestionJob({
      jobStore: store,
      scope,
      workerId: "worker",
      execute,
      signal: controller.signal,
      retryDelayMs: () => 0,
      now: () => baseTime,
    });
    controller.abort(new DOMException("Shutdown", "AbortError"));
    release();

    await expect(pending).resolves.toMatchObject({
      outcome: "retry_scheduled",
      errorCode: "worker_aborted",
    });
    expect(execute).not.toHaveBeenCalled();
    await expect(store.getJob({ scope, jobId: "job-1" })).resolves.toMatchObject({
      status: "pending",
      attempt: 1,
    });
  });

  it("renews the lease while a long ingestion is executing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(baseTime));
    try {
      let claim = 0;
      const store = new InMemoryBrainStore({ createId: () => `claim-${++claim}` });
      await store.enqueueJob(queuedJob());

      const pending = processNextBrainIngestionJob({
        jobStore: store,
        scope,
        workerId: "worker-1",
        leaseMs: 300,
        heartbeatMs: 100,
        execute: async () => {
          await new Promise((resolve) => setTimeout(resolve, 750));
        },
        now: () => new Date(),
      });

      await vi.advanceTimersByTimeAsync(650);
      await expect(store.claimNextJob({
        scope,
        workerId: "worker-2",
        now: new Date().toISOString(),
        leaseMs: 300,
      })).resolves.toBeNull();
      await vi.advanceTimersByTimeAsync(200);
      await expect(pending).resolves.toMatchObject({ outcome: "completed" });
      await expect(store.getJob({ scope, jobId: "job-1" })).resolves.toMatchObject({
        status: "completed",
        attempt: 1,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns stale when another worker has already taken the lease", async () => {
    const store = new InMemoryBrainStore({
      createId: (() => {
        let id = 0;
        return () => `claim-${++id}`;
      })(),
    });
    await store.enqueueJob(queuedJob());
    let release!: () => void;
    const execute = new Promise<void>((resolve) => { release = resolve; });
    const first = processNextBrainIngestionJob({
      jobStore: store,
      scope,
      workerId: "worker-1",
      leaseMs: 100,
      heartbeatMs: 10_000,
      execute: async () => execute,
      now: () => baseTime,
    });
    await Promise.resolve();
    const second = await store.claimNextJob({
      scope,
      workerId: "worker-2",
      now: "2026-08-30T08:00:00.101Z",
      leaseMs: 100,
    });
    expect(second?.attempt).toBe(2);
    release();

    await expect(first).resolves.toEqual({
      outcome: "stale",
      jobId: "job-1",
      attempt: 1,
    });
    await expect(store.getJob({ scope, jobId: "job-1" })).resolves.toMatchObject({
      status: "processing",
      claimedBy: "worker-2",
      attempt: 2,
    });
  });

  it("rejects invalid static worker limits before claiming a job", async () => {
    const store = new InMemoryBrainStore();
    await store.enqueueJob(queuedJob());

    await expect(processNextBrainIngestionJob({
      jobStore: store,
      scope,
      workerId: "worker",
      leaseMs: 0,
      execute: async () => undefined,
      now: () => baseTime,
    })).rejects.toThrow("leaseMs");
  });

  it("falls back safely when host failure hooks throw or return malformed values", async () => {
    const cases = [
      {
        classifyFailure: () => { throw new Error("classifier secret"); },
        retryDelayMs: () => Number.NaN,
      },
      {
        classifyFailure: () => ({
          code: "INVALID CODE",
          message: "bad",
          retryable: true,
        }),
        retryDelayMs: () => { throw new Error("delay secret"); },
      },
    ];

    for (let index = 0; index < cases.length; index += 1) {
      const store = new InMemoryBrainStore({ createId: () => `claim-${index}` });
      await store.enqueueJob(queuedJob({ id: `job-${index}` }));
      const result = await processNextBrainIngestionJob({
        jobStore: store,
        scope,
        workerId: "worker",
        execute: async () => { throw new Error("provider secret"); },
        ...cases[index],
        now: () => baseTime,
      });
      expect(result).toMatchObject({
        outcome: "retry_scheduled",
        errorCode: "ingestion_failed",
      });
      const stored = await store.getJob({ scope, jobId: `job-${index}` });
      expect(stored).toMatchObject({
        status: "pending",
        availableAt: "2026-08-30T08:00:01.000Z",
      });
      expect(JSON.stringify(stored)).not.toContain("secret");
    }
  });

  it("does not hide unexpected claim-store conflicts", async () => {
    const store = new InMemoryBrainStore();
    await store.enqueueJob(queuedJob());
    const complete = vi.spyOn(store, "completeJob").mockRejectedValueOnce(
      new Error("database unavailable"),
    );

    await expect(processNextBrainIngestionJob({
      jobStore: store,
      scope,
      workerId: "worker",
      execute: async () => undefined,
      now: () => baseTime,
    })).rejects.toThrow("database unavailable");
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("treats only store claim conflicts as stale completion", async () => {
    const store = new InMemoryBrainStore();
    await store.enqueueJob(queuedJob());
    vi.spyOn(store, "completeJob").mockRejectedValueOnce(
      new BrainStoreConflictError("stale"),
    );

    await expect(processNextBrainIngestionJob({
      jobStore: store,
      scope,
      workerId: "worker",
      execute: async () => undefined,
      now: () => baseTime,
    })).resolves.toMatchObject({ outcome: "stale" });
  });
});
