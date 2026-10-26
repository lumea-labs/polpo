import { describe, expect, it, vi } from "vitest";
import {
  SessionTitleCoordinator, initialSessionTitleState, manualSessionTitleState,
  normalizeSessionTitleSettings, resolveSessionTitleSettings, sessionTitleSnapshot,
  type SessionTitleState, type SessionTitleStore,
} from "./session-titles.js";

function fixture() {
  let state: SessionTitleState | undefined = initialSessionTitleState("s", "ciao", "provisional", "2026-10-25T00:00:00.000Z");
  let present = true;
  const store: SessionTitleStore = {
    getSessionTitleState: async () => present ? structuredClone(state) : undefined,
    compareAndSetSessionTitleState: async (_id, expected, next) => {
      if (!present || JSON.stringify(state) !== JSON.stringify(expected)) return false;
      state = structuredClone(next); return true;
    },
    listPendingSessionTitles: async () => present && state && (state.job || state.notificationPending) ? ["s"] : [],
  };
  return { store, get: () => state!, set: (s: SessionTitleState) => { state = s; }, delete: () => { present = false; } };
}

const policy = resolveSessionTitleSettings({}, {}, {}, "test/small");
const admission = { sessionId: "s", messageId: "m", text: "ciao", policy, agentName: "leo" };

describe("session title settings", () => {
  it("inherits the first-turn model and defaults without inheriting agent reasoning", () => {
    expect(policy).toMatchObject({ enabled: true, model: "test/small", language: "auto", maxLength: 80, timeoutMs: 5000, maxOutputTokens: 128 });
  });
  it("merges fields, respects false, and treats null as inherited", () => {
    expect(resolveSessionTitleSettings({ model: "a", language: "it" }, { model: "b" }, { enabled: false, model: null }, "c"))
      .toMatchObject({ model: "b", enabled: false, language: "it" });
  });
  it.each([{ timeoutMs: 0 }, { timeoutMs: 15001 }, { maxLength: 201 }, { maxOutputTokens: 513 }, { enabled: "yes" }, { language: "bad tag" }, { unknown: 1 }])("rejects invalid settings %j", value => {
    expect(() => normalizeSessionTitleSettings(value)).toThrow();
  });
});

