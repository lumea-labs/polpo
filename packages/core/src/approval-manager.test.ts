import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalManager } from "./approval-manager.js";
import { HookRegistry } from "./hooks.js";
import type { ApprovalStore } from "./approval-store.js";
import type { ApprovalRequest } from "./types.js";
import type { OrchestratorContext } from "./orchestrator-context.js";

const managers: ApprovalManager[] = [];
afterEach(() => {
  managers.splice(0).forEach(manager => manager.dispose());
  vi.useRealTimers(); vi.restoreAllMocks();
});
async function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-11T12:00:00.000Z"));
  let current: ApprovalRequest = { id: "approval", gateId: "gate", gateName: "Review", status: "pending",
    payload: { mission: "Review" }, requestedAt: new Date().toISOString() };
  const store = {
    get: vi.fn(async () => structuredClone(current)),
    list: vi.fn(async () => [structuredClone(current)]),
    listByTask: vi.fn(async () => []), delete: vi.fn(async () => false),
    upsert: vi.fn(async (request: ApprovalRequest) => { current = structuredClone(request); }),
  } satisfies ApprovalStore;
  const emit = vi.fn(), transition = vi.fn();
  const ctx = { emitter: { emit }, taskStore: { transition }, hooks: new HookRegistry(),
    config: { settings: { approvalGates: [{ id: "gate", name: "Review", handler: "human",
      hook: "mission:execute", timeoutMs: 10, timeoutAction: "approve" }] } },
  } as unknown as OrchestratorContext;
  const manager = new ApprovalManager(ctx, store); managers.push(manager);
  await manager.init();
  return { store, emit, transition, manager, current: () => current };
}

describe("approval timeout persistence failures", () => {
  it("retains pending work on a read failure, logs safely, and retries after a delay", async () => {
    const f = await fixture();
    f.store.get.mockRejectedValueOnce(new Error("private database credential"));
    await vi.advanceTimersByTimeAsync(10);
    expect(f.current().status).toBe("pending");
    expect(f.store.upsert).not.toHaveBeenCalled(); expect(f.transition).not.toHaveBeenCalled();
    expect(f.emit).toHaveBeenCalledWith("log", expect.objectContaining({ level: "error", message: expect.stringContaining("Approval timeout") }));
    expect(JSON.stringify(f.emit.mock.calls)).not.toContain("private database credential");
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(f.store.get).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.current().status).toBe("timeout");
    expect(f.store.upsert).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not emit timeout or resume work when saving the resolution fails", async () => {
    const f = await fixture();
    f.store.upsert.mockRejectedValueOnce(new Error("disk unavailable"));
    await vi.advanceTimersByTimeAsync(10);
    expect(f.current().status).toBe("pending");
    expect(f.emit).not.toHaveBeenCalledWith("approval:timeout", expect.anything());
    expect(f.transition).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.current().status).toBe("timeout");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("backs off repeated failures and cancels retries when disposed", async () => {
    const f = await fixture(); f.store.get.mockRejectedValue(new Error("unavailable"));
    await vi.advanceTimersByTimeAsync(10);
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      const calls = f.store.get.mock.calls.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(f.store.get).toHaveBeenCalledTimes(calls);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.store.get).toHaveBeenCalledTimes(calls + 1);
      expect(vi.getTimerCount()).toBe(1);
    }
    f.manager.dispose(); expect(vi.getTimerCount()).toBe(0);
    const calls = f.store.get.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.store.get).toHaveBeenCalledTimes(calls);
  });

  it.each([false, true])("does not resolve or retry an in-flight read after disposal (failure=%s)", async fails => {
    const f = await fixture();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    f.store.get.mockImplementationOnce(async () => {
      await pending;
      if (fails) throw new Error("unavailable");
      return structuredClone(f.current());
    });
    vi.advanceTimersByTime(10);
    expect(f.store.get).toHaveBeenCalledOnce();
    f.manager.dispose(); release();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.current().status).toBe("pending");
    expect(f.store.upsert).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it("stops retrying if another resolver has already settled the request", async () => {
    const f = await fixture(); f.store.get.mockRejectedValueOnce(new Error("unavailable"));
    await vi.advanceTimersByTimeAsync(10);
    await f.store.upsert({ ...f.current(), status: "approved" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.current().status).toBe("approved");
    expect(f.store.upsert).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps persistence retries bounded even when a log listener throws", async () => {
    const f = await fixture(); f.store.get.mockRejectedValue(new Error("unavailable"));
    f.emit.mockImplementation(() => { throw new Error("listener failed"); });
    await vi.advanceTimersByTimeAsync(10);
    expect(vi.getTimerCount()).toBe(1); expect(f.current().status).toBe("pending");
  });
});
