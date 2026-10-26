import type { ChatSession } from "./types.js";

interface Watch {
  listeners: Set<(session: ChatSession) => void>;
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  deadline: ReturnType<typeof setTimeout>;
  attempt: number;
  reading: boolean;
  revision: number;
}

/** One bounded, scoped metadata readback per client/Session, shared by React consumers. */
export class SessionTitleWatchRegistry {
  private readonly watches = new Map<string, Watch>();
  constructor(private readonly read: (id: string, signal: AbortSignal) => Promise<ChatSession>) {}
  watch(id: string, listener: (session: ChatSession) => void): () => void {
    let watch = this.watches.get(id);
    if (!watch) {
      const controller = new AbortController();
      watch = { listeners: new Set(), controller, attempt: 0, reading: false, revision: -1,
        deadline: setTimeout(() => this.stop(id), 60_000) };
      this.watches.set(id, watch);
      this.schedule(id, watch, 1000);
      if (this.watches.size === 1 && typeof window !== "undefined") { window.addEventListener("focus", this.refresh); window.addEventListener("online", this.refresh); }
    }
    watch.listeners.add(listener);
    return () => { watch!.listeners.delete(listener); if (!watch!.listeners.size && this.watches.get(id) === watch) this.stop(id); };
  }
  clear(): void { for (const id of this.watches.keys()) this.stop(id); }
  private refresh = () => { for (const [id, watch] of this.watches) { if (watch.timer) clearTimeout(watch.timer); void this.poll(id, watch); } };
  private schedule(id: string, watch: Watch, delay: number): void {
    watch.timer = setTimeout(() => { watch.timer = undefined; void this.poll(id, watch); }, delay);
  }
  private async poll(id: string, watch: Watch): Promise<void> {
    if (watch.reading || watch.controller.signal.aborted) return;
    watch.reading = true;
    const request = new AbortController();
    const abort = () => request.abort(); watch.controller.signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, 5000);
    try {
      const session = await this.read(id, request.signal);
      if (watch.controller.signal.aborted || this.watches.get(id) !== watch) return;
      if (session.titleRevision !== undefined && session.titleRevision > watch.revision) {
        watch.revision = session.titleRevision;
        for (const listener of watch.listeners) { try { listener(session); } catch { /* Isolate consumer callbacks. */ } }
      }
      // Old servers omit this field and should not be polled indefinitely.
      if (session.titleGenerationStatus !== "pending") { this.stop(id); return; }
    } catch (error) {
      const status = (error as { status?: number; statusCode?: number }).status ?? (error as { statusCode?: number }).statusCode;
      if (status === 401 || status === 403 || status === 404) { this.stop(id); return; }
    } finally { clearTimeout(timeout); watch.controller.signal.removeEventListener("abort", abort); watch.reading = false; }
    if (this.watches.get(id) === watch) this.schedule(id, watch, Math.min(1000 * 2 ** ++watch.attempt, 5000));
  }
  private stop(id: string): void {
    const watch = this.watches.get(id); if (!watch) return;
    watch.controller.abort(); clearTimeout(watch.deadline); if (watch.timer) clearTimeout(watch.timer);
    this.watches.delete(id);
    if (!this.watches.size && typeof window !== "undefined") { window.removeEventListener("focus", this.refresh); window.removeEventListener("online", this.refresh); }
  }
}