describe("durable session naming", () => {
  it("names a greeting once and preserves a saved result across notification failure", async () => {
    const f = fixture(); const generate = vi.fn(async () => ({ text: "Saluto iniziale" }));
    const emit = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    const c = new SessionTitleCoordinator({ store: f.store, generate, emit });
    await c.admit(admission);
    await c.run("s");
    expect(sessionTitleSnapshot(f.get())).toMatchObject({ title: "Saluto iniziale", titleSource: "generated", titleRevision: 1 });
    await c.run("s"); await c.admit(admission); await c.run("s");
    expect(generate).toHaveBeenCalledTimes(1); expect(emit).toHaveBeenCalledTimes(2);
  });
  it("a manual rename to identical text fences an in-flight generator", async () => {
    const f = fixture(); let finish!: (r: { text: string }) => void;
    const generate = vi.fn(() => new Promise<{ text: string }>(r => { finish = r; }));
    const c = new SessionTitleCoordinator({ store: f.store, generate });
    await c.admit(admission); const running = c.run("s");
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    f.set(manualSessionTitleState(f.get(), "ciao")); finish({ text: "Automatico" }); await running;
    expect(f.get().snapshot).toMatchObject({ title: "ciao", titleSource: "manual", titleRevision: 1 });
  });
  it("two coordinators cannot generate the same session concurrently", async () => {
    const f = fixture(); const generate = vi.fn(async () => ({ text: "One" }));
    const a = new SessionTitleCoordinator({ store: f.store, generate });
    const b = new SessionTitleCoordinator({ store: f.store, generate });
    await Promise.all([a.admit(admission), b.admit(admission)]);
    await Promise.all([a.run("s"), b.run("s")]);
    expect(generate).toHaveBeenCalledOnce(); expect(f.get().snapshot.title).toBe("One");
  });
  it("does not resurrect deleted sessions", async () => {
    const f = fixture(); const c = new SessionTitleCoordinator({ store: f.store, generate: async () => { f.delete(); return { text: "late" }; } });
    await c.admit(admission); await c.run("s");
    expect(await f.store.getSessionTitleState("s")).toBeUndefined();
  });
  it("preserves manual and legacy sessions", async () => {
    for (const source of ["manual", "legacy"] as const) {
      const f = fixture(); f.set(initialSessionTitleState("s", "Keep", source));
      const generate = vi.fn(); const c = new SessionTitleCoordinator({ store: f.store, generate });
      await c.admit(admission); await c.run("s"); expect(generate).not.toHaveBeenCalled();
    }
  });
  it("bounds timeout even when the provider ignores abort", async () => {
    const f = fixture(); const c = new SessionTitleCoordinator({ store: f.store, generate: () => new Promise(() => {}) });
    await c.admit({ ...admission, policy: { ...policy, timeoutMs: 10 } });
    await c.run("s"); expect(f.get().snapshot.title).toBe("ciao"); expect(f.get().job?.attempts).toBe(1);
  });
  it("does not emit model errors into the conversation and terminates invalid output", async () => {
    const f = fixture(); const c = new SessionTitleCoordinator({ store: f.store, generate: async () => ({ text: "\u0000\n" }) });
    await c.admit(admission); await c.run("s");
    expect(f.get().snapshot).toMatchObject({ title: "ciao", titleGenerationStatus: "failed" });
    expect(f.get().job).toBeUndefined();
  });
  it("fences a delayed first worker after its lease expires and a second worker completes", async () => {
    const f = fixture(); let now = Date.now(), finish!: (value: { text: string }) => void;
    const a = new SessionTitleCoordinator({ store: f.store, now: () => now, generate: () => new Promise(resolve => { finish = resolve; }) });
    const b = new SessionTitleCoordinator({ store: f.store, now: () => now, generate: async () => ({ text: "Recovered" }) });
    await a.admit(admission); const first = a.run("s");
    await vi.waitFor(() => expect(f.get().job?.phase).toBe("running"));
    now += policy.timeoutMs + 2001; await b.run("s");
    finish({ text: "Stale" }); await first;
    expect(f.get().snapshot.title).toBe("Recovered");
  });
  it("applies a persisted candidate after expiry without another model call", async () => {
    const f = fixture(); const generate = vi.fn();
    const c = new SessionTitleCoordinator({ store: f.store, generate }); await c.admit(admission);
    f.set({ ...f.get(), job: { ...f.get().job!, phase: "result_ready", candidate: "Saved", deadline: 1 } });
    await c.run("s"); expect(generate).not.toHaveBeenCalled(); expect(f.get().snapshot.title).toBe("Saved");
  });
  it("honors a kill switch after admission without invoking the provider", async () => {
    const f = fixture(), generate = vi.fn();
    const c = new SessionTitleCoordinator({ store: f.store, generate, enabled: () => false });
    await c.admit(admission); await c.run("s");
    expect(generate).not.toHaveBeenCalled(); expect(f.get().snapshot.titleGenerationStatus).toBe("skipped");
  });
  it("does not apply a provider result if the host is disabled during inference", async () => {
    const f = fixture(); let enabled = true;
    const c = new SessionTitleCoordinator({ store: f.store, enabled: () => enabled,
      generate: async () => { enabled = false; return { text: "Late title" }; } });
    await c.admit(admission); await c.run("s");
    expect(f.get().snapshot).toMatchObject({ title: "ciao", titleGenerationStatus: "skipped" });
    expect(f.get().job).toBeUndefined();
  });
  it("drains in-flight work before shutdown and refuses new claims", async () => {
    const f = fixture(); let finish!: (r: { text: string }) => void;
    const generate = vi.fn(() => new Promise<{ text: string }>(resolve => { finish = resolve; }));
    const c = new SessionTitleCoordinator({ store: f.store, generate });
    await c.admit(admission); const running = c.run("s");
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    const done = vi.fn(); const closing = c.close().then(done);
    await c.run("another"); expect(done).not.toHaveBeenCalled();
    finish({ text: "Saved before shutdown" }); await Promise.all([running, closing]);
    expect(done).toHaveBeenCalledOnce(); expect(generate).toHaveBeenCalledOnce();
    expect(f.get().snapshot.title).toBe("Saved before shutdown");
  });
  it("limits repeated transient failures to two calls and drops the stored first message", async () => {
    const f = fixture(); let now = Date.now(); const generate = vi.fn(async () => { throw new Error("network"); });
    const c = new SessionTitleCoordinator({ store: f.store, generate, now: () => now });
    await c.admit(admission);
    for (let i = 0; i < 8; i++) { await c.run("s"); now += 2000; }
    expect(generate).toHaveBeenCalledTimes(2); expect(f.get().job).toBeUndefined();
    expect(f.get().snapshot.titleGenerationStatus).toBe("failed");
  });
});
