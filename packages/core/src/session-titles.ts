import type { ProfiledModelSelection } from "./types/config.js";

/** Overrides are merged field by field. Null removes an override at API boundaries. */
export interface SessionTitleSettings {
  enabled?: boolean | null;
  model?: ProfiledModelSelection | null;
  language?: string | null;
  maxLength?: number | null;
  maxOutputTokens?: number | null;
  timeoutMs?: number | null;
}
export interface ResolvedSessionTitleSettings {
  enabled: boolean;
  model: ProfiledModelSelection;
  language: string;
  maxLength: number;
  maxOutputTokens: number;
  timeoutMs: number;
}
export interface SessionTitleSnapshot {
  id: string;
  title?: string;
  titleSource: "provisional" | "generated" | "manual" | "legacy";
  titleRevision: number;
  titleUpdatedAt: string;
  titleGenerationStatus: "pending" | "completed" | "failed" | "skipped";
}
export interface SessionTitleAdmission {
  sessionId: string;
  messageId: string;
  text: string;
  policy: ResolvedSessionTitleSettings;
  agentName?: string;
  agentIncarnation?: string;
  /** Persisted first-message time; recovery never extends the job lifetime. */
  createdAt?: string;
}
export interface SessionTitleJob extends SessionTitleAdmission {
  phase: "pending" | "running" | "result_ready";
  attempts: number;
  deadline: number;
  fence?: string;
  leaseUntil?: number;
  retryAfter?: number;
  candidate?: string;
}
/** Private durable state. Never expose job input/model selection in Session responses. */
export interface SessionTitleState {
  snapshot: SessionTitleSnapshot;
  job?: SessionTitleJob;
  notificationPending?: boolean;
}
export interface SessionTitleStore {
  getSessionTitleState(sessionId: string): Promise<SessionTitleState | undefined>;
  /** One atomic row/file operation, including public title and pending-work index. */
  compareAndSetSessionTitleState(sessionId: string, expected: SessionTitleState, next: SessionTitleState): Promise<boolean>;
  listPendingSessionTitles(limit?: number): Promise<string[]>;
  /** Recover admission from the canonical first user message after a process crash. */
  getSessionTitleAdmission?(sessionId: string): Promise<SessionTitleAdmission | undefined>;
}

export function normalizeSessionTitleSettings(value: unknown): SessionTitleSettings {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("sessionTitles must be an object");
  const result: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (!["enabled", "model", "language", "maxLength", "maxOutputTokens", "timeoutMs"].includes(key)) throw new Error(`Unknown sessionTitles setting: ${key}`);
    if (v == null) continue;
    if (key === "enabled" && typeof v !== "boolean") throw new Error("sessionTitles.enabled must be boolean");
    if (key === "model") {
      const target = (t: unknown): boolean => typeof t === "string" ? Boolean(t.trim()) : Boolean(t && typeof t === "object" && Object.keys(t).length === 1 && typeof (t as { profile?: unknown }).profile === "string" && (t as { profile: string }).profile.trim());
      const m = v as { primary?: unknown; fallbacks?: unknown };
      if (!target(v) && !(m && typeof m === "object" && Object.keys(m).every(k => ["primary", "fallbacks"].includes(k)) && target(m.primary) && (m.fallbacks === undefined || (Array.isArray(m.fallbacks) && m.fallbacks.length <= 3 && m.fallbacks.every(target))))) throw new Error("Invalid sessionTitles.model");
    }
    if (key === "language") {
      if (typeof v !== "string" || (v !== "auto" && !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(v))) throw new Error("Invalid sessionTitles.language");
      if (v !== "auto") { try { Intl.getCanonicalLocales(v); } catch { throw new Error("Invalid sessionTitles.language"); } }
    }
    const cap = ({ maxLength: 200, maxOutputTokens: 512, timeoutMs: 15000 } as Record<string, number>)[key];
    if (cap && (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > cap)) throw new Error(`sessionTitles.${key} must be between 1 and ${cap}`);
    result[key] = v;
  }
  return result as SessionTitleSettings;
}

