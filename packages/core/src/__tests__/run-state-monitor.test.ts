import { afterEach, describe, expect, it, vi } from "vitest";
import { watchRunState } from "../run-state-monitor.js";
import type { RunRecord } from "../run-store.js";

afterEach(() => vi.useRealTimers());
const record = (status: RunRecord["status"]) => ({ id: "run-a", status } as RunRecord);
describe("durable Run state observation", () => {
  it.each(["killed", "failed", "completed"] as const)("stops the exact Run on persisted %s", async status => {
    vi.useFakeTimers();
    const getRun = vi.fn().mockResolvedValueOnce(record("running")).mockResolvedValue(record(status));
    const observer = watchRunState({ runId: "run-a", runStore: { getRun }, pollIntervalMs: 10 });
    await vi.advanceTimersByTimeAsync(10); expect(observer.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(10); expect(observer.signal.reason).toBe("run_terminal");
    await vi.advanceTimersByTimeAsync(1000);
    expect(getRun.mock.calls).toEqual([["run-a"], ["run-a"]]);
    expect(vi.getTimerCount()).toBe(0); observer.dispose();
  });

  it.each(["missing", "rejected", "hung"] as const)("fails closed on %s persistence without leaking storage errors", async mode => {
    vi.useFakeTimers();
    const getRun = vi.fn(() => mode === "hung" ? new Promise<RunRecord | undefined>(() => {})
      : mode === "rejected" ? Promise.reject(new Error("private driver information")) : Promise.resolve(undefined));
    const observer = watchRunState({ runId: "run-a", runStore: { getRun }, pollIntervalMs: 10, readTimeoutMs: 25 });
    await vi.advanceTimersByTimeAsync(35);
    expect(observer.signal.reason).toBe(mode === "missing" ? "run_missing" : "run_unavailable");
    await vi.advanceTimersByTimeAsync(1000); expect(getRun).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0); observer.dispose();
  });

  it("does not overlap slow reads or apply their late result after disposal", async () => {
    vi.useFakeTimers();
    let resolve!: (run: RunRecord) => void;
    const getRun = vi.fn(() => new Promise<RunRecord>(done => { resolve = done; }));
    const observer = watchRunState({ runId: "run-a", runStore: { getRun }, pollIntervalMs: 10, readTimeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(50); expect(getRun).toHaveBeenCalledTimes(1);
    observer.dispose(); resolve(record("killed"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(observer.signal.aborted).toBe(false); expect(getRun).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not reactivate after a timed-out read eventually returns running", async () => {
    vi.useFakeTimers();
    let resolve!: (run: RunRecord) => void;
    const getRun = vi.fn(() => new Promise<RunRecord>(done => { resolve = done; }));
    const observer = watchRunState({ runId: "run-a", runStore: { getRun }, pollIntervalMs: 10, readTimeoutMs: 20 });
    await vi.advanceTimersByTimeAsync(30); resolve(record("running"));
    await vi.advanceTimersByTimeAsync(100);
    expect(observer.signal.reason).toBe("run_unavailable"); expect(getRun).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0); observer.dispose();
  });
});
