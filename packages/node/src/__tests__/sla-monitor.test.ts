import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { SLAMonitor } from "../quality/sla-monitor.js";
import { HookRegistry } from "@polpo-ai/core/hooks";
import { TypedEmitter } from "../core/events.js";
import { InMemoryTaskStore, InMemoryRunStore, createTestTask } from "./fixtures.js";
import type { OrchestratorContext } from "@polpo-ai/core/orchestrator-context";
import type { PolpoConfig, Task, Mission } from "@polpo-ai/core/types";

// ── Helpers ──────────────────────────────────────────

function createMinimalConfig(): PolpoConfig {
  return {
    version: "1",
    project: "test",
    teams: [{ name: "test-team", agents: [{ name: "test-agent" }] }],
    tasks: [],
    settings: { maxRetries: 2, workDir: "/tmp/test", logLevel: "quiet" },
  };
}

function createMockCtx(store?: InMemoryTaskStore): OrchestratorContext {
  return {
    emitter: new TypedEmitter(),
    taskStore: store ?? new InMemoryTaskStore(),
    runStore: new InMemoryRunStore(),
    memoryStore: { exists: async () => false, get: async () => "", save: async () => {}, append: async () => {}, update: async () => true as true | string },
    logStore: { startSession: async () => "s", getSessionId: async () => "s", append: async () => {}, getSessionEntries: async () => [], listSessions: async () => [], prune: async () => 0, close: () => {} },
    sessionStore: { create: async () => "s1", addMessage: async () => ({ id: "m1", role: "user" as const, content: "", ts: "" }), updateMessage: async () => false, getMessages: async () => [], getRecentMessages: async () => [], listSessions: async () => [], getSession: async () => undefined, getLatestSession: async () => undefined, renameSession: async () => false, deleteSession: async () => false, prune: async () => 0, close: () => {} },
    hooks: new HookRegistry(),
    config: createMinimalConfig(),
    workDir: "/tmp/test",
    agentWorkDir: "/tmp/test",
    polpoDir: "/tmp/test/.polpo",
    assessFn: vi.fn(),
  };
}

