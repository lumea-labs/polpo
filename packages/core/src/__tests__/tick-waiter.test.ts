import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TickWaiter } from "../tick-waiter.js";

describe("TickWaiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves after the interval when never woken", async () => {
    const waiter = new TickWaiter();
    let resolved = false;
    const p = waiter.wait(5000).then(() => { resolved = true; });

    await vi.advanceTimersByTimeAsync(4999);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(resolved).toBe(true);
  });

  it("resolves immediately on wake() during the wait", async () => {
    const waiter = new TickWaiter();
    let resolved = false;
    const p = waiter.wait(5000).then(() => { resolved = true; });

    await vi.advanceTimersByTimeAsync(100);
    waiter.wake();
    await p;
    expect(resolved).toBe(true);
  });

  it("a wake before the wait (in-flight tick) consumes the next wait", async () => {
    const waiter = new TickWaiter();
    waiter.wake(); // arrives while no wait is active

    let resolved = false;
    const p = waiter.wait(5000).then(() => { resolved = true; });
    await p; // resolves without advancing timers
    expect(resolved).toBe(true);

    // The pending wake is consumed: the following wait behaves normally
    let second = false;
    waiter.wait(5000).then(() => { second = true; });
    await vi.advanceTimersByTimeAsync(1000);
    expect(second).toBe(false);
    await vi.advanceTimersByTimeAsync(4000);
    expect(second).toBe(true);
  });

  it("multiple wakes coalesce into one", async () => {
    const waiter = new TickWaiter();
    waiter.wake();
    waiter.wake();
    waiter.wake();

    await waiter.wait(5000); // immediate (pending wake)

    // Only ONE pending wake was stored — next wait runs the full interval
    let second = false;
    waiter.wait(5000).then(() => { second = true; });
    await vi.advanceTimersByTimeAsync(4999);
    expect(second).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(second).toBe(true);
  });

  it("wake after a completed wait arms the next one (no lost signals)", async () => {
    const waiter = new TickWaiter();
    await vi.advanceTimersByTimeAsync(0);

    const first = waiter.wait(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await first;

    waiter.wake(); // between waits
    let resolved = false;
    waiter.wait(5000).then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(true);
  });
});
