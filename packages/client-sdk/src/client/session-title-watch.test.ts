import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionTitleWatchRegistry } from "./session-title-watch.js";

afterEach(() => vi.useRealTimers());
describe("scoped Session title readback", () => {
  it("deduplicates consumers and stops after a late generated title", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValueOnce({ id: "s", titleRevision: 0, titleGenerationStatus: "pending" }).mockResolvedValue({ id: "s", titleRevision: 1, titleGenerationStatus: "completed" });
    const registry = new SessionTitleWatchRegistry(read); const a = vi.fn(), b = vi.fn();
    registry.watch("s", a); registry.watch("s", b);
    await vi.advanceTimersByTimeAsync(1000); expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000); expect(a).toHaveBeenCalledTimes(2); expect(b).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000); expect(read).toHaveBeenCalledTimes(2);
  });
  it("aborts on scope disposal and ignores late read results", async () => {
    vi.useFakeTimers(); let finish!: (value: any) => void;
    const read = vi.fn((_id: string, _signal: AbortSignal) => new Promise<any>(resolve => { finish = resolve; }));
    const registry = new SessionTitleWatchRegistry(read); const update = vi.fn(); const stop = registry.watch("s", update);
    await vi.advanceTimersByTimeAsync(1000); stop();
    expect(read.mock.calls[0]![1].aborted).toBe(true);
    finish({ id: "s", titleRevision: 1, titleGenerationStatus: "completed" });
    await vi.advanceTimersByTimeAsync(1000); expect(update).not.toHaveBeenCalled();
  });
  it("bounds retries and stops immediately on old-server or inaccessible Session responses", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockRejectedValue(new Error("offline"));
    const registry = new SessionTitleWatchRegistry(read); registry.watch("s", () => {});
    await vi.advanceTimersByTimeAsync(70_000); const count = read.mock.calls.length;
    expect(count).toBeLessThan(15); await vi.advanceTimersByTimeAsync(70_000); expect(read).toHaveBeenCalledTimes(count);
    read.mockRejectedValue({ status: 404 }); registry.watch("missing", () => {});
    await vi.advanceTimersByTimeAsync(70_000); expect(read).toHaveBeenCalledTimes(count + 1);
  });
});