describe("SLAMonitor", () => {
  let ctx: OrchestratorContext;
  let store: InMemoryTaskStore;
  let monitor: SLAMonitor;

  beforeEach(() => {
    store = new InMemoryTaskStore();
    ctx = createMockCtx(store);
    monitor = new SLAMonitor(ctx, {
      warningThreshold: 0.8,
      checkIntervalMs: 0, // no throttle in tests
    });
    monitor.init();
  });

  afterEach(() => {
    monitor.dispose();
  });

  it("emits sla:warning when threshold is reached", async () => {
    const emitSpy = vi.spyOn(ctx.emitter, "emit");

    // Task created 100 seconds ago, deadline 10 seconds from now
    // percentUsed = 100 / (100+10) = 0.909 > 0.8
    const createdAt = new Date(Date.now() - 100_000).toISOString();
    const deadline = new Date(Date.now() + 10_000).toISOString();

    await store.createTask({
      title: "Urgent task",
      description: "Test",
      assignTo: "test-agent",
      dependsOn: [],
      expectations: [],
      metrics: [],
      maxRetries: 2,
      deadline,
    });
    // Override createdAt
    const task = (await store.listTasks())[0];
    (task as any).createdAt = createdAt;

    await monitor.check();

    expect(emitSpy).toHaveBeenCalledWith("sla:warning", expect.objectContaining({
      entityType: "task",
      deadline,
    }));
  });

  it("emits sla:violated when deadline passes", async () => {
    const emitSpy = vi.spyOn(ctx.emitter, "emit");

    const createdAt = new Date(Date.now() - 100_000).toISOString();
    const deadline = new Date(Date.now() - 1_000).toISOString(); // already past

    await store.createTask({
      title: "Overdue task",
      description: "Test",
      assignTo: "test-agent",
      dependsOn: [],
      expectations: [],
      metrics: [],
      maxRetries: 2,
      deadline,
    });
    const task = (await store.listTasks())[0];
    (task as any).createdAt = createdAt;

    await monitor.check();

    expect(emitSpy).toHaveBeenCalledWith("sla:violated", expect.objectContaining({
      entityType: "task",
      deadline,
    }));
  });

  it("does not re-emit for the same entity", async () => {
    const emitSpy = vi.spyOn(ctx.emitter, "emit");

    const deadline = new Date(Date.now() - 1_000).toISOString();
    await store.createTask({
      title: "Overdue task",
      description: "Test",
      assignTo: "test-agent",
      dependsOn: [],
      expectations: [],
      metrics: [],
      maxRetries: 2,
      deadline,
    });
    const task = (await store.listTasks())[0];
    (task as any).createdAt = new Date(Date.now() - 100_000).toISOString();

    await monitor.check();
    await monitor.check();

    const violationCalls = emitSpy.mock.calls.filter(c => c[0] === "sla:violated");
    expect(violationCalls.length).toBe(1);
  });

  it("skips terminal tasks", async () => {
    const emitSpy = vi.spyOn(ctx.emitter, "emit");

    const deadline = new Date(Date.now() - 1_000).toISOString();
    await store.createTask({
      title: "Done task",
      description: "Test",
      assignTo: "test-agent",
      dependsOn: [],
      expectations: [],
      metrics: [],
      maxRetries: 2,
      deadline,
    });
    const task = (await store.listTasks())[0];
    (task as any).createdAt = new Date(Date.now() - 100_000).toISOString();

    // Transition to done
    await store.transition(task.id, "assigned");
    await store.transition(task.id, "in_progress");
    await store.transition(task.id, "review");
    await store.transition(task.id, "done");

    await monitor.check();

    const violationCalls = emitSpy.mock.calls.filter(c => c[0] === "sla:violated");
    expect(violationCalls.length).toBe(0);
  });

  it("emits sla:met when task completes before deadline", async () => {
    const emitSpy = vi.spyOn(ctx.emitter, "emit");
    const deadline = new Date(Date.now() + 60_000).toISOString();

    const task = createTestTask({ id: "t1", deadline });

    await ctx.hooks.runAfter("task:complete", {
      taskId: "t1",
      task,
    });

    expect(emitSpy).toHaveBeenCalledWith("sla:met", expect.objectContaining({
      entityId: "t1",
      entityType: "task",
      deadline,
    }));
  });

  it("force-fails tasks when violationAction is 'fail'", async () => {
    const failMonitor = new SLAMonitor(ctx, {
      checkIntervalMs: 0,
      violationAction: "fail",
    });
    failMonitor.init();

    const deadline = new Date(Date.now() - 1_000).toISOString();
    await store.createTask({
      title: "Overdue task",
      description: "Test",
      assignTo: "test-agent",
      dependsOn: [],
      expectations: [],
      metrics: [],
      maxRetries: 2,
      deadline,
    });
    const task = (await store.listTasks())[0];
    (task as any).createdAt = new Date(Date.now() - 100_000).toISOString();
    // Move task to in_progress (so unsafeSetStatus to failed works meaningfully)
    await store.transition(task.id, "assigned");
    await store.transition(task.id, "in_progress");

    await failMonitor.check();

    expect((await store.getTask(task.id))!.status).toBe("failed");
    failMonitor.dispose();
  });

  it("clearEntity resets tracking for an entity", async () => {
    const emitSpy = vi.spyOn(ctx.emitter, "emit");

    const deadline = new Date(Date.now() - 1_000).toISOString();
    await store.createTask({
      title: "Overdue task",
      description: "Test",
      assignTo: "test-agent",
      dependsOn: [],
      expectations: [],
      metrics: [],
      maxRetries: 2,
      deadline,
    });
    const task = (await store.listTasks())[0];
    (task as any).createdAt = new Date(Date.now() - 100_000).toISOString();

    await monitor.check();
    const callsBefore = emitSpy.mock.calls.filter(c => c[0] === "sla:violated").length;

    monitor.clearEntity(task.id);
    await monitor.check();

    const callsAfter = emitSpy.mock.calls.filter(c => c[0] === "sla:violated").length;
    expect(callsAfter).toBe(callsBefore + 1);
  });
});
