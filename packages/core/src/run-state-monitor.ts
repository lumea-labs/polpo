import type { RunStore } from "./run-store.js";

export type RunStateStopReason = "run_terminal" | "run_missing" | "run_unavailable";

/** Observe the durable authority for one Run. This signal requests local owner
 * shutdown; observing a terminal row does not prove a host has stopped. */
export function watchRunState(input: {
  runId: string;
  runStore: Pick<RunStore, "getRun">;
  pollIntervalMs?: number;
  readTimeoutMs?: number;
}): { signal: AbortSignal; dispose(): void } {
  const interval = input.pollIntervalMs ?? 1000;
  const readTimeout = input.readTimeoutMs ?? 5000;
  for (const duration of [interval, readTimeout]) {
    if (!Number.isSafeInteger(duration) || duration < 1 || duration > 30_000) {
      throw new Error("Run state observation requires a bounded positive duration");
    }
  }
  const controller = new AbortController();
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const active = () => !disposed && !controller.signal.aborted;
  const stop = (reason: RunStateStopReason) => {
    if (active()) controller.abort(reason);
  };
  const unref = (handle: ReturnType<typeof setTimeout>) => {
    if (typeof handle === "object" && "unref" in handle) handle.unref();
  };
  const check = async () => {
    if (!active()) return;
    deadline = setTimeout(() => stop("run_unavailable"), readTimeout);
    unref(deadline);
    try {
      const run = await input.runStore.getRun(input.runId);
      if (!active()) return;
      if (!run) stop("run_missing");
      else if (run.status !== "running") stop("run_terminal");
    } catch {
      stop("run_unavailable");
    } finally {
      clearTimeout(deadline);
      deadline = undefined;
      // Schedule only after this read settles: slow persistence never creates
      // overlapping lookups or an unbounded queue of cancellation checks.
      if (active()) {
        timer = setTimeout(check, interval);
        unref(timer);
      }
    }
  };
  timer = setTimeout(check, interval);
  unref(timer);
  return {
    signal: controller.signal,
    dispose() {
      disposed = true;
      clearTimeout(timer);
      clearTimeout(deadline);
    },
  };
}