export function resolveSessionTitleSettings(host: SessionTitleSettings | undefined, project: SessionTitleSettings | undefined, agent: SessionTitleSettings | undefined, firstTurnModel: ProfiledModelSelection): ResolvedSessionTitleSettings {
  return { enabled: true, model: firstTurnModel, language: "auto", maxLength: 80, maxOutputTokens: 128, timeoutMs: 5000,
    ...normalizeSessionTitleSettings(host), ...normalizeSessionTitleSettings(project), ...normalizeSessionTitleSettings(agent) } as ResolvedSessionTitleSettings;
}

export function initialSessionTitleState(id: string, title?: string, source: SessionTitleSnapshot["titleSource"] = "manual", now = new Date().toISOString()): SessionTitleState {
  return { snapshot: { id, ...(title === undefined ? {} : { title }), titleSource: source, titleRevision: 0, titleUpdatedAt: now,
    titleGenerationStatus: source === "provisional" ? "pending" : "skipped" } };
}
export function manualSessionTitleState(state: SessionTitleState, title: string, now = new Date().toISOString()): SessionTitleState {
  return { snapshot: { ...state.snapshot, title, titleSource: "manual", titleRevision: state.snapshot.titleRevision + 1, titleUpdatedAt: now, titleGenerationStatus: "skipped" }, notificationPending: true };
}
export function sessionTitleSnapshot(state: SessionTitleState): SessionTitleSnapshot { return { ...state.snapshot }; }
export function sessionTitleWorkPending(state: SessionTitleState): boolean {
  return Boolean(state.job || state.notificationPending);
}
/** Called under the same transaction/lock as the first canonical user write. */
export function admittedSessionTitleState(state: SessionTitleState, input: SessionTitleAdmission, now = Date.now()): SessionTitleState {
  if (state.job || state.snapshot.titleSource !== "provisional" || state.snapshot.titleGenerationStatus !== "pending") return state;
  if (!input.policy.enabled) return { snapshot: { ...state.snapshot, titleRevision: state.snapshot.titleRevision + 1, titleUpdatedAt: new Date(now).toISOString(), titleGenerationStatus: "skipped" }, notificationPending: true };
  return { ...state, job: { ...input, text: sessionTitleInput(input.text), phase: "pending", attempts: 0, deadline: (input.createdAt ? Date.parse(input.createdAt) : now) + 60_000 } };
}
export function sessionTitleInput(content: string | readonly { type: string; text?: string }[]): string {
  const text = typeof content === "string" ? content : content.map(part => part.type === "text" ? part.text ?? "" : `[${part.type === "image_url" ? "image attachment" : "file attachment"}]`).join("\n");
  return [...text].slice(0, 2048).join(""); // At most 8 KiB in UTF-8; never include attachment URLs.
}
export function normalizeGeneratedSessionTitle(text: string, maxLength: number): string {
  return [...text.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim().replace(/^["'`“”]+|["'`“”]+$/g, "").trim()].slice(0, maxLength).join("");
}

export interface SessionTitleGeneratorResult { text: string }
export interface SessionTitleCoordinatorOptions {
  store: SessionTitleStore;
  generate(job: SessionTitleJob, signal: AbortSignal): Promise<SessionTitleGeneratorResult>;
  emit?(snapshot: SessionTitleSnapshot): Promise<void>;
  enabled?(): boolean | Promise<boolean>;
  now?(): number;
  onError?(error: unknown): void;
}

/** Durable bounded auxiliary work; no agent run, tools, history or sandbox. */
export class SessionTitleCoordinator {
  private readonly active = new Map<string, Promise<void>>();
  private stopped = false;
  private readonly now: () => number;
  constructor(private readonly options: SessionTitleCoordinatorOptions) { this.now = options.now ?? Date.now; }

  async admit(input: SessionTitleAdmission): Promise<void> {
    const { store } = this.options;
    const state = await store.getSessionTitleState(input.sessionId);
    if (!state || state.job || state.snapshot.titleSource !== "provisional" || state.snapshot.titleGenerationStatus !== "pending") return;
    await store.compareAndSetSessionTitleState(input.sessionId, state, admittedSessionTitleState(state, input, this.now()));
  }

  /** The host may wake repeatedly. All workers share the durable claim/fence. */
  run(sessionId: string): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const current = this.active.get(sessionId);
    if (current) return current;
    if (this.active.size >= 4) return Promise.resolve(); // Bounded local concurrency; durable scan retries.
    const promise = this.execute(sessionId).catch(error => { this.options.onError?.(error); }).finally(() => { this.active.delete(sessionId); });
    this.active.set(sessionId, promise);
    return promise;
  }

  /** Stop new claims and drain bounded in-flight inference before the host closes its stores. */
  async close(): Promise<void> { this.stopped = true; await Promise.all(this.active.values()); }

  async drain(limit = 32): Promise<void> {
    const ids = await this.options.store.listPendingSessionTitles(limit);
    for (let i = 0; i < ids.length; i += 4) await Promise.all(ids.slice(i, i + 4).map(id => this.run(id)));
  }

  private async execute(id: string): Promise<void> {
    const { store } = this.options;
    let state = await store.getSessionTitleState(id);
    if (!state) return;
    if (state.notificationPending) {
      if (this.options.emit) {
        await this.options.emit(sessionTitleSnapshot(state));
        await store.compareAndSetSessionTitleState(id, state, { ...state, notificationPending: false });
      }
      state = await store.getSessionTitleState(id);
      if (!state) return;
    }
    if (!state.job && state.snapshot.titleSource === "provisional" && state.snapshot.titleGenerationStatus === "pending") {
      const input = await store.getSessionTitleAdmission?.(id);
      if (!input) return;
      await this.admit(input);
      state = await store.getSessionTitleState(id);
    }
    if (!state?.job) return;
    if (this.options.enabled && !await this.options.enabled()) { await this.finish(state, "skipped"); return; }
    if (state.job.phase === "result_ready") { await this.apply(state); return; }
    const now = this.now();
    if (state.job.deadline <= now || state.job.attempts >= 2 && (state.job.leaseUntil ?? 0) <= now) { await this.finish(state, "failed"); return; }
    if ((state.job.leaseUntil ?? 0) > now || (state.job.retryAfter ?? 0) > now) return;
    const job: SessionTitleJob = { ...state.job, phase: "running", fence: crypto.randomUUID(), attempts: state.job.attempts + 1, leaseUntil: now + state.job.policy.timeoutMs + 2000 };
    const claimed: SessionTitleState = { ...state, job };
    if (!await store.compareAndSetSessionTitleState(id, state, claimed)) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        this.options.generate(job, controller.signal),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("Session title deadline exceeded")); }, Math.min(job.policy.timeoutMs, job.deadline - now)); }),
      ]);
      const candidate = normalizeGeneratedSessionTitle(result.text, job.policy.maxLength);
      if (!candidate) { await this.finish(claimed, "failed"); return; }
      const ready: SessionTitleState = { ...claimed, job: { ...job, phase: "result_ready", candidate } };
      if (await store.compareAndSetSessionTitleState(id, claimed, ready)) await this.apply(ready);
    } catch (error) {
      // Authentication/configuration failures are terminal; ambiguous/transient requests have one bounded retry.
      const status = (error as { statusCode?: number; status?: number })?.statusCode ?? (error as { status?: number })?.status;
      if (job.attempts >= 2 || (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429)) await this.finish(claimed, "failed");
      else await store.compareAndSetSessionTitleState(id, claimed, { ...claimed, job: { ...job, phase: "pending", leaseUntil: undefined, fence: undefined, retryAfter: this.now() + 1000 } });
      this.options.onError?.(error);
    } finally { if (timer) clearTimeout(timer); }
  }

  private async apply(state: SessionTitleState): Promise<void> {
    if (!state.job?.candidate || state.snapshot.titleSource !== "provisional") return;
    if (this.options.enabled && !await this.options.enabled()) {
      await this.finish(state, "skipped");
      return;
    }
    await this.finish(state, "completed", state.job.candidate);
  }
  private async finish(state: SessionTitleState, status: SessionTitleSnapshot["titleGenerationStatus"], title?: string): Promise<void> {
    const next: SessionTitleState = { snapshot: { ...state.snapshot, ...(title ? { title, titleSource: "generated" as const } : {}), titleRevision: state.snapshot.titleRevision + 1, titleUpdatedAt: new Date(this.now()).toISOString(), titleGenerationStatus: status }, notificationPending: true };
    if (await this.options.store.compareAndSetSessionTitleState(state.snapshot.id, state, next) && this.options.emit) {
      await this.options.emit(sessionTitleSnapshot(next));
      await this.options.store.compareAndSetSessionTitleState(state.snapshot.id, next, { ...next, notificationPending: false });
    }
  }
}
