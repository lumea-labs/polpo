/**
 * TickWaiter — interruptible delay for the supervisor loop.
 *
 * The orchestrator ticks on a fixed safety-net interval, but external
 * signals (task created, runner exited, approval resolved) can wake the
 * loop immediately so new work is picked up without waiting out the
 * interval. A wake that arrives while a tick is in flight (no wait
 * active) is remembered and consumes the NEXT wait, so no signal is
 * ever lost.
 */
export class TickWaiter {
  private pendingWake = false;
  private resolveWait: (() => void) | undefined;

  /** Wake the current wait immediately, or arm the next one. */
  wake(): void {
    if (this.resolveWait) {
      this.resolveWait();
    } else {
      this.pendingWake = true;
    }
  }

  /** Wait up to `ms`, resolving early on wake(). */
  wait(ms: number): Promise<void> {
    if (this.pendingWake) {
      this.pendingWake = false;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        this.resolveWait = undefined;
        resolve();
      };
      const timer = setTimeout(finish, ms);
      this.resolveWait = finish;
    });
  }
}
