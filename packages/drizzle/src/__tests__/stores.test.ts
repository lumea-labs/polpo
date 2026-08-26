/**
 * @polpo-ai/drizzle — SQLite in-memory tests for all 15 Drizzle stores.
 *
 * Uses better-sqlite3 :memory: — no PG required.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrateSqliteSchema } from "../sqlite-migrator.js";
import { createSqliteStores, type DrizzleStores } from "../index.js";
import type { ApprovalRequest } from "@polpo-ai/core/types";

// Provide a deterministic vault key for tests (32 bytes hex-encoded)
process.env.POLPO_VAULT_KEY = randomBytes(32).toString("hex");

// ── Test helpers ─────────────────────────────────────────────────────

let sqlite: InstanceType<typeof Database>;
let db: ReturnType<typeof drizzle>;
let stores: DrizzleStores;


beforeEach(async () => {
  sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  db = drizzle(sqlite);
  await migrateSqliteSchema(db);
  stores = createSqliteStores(db);
});

afterEach(() => {
  sqlite.close();
});

// ═══════════════════════════════════════════════════════════════════════
// TaskStore
// ═══════════════════════════════════════════════════════════════════════

describe("DrizzleTaskStore", () => {
  it("createTask + getTask round-trip", async () => {
    const task = await stores.taskStore.createTask({
      title: "Fix bug",
      description: "Fix the login bug",
      assignTo: "claude",
      dependsOn: [],
      maxRetries: 3,
      expectations: [{ type: "llm_review" as const, criteria: "Login works" }],
      metrics: [],
    });

    expect(task.id).toBeDefined();
    expect(task.status).toBe("pending");
    expect(task.retries).toBe(0);
    expect(task.title).toBe("Fix bug");

    const fetched = await stores.taskStore.getTask(task.id);
    expect(fetched).toBeDefined();
    expect(fetched!.title).toBe("Fix bug");
    expect(fetched!.expectations).toEqual([{ type: "llm_review", criteria: "Login works" }]);
  });

  it("createTask persists OpenAI-compat user identifier", async () => {
    const task = await stores.taskStore.createTask({
      title: "Per-user task",
      description: "Scoped to end-user",
      assignTo: "claude",
      dependsOn: [],
      maxRetries: 2,
      expectations: [],
      metrics: [],
      user: "u-42",
    });
    expect(task.user).toBe("u-42");

    const fetched = await stores.taskStore.getTask(task.id);
    expect(fetched!.user).toBe("u-42");
  });

  it("createTask persists runtime sandbox policy", async () => {
    const task = await stores.taskStore.createTask({
      title: "Fresh sandbox task",
      description: "Run in a clean sandbox",
      assignTo: "claude",
      dependsOn: [],
      maxRetries: 2,
      expectations: [],
      metrics: [],
      sandbox: {
        isolation: "fresh",
        lifecycle: { onRelease: "pool", idleTtlMinutes: 30 },
      },
    });

    const fetched = await stores.taskStore.getTask(task.id);
    expect(fetched!.sandbox).toEqual({
      isolation: "fresh",
      lifecycle: { onRelease: "pool", idleTtlMinutes: 30 },
    });
  });

  it("createTask persists bounded runtime routing labels", async () => {
    const task = await stores.taskStore.createTask({
      title: "Paid export",
      description: "Build the customer export",
      assignTo: "claude",
      dependsOn: [],
      maxRetries: 2,
      expectations: [],
      metrics: [],
      routing: { labels: ["plan:paid", "request:export"] },
    });

    const fetched = await stores.taskStore.getTask(task.id);
    expect(fetched!.routing).toEqual({
      labels: ["plan:paid", "request:export"],
    });
  });

  it("listTasks returns ordered by createdAt", async () => {
    await stores.taskStore.createTask({
      title: "A", description: "first", assignTo: "claude", dependsOn: [], maxRetries: 2, expectations: [], metrics: [],
    });
    await stores.taskStore.createTask({
      title: "B", description: "second", assignTo: "claude", dependsOn: [], maxRetries: 2, expectations: [], metrics: [],
    });

    const all = await stores.taskStore.listTasks();
    expect(all).toHaveLength(2);
    expect(all[0].title).toBe("A");
    expect(all[1].title).toBe("B");
  });

  it("updateTask merges fields", async () => {
    const task = await stores.taskStore.createTask({
      title: "Original", description: "desc", assignTo: "claude", dependsOn: [], maxRetries: 2, expectations: [], metrics: [],
    });

    const updated = await stores.taskStore.updateTask(task.id, { title: "Updated" });
    expect(updated.title).toBe("Updated");
    expect(updated.description).toBe("desc"); // unchanged

    const fetched = await stores.taskStore.getTask(task.id);
    expect(fetched!.title).toBe("Updated");
  });

  it("deleteTask deletes by ID", async () => {
    const task = await stores.taskStore.createTask({
      title: "Delete me", description: "d", assignTo: "claude", dependsOn: [], maxRetries: 2, expectations: [], metrics: [],
    });

    const removed = await stores.taskStore.deleteTask(task.id);
    expect(removed).toBe(true);

    const fetched = await stores.taskStore.getTask(task.id);
    expect(fetched).toBeUndefined();
  });

  it("deleteTasks with filter", async () => {
    await stores.taskStore.createTask({
      title: "Keep", description: "d", assignTo: "claude", dependsOn: [], maxRetries: 2, expectations: [], metrics: [],
    });
    await stores.taskStore.createTask({
      title: "Remove", description: "d", assignTo: "claude", dependsOn: [], maxRetries: 2, expectations: [], metrics: [], group: "old",
    });

    const count = await stores.taskStore.deleteTasks((t) => t.group === "old");
    expect(count).toBe(1);

    const all = await stores.taskStore.listTasks();
    expect(all).toHaveLength(1);
    expect(all[0].title).toBe("Keep");
  });

  it("transition validates state machine", async () => {
    const task = await stores.taskStore.createTask({
      title: "T", description: "d", assignTo: "claude", dependsOn: [], maxRetries: 2, expectations: [], metrics: [],
    });

    // pending → assigned is valid
    const assigned = await stores.taskStore.transition(task.id, "assigned");
    expect(assigned.status).toBe("assigned");

    // assigned → pending is invalid
    await expect(stores.taskStore.transition(task.id, "pending")).rejects.toThrow();
  });

  it("transition increments retries on failed→pending", async () => {
    const task = await stores.taskStore.createTask({
      title: "T", description: "d", assignTo: "claude", dependsOn: [], maxRetries: 3, expectations: [], metrics: [],
    });

    await stores.taskStore.transition(task.id, "assigned");
    await stores.taskStore.transition(task.id, "in_progress");
    await stores.taskStore.transition(task.id, "failed");

    const retried = await stores.taskStore.transition(task.id, "pending");
    expect(retried.retries).toBe(1);
  });

  it("unsafeSetStatus bypasses state machine", async () => {
    const task = await stores.taskStore.createTask({
      title: "T", description: "d", assignTo: "claude", dependsOn: [], maxRetries: 2, expectations: [], metrics: [],
    });

    // pending → done is not a valid transition, but unsafeSetStatus allows it
    const result = await stores.taskStore.unsafeSetStatus(task.id, "done", "admin override");
    expect(result.status).toBe("done");
  });

  // ── Missions ────────────────────────────────────────────────────────

  it("createMission + getMission round-trip", async () => {
    const mission = await stores.missionStore.createMission!({
      name: "mission-1",
      data: '{"tasks":[]}',
      status: "draft",
    });

    expect(mission.id).toBeDefined();
    expect(mission.name).toBe("mission-1");

    const fetched = await stores.missionStore.getMission!(mission.id);
    expect(fetched).toBeDefined();
    expect(fetched!.name).toBe("mission-1");
  });

  it("getMissionByName finds by name", async () => {
    await stores.missionStore.createMission!({ name: "deploy-v2", data: "{}", status: "draft" });
    const found = await stores.missionStore.getMissionByName!("deploy-v2");
    expect(found).toBeDefined();
    expect(found!.name).toBe("deploy-v2");
  });

  it("updateMission merges fields", async () => {
    const m = await stores.missionStore.createMission!({ name: "m-1", data: "{}", status: "draft" });
    const updated = await stores.missionStore.updateMission!(m.id, { status: "active" });
    expect(updated.status).toBe("active");
    expect(updated.name).toBe("m-1");
  });

  it("deleteMission removes", async () => {
    const m = await stores.missionStore.createMission!({ name: "m-del", data: "{}", status: "draft" });
    const ok = await stores.missionStore.deleteMission!(m.id);
    expect(ok).toBe(true);
    const fetched = await stores.missionStore.getMission!(m.id);
    expect(fetched).toBeUndefined();
  });

  it("nextMissionName increments", async () => {
    expect(await stores.missionStore.nextMissionName!()).toBe("mission-1");
    await stores.missionStore.createMission!({ name: "mission-1", data: "{}", status: "draft" });
    expect(await stores.missionStore.nextMissionName!()).toBe("mission-2");
    await stores.missionStore.createMission!({ name: "mission-5", data: "{}", status: "draft" });
    expect(await stores.missionStore.nextMissionName!()).toBe("mission-6");
  });

  // ── State ────────────────────────────────────────────────────────────

  it("setState + getState round-trip", async () => {
    await stores.taskStore.setState({
      project: "test-project",
      teams: [{ name: "alpha", agents: [{ name: "claude" }] }],
      startedAt: "2025-01-01T00:00:00Z",
    });

    const state = await stores.taskStore.getState();
    expect(state.project).toBe("test-project");
    expect(state.teams).toHaveLength(1);
    expect(state.teams[0].name).toBe("alpha");
    expect(state.startedAt).toBe("2025-01-01T00:00:00Z");
  });

  it("setState with processes", async () => {
    await stores.taskStore.setState({
      project: "p",
      processes: [{
        agentName: "claude",
        pid: 1234,
        taskId: "t1",
        startedAt: "2025-01-01T00:00:00Z",
        alive: true,
        activity: { filesCreated: [], filesEdited: [], toolCalls: 5, totalTokens: 100, lastUpdate: "now" },
      }],
    });

    const state = await stores.taskStore.getState();
    expect(state.processes).toHaveLength(1);
    expect(state.processes[0].pid).toBe(1234);
    expect(state.processes[0].alive).toBe(true);
    expect(state.processes[0].activity.toolCalls).toBe(5);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// RunStore
// ═══════════════════════════════════════════════════════════════════════

describe("DrizzleRunStore", () => {
  const now = new Date().toISOString();

  const makeRun = (id: string, taskId: string, status = "running" as const) => ({
    id,
    taskId,
    pid: 0,
    agentName: "claude",
    sessionId: undefined,
    status,
    startedAt: now,
    updatedAt: now,
    activity: { filesCreated: [] as string[], filesEdited: [] as string[], toolCalls: 0, totalTokens: 0, lastUpdate: "" },
    result: undefined,
    outcomes: undefined,
    configPath: "/tmp/config.json",
  });

  it("upsertRun + getRun round-trip", async () => {
    const run = makeRun("r1", "t1");
    await stores.runStore.upsertRun(run as any);

    const fetched = await stores.runStore.getRun("r1");
    expect(fetched).toBeDefined();
    expect(fetched!.taskId).toBe("t1");
    expect(fetched!.status).toBe("running");
  });

  it("upsertRun persists OpenAI-compat user identifier", async () => {
    await stores.runStore.upsertRun({
      ...makeRun("r-user", "t-user"),
      user: "u-42",
    } as any);

    const fetched = await stores.runStore.getRun("r-user");
    expect(fetched!.user).toBe("u-42");
  });

  it("upsertRun updates on conflict", async () => {
    await stores.runStore.upsertRun(makeRun("r1", "t1") as any);
    await stores.runStore.upsertRun({ ...makeRun("r1", "t1"), status: "completed" as any } as any);

    const fetched = await stores.runStore.getRun("r1");
    expect(fetched!.status).toBe("completed");
  });

  it("getRunByTaskId returns latest", async () => {
    await stores.runStore.upsertRun({ ...makeRun("r1", "t1"), startedAt: "2025-01-01T00:00:00Z" } as any);
    await stores.runStore.upsertRun({ ...makeRun("r2", "t1"), startedAt: "2025-01-02T00:00:00Z" } as any);

    const latest = await stores.runStore.getRunByTaskId("t1");
    expect(latest).toBeDefined();
    expect(latest!.id).toBe("r2");
  });

  it("persists trace events atomically and lists runs by session", async () => {
    await stores.runStore.upsertRun({
      ...makeRun("r-trace-1", "chat-1"),
      sessionId: "session-chat",
      delivery: "stream",
      trace: [],
    } as any);
    await stores.runStore.upsertRun({
      ...makeRun("r-trace-2", "chat-2"),
      sessionId: "session-chat",
      delivery: "stream",
      startedAt: "2099-01-02T00:00:00Z",
      trace: [],
    } as any);
    await stores.runStore.upsertRun({
      ...makeRun("r-other", "chat-3"),
      sessionId: "other-session",
      delivery: "stream",
      trace: [],
    } as any);

    const appendTrace = (stores.runStore as any).appendTrace.bind(stores.runStore);
    await Promise.all([
      appendTrace("r-trace-1", {
        id: "event-a",
        type: "sandbox.acquire.started",
        ts: "2025-01-01T00:00:01Z",
        operation: "acquire",
      }),
      appendTrace("r-trace-1", {
        id: "event-b",
        type: "sandbox.acquired",
        ts: "2025-01-01T00:00:02Z",
        operation: "acquire",
        sandboxId: "sandbox-1",
      }),
    ]);
    await appendTrace("r-trace-1", {
      id: "event-a",
      type: "sandbox.acquire.started",
      ts: "2025-01-01T00:00:01Z",
      operation: "acquire",
    });

    const fetched = await stores.runStore.getRun("r-trace-1");
    expect(fetched?.trace).toHaveLength(2);
    expect(new Set(fetched?.trace?.map((event) => event.id))).toEqual(
      new Set(["event-a", "event-b"]),
    );

    const sessionRuns = await (stores.runStore as any).getRunsBySessionId("session-chat");
    expect(sessionRuns.map((run: any) => run.id)).toEqual(["r-trace-2", "r-trace-1"]);
  });

  it("upsertRun does not erase an existing trace", async () => {
    await stores.runStore.upsertRun({ ...makeRun("r-trace-keep", "chat-keep"), trace: [] } as any);
    await (stores.runStore as any).appendTrace("r-trace-keep", {
      id: "event-keep",
      type: "sandbox.released",
      ts: "2025-01-01T00:00:03Z",
      operation: "release",
    });

    await stores.runStore.upsertRun({
      ...makeRun("r-trace-keep", "chat-keep"),
      status: "completed",
    } as any);

    expect((await stores.runStore.getRun("r-trace-keep"))?.trace).toEqual([
      expect.objectContaining({ id: "event-keep" }),
    ]);
  });

  it("getActiveRuns returns only running", async () => {
    await stores.runStore.upsertRun(makeRun("r1", "t1") as any);
    await stores.runStore.upsertRun({ ...makeRun("r2", "t2"), status: "completed" as any } as any);

    const active = await stores.runStore.getActiveRuns();
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe("r1");
  });

  it("getTerminalRuns returns completed/failed/killed", async () => {
    await stores.runStore.upsertRun(makeRun("r1", "t1") as any);
    await stores.runStore.upsertRun({ ...makeRun("r2", "t2"), status: "completed" as any } as any);
    await stores.runStore.upsertRun({ ...makeRun("r3", "t3"), status: "failed" as any } as any);

    const terminal = await stores.runStore.getTerminalRuns();
    expect(terminal).toHaveLength(2);
  });

  it("engine-scoped queries exclude project-loop (graph) rows folded into runs (F2)", async () => {
    // Simulate loop_runs folded into the runs table: rows with engine="graph".
    // The reaper iterates getActiveRuns/getTerminalRuns and would delete/re-spawn
    // these if not excluded — the discriminator prevents that.
    const { runsSqlite } = await import("../schema/runs.js");
    const graphRow = (id: string, status: string) => ({
      id, taskId: id, agentName: "chat", adapterType: "loop", configPath: "",
      status, startedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", engine: "graph",
    });
    await db.insert(runsSqlite).values(graphRow("looprun-running", "running") as any);
    await db.insert(runsSqlite).values(graphRow("looprun-done", "completed") as any);
    // Normal task runs — engine defaults to "agent".
    await stores.runStore.upsertRun(makeRun("r1", "t1") as any);
    await stores.runStore.upsertRun({ ...makeRun("r2", "t2"), status: "completed" as any } as any);

    expect((await stores.runStore.getActiveRuns()).map((r) => r.id)).toEqual(["r1"]);
    expect((await stores.runStore.getTerminalRuns()).map((r) => r.id)).toEqual(["r2"]);
    expect(await stores.runStore.getRunByTaskId("looprun-running")).toBeUndefined();
  });

  it("completeRun guards against overwriting terminal status", async () => {
    await stores.runStore.upsertRun({ ...makeRun("r1", "t1"), status: "completed" as any } as any);

    // Try to overwrite with failed — should be silently ignored
    await stores.runStore.completeRun("r1", "failed", { exitCode: 1, stdout: "", stderr: "nope", duration: 100 });
    const fetched = await stores.runStore.getRun("r1");
    expect(fetched!.status).toBe("completed"); // unchanged
  });

  it("updateActivity updates activity and sessionId", async () => {
    await stores.runStore.upsertRun(makeRun("r1", "t1") as any);
    await stores.runStore.updateActivity("r1", {
      filesCreated: ["a.ts"], filesEdited: [], toolCalls: 10, totalTokens: 500, lastUpdate: "now", sessionId: "s1",
    });

    const fetched = await stores.runStore.getRun("r1");
    expect(fetched!.activity.toolCalls).toBe(10);
    expect(fetched!.sessionId).toBe("s1");
  });

  it("deleteRun removes the record", async () => {
    await stores.runStore.upsertRun(makeRun("r1", "t1") as any);
    await stores.runStore.deleteRun("r1");
    expect(await stores.runStore.getRun("r1")).toBeUndefined();
  });

  it("updateResumeState round-trips the durable-turns checkpoint", async () => {
    await stores.runStore.upsertRun(makeRun("r-resume", "t-resume") as any);

    const checkpoint = {
      context: {},
      steps: [],
      loopName: "default",
      turn: 2,
      history: [
        { role: "user", content: "do the thing" },
        { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "bash", input: {} }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "bash", output: { type: "text", value: "ok" } }] },
      ],
      accumText: "working",
      createdAt: now,
      updatedAt: now,
    };
    await stores.runStore.updateResumeState!("r-resume", checkpoint as any);

    const fetched = await stores.runStore.getRun("r-resume");
    expect(fetched!.resumeState).toBeDefined();
    expect(fetched!.resumeState).toMatchObject({ loopName: "default", turn: 2, accumText: "working" });
    expect(fetched!.resumeState!.history).toHaveLength(3);

    // Recovery reads active runs — the checkpoint must ride along.
    const active = await stores.runStore.getActiveRuns();
    expect(active.find((r) => r.id === "r-resume")!.resumeState!.turn).toBe(2);
  });

  it("upsertRun on conflict preserves an existing resume checkpoint", async () => {
    await stores.runStore.upsertRun(makeRun("r-keep", "t-keep") as any);
    await stores.runStore.updateResumeState!("r-keep", {
      context: {}, steps: [], loopName: "default", turn: 1,
      history: [{ role: "user", content: "hi" }],
      createdAt: now, updatedAt: now,
    } as any);

    // A later upsert without resumeState (e.g. runner re-registering its
    // PID) must not clobber a checkpoint written in between.
    await stores.runStore.upsertRun({ ...makeRun("r-keep", "t-keep"), pid: 4242 } as any);

    const fetched = await stores.runStore.getRun("r-keep");
    expect(fetched!.pid).toBe(4242);
    expect(fetched!.resumeState).toBeDefined();
    expect(fetched!.resumeState!.turn).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// LoopRunStore — F2 dual-write + runs-backed shadow
// ═══════════════════════════════════════════════════════════════════════

describe("DrizzleLoopRunStore — dual-write + runs-backed (F2)", () => {
  const loopInput = (id: string) => ({ id, loop: { name: "review" }, agentName: "chat", sessionId: "s1" });

  it("dual-write: createRun round-trips (reads legacy) and shadows into runs with engine='graph'", async () => {
    const created = await stores.loopRunStore.createRun(loopInput("looprun-a") as any);
    expect(created.loopName).toBe("review");
    expect((await stores.loopRunStore.getRun("looprun-a"))?.id).toBe("looprun-a");

    // Shadow: the runs table has the same record, tagged engine="graph".
    const { runsSqlite } = await import("../schema/runs.js");
    const { eq } = await import("drizzle-orm");
    const shadow: any[] = await db.select().from(runsSqlite).where(eq(runsSqlite.id, "looprun-a"));
    expect(shadow).toHaveLength(1);
    expect(shadow[0].engine).toBe("graph");
    expect(shadow[0].loopName).toBe("review");
    expect(shadow[0].adapterType).toBe("loop");

    // Invisible to task-run queries.
    expect((await stores.runStore.getActiveRuns()).map((r) => r.id)).not.toContain("looprun-a");
  });

  it("runs-backed store: resume round-trips via resume_state; listRuns excludes task rows", async () => {
    const { DrizzleLoopRunStore } = await import("../stores/loop-run-store.js");
    const { runsSqlite } = await import("../schema/runs.js");
    const runsBacked = new DrizzleLoopRunStore(db, runsSqlite, "sqlite", true);

    await runsBacked.createRun(loopInput("looprun-b") as any);
    await runsBacked.updateRun("looprun-b", { resume: { context: {}, steps: [], createdAt: "2026-01-01T00:00:00Z", accumText: "hi" } as any });
    expect(((await runsBacked.getRun("looprun-b"))?.resume as any)?.accumText).toBe("hi");

    await stores.runStore.upsertRun({
      id: "task-x", taskId: "tx", pid: 0, agentName: "a", status: "running",
      startedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
      activity: { filesCreated: [], filesEdited: [], toolCalls: 0, totalTokens: 0, lastUpdate: "" },
      configPath: "/tmp/c.json",
    } as any);
    const list = await runsBacked.listRuns();
    expect(list.map((r) => r.id)).toContain("looprun-b");
    expect(list.map((r) => r.id)).not.toContain("task-x");
  });

  it("dual-write appendTrace + updateRun sync the read side", async () => {
    await stores.loopRunStore.createRun(loopInput("looprun-c") as any);
    await stores.loopRunStore.appendTrace("looprun-c", { type: "loop:start" } as any);
    await stores.loopRunStore.updateRun("looprun-c", { status: "completed" as any });
    const fetched = await stores.loopRunStore.getRun("looprun-c");
    expect(fetched?.status).toBe("completed");
    expect(fetched?.trace).toHaveLength(1);
  });

  it("round-trips projected loop data and Channel presentation on both stores", async () => {
    const { DrizzleLoopRunStore } = await import("../stores/loop-run-store.js");
    const { runsSqlite } = await import("../schema/runs.js");
    const runsBacked = new DrizzleLoopRunStore(db, runsSqlite, "sqlite", true);
    const result = { summary: "Updated CTA", revisionId: "revision-1" };
    const presentation = {
      text: "The preview is ready.",
      actions: [{ id: "preview", type: "open_url", label: "Open preview", url: "https://example.com/preview" }],
    } as const;

    await stores.loopRunStore.createRun(loopInput("looprun-projected-legacy") as any);
    await stores.loopRunStore.updateRun("looprun-projected-legacy", { result, presentation });
    expect(await stores.loopRunStore.getRun("looprun-projected-legacy")).toMatchObject({
      result,
      presentation,
    });

    await runsBacked.createRun(loopInput("looprun-projected-unified") as any);
    await runsBacked.updateRun("looprun-projected-unified", { result, presentation });
    expect(await runsBacked.getRun("looprun-projected-unified")).toMatchObject({
      result,
      presentation,
    });
  });

  it("preserves terminal status and every trace event under concurrent writes", async () => {
    const { DrizzleLoopRunStore } = await import("../stores/loop-run-store.js");
    const { runsSqlite } = await import("../schema/runs.js");
    const runsBacked = new DrizzleLoopRunStore(db, runsSqlite, "sqlite", true);
    await runsBacked.createRun(loopInput("looprun-concurrent") as any);

    const events = Array.from({ length: 24 }, (_, index) => ({
      id: `trace-${index}`,
      type: "sandbox.released",
      data: { index },
    }));
    await Promise.all([
      runsBacked.updateRun("looprun-concurrent", {
        status: "completed" as any,
        completedAt: "2026-08-25T19:40:00.000Z",
      }),
      ...events.map((event) => runsBacked.appendTrace("looprun-concurrent", event as any)),
    ]);

    const fetched = await runsBacked.getRun("looprun-concurrent");
    expect(fetched?.status).toBe("completed");
    expect(fetched?.completedAt).toBe("2026-08-25T19:40:00.000Z");
    expect(fetched?.trace).toHaveLength(events.length);
    expect(new Set(fetched?.trace.map((event) => event.id))).toEqual(
      new Set(events.map((event) => event.id)),
    );
  });

  it("appends a trace event idempotently without reopening a terminal run", async () => {
    const { DrizzleLoopRunStore } = await import("../stores/loop-run-store.js");
    const { runsSqlite } = await import("../schema/runs.js");
    const runsBacked = new DrizzleLoopRunStore(db, runsSqlite, "sqlite", true);
    await runsBacked.createRun(loopInput("looprun-idempotent") as any);
    await runsBacked.updateRun("looprun-idempotent", {
      status: "failed" as any,
      error: "provider timeout",
      completedAt: "2026-08-25T19:40:00.000Z",
    });
    const event = {
      id: "sandbox-release-1",
      type: "sandbox.released",
      data: { outcome: "destroyed" },
    } as any;

    await Promise.all([
      runsBacked.appendTrace("looprun-idempotent", event),
      runsBacked.appendTrace("looprun-idempotent", event),
      runsBacked.appendTrace("looprun-idempotent", event),
    ]);

    const fetched = await runsBacked.getRun("looprun-idempotent");
    expect(fetched?.status).toBe("failed");
    expect(fetched?.error).toBe("provider timeout");
    expect(fetched?.trace).toEqual([event]);
  });

  it("backfillLoopRunsIntoRuns copies historical loop_runs into runs, idempotently (F2 PR3)", async () => {
    const { DrizzleLoopRunStore } = await import("../stores/loop-run-store.js");
    const { backfillLoopRunsIntoRuns } = await import("../backfill.js");
    const { loopRunsSqlite } = await import("../schema/loop-runs.js");
    const { runsSqlite } = await import("../schema/runs.js");
    const { eq } = await import("drizzle-orm");

    // A legacy-only loop run (write straight to loop_runs, bypassing the shadow).
    const legacy = new DrizzleLoopRunStore(db, loopRunsSqlite, "sqlite");
    await legacy.createRun({ id: "hist-1", loop: { name: "old" }, agentName: "chat" } as any);
    await legacy.updateRun("hist-1", { status: "awaiting_approval" as any, resume: { context: {}, steps: [], createdAt: "t", accumText: "x" } as any });
    expect(await db.select().from(runsSqlite).where(eq(runsSqlite.id, "hist-1"))).toHaveLength(0);

    await backfillLoopRunsIntoRuns(db, "sqlite");

    const rows: any[] = await db.select().from(runsSqlite).where(eq(runsSqlite.id, "hist-1"));
    expect(rows).toHaveLength(1);
    expect(rows[0].engine).toBe("graph");
    expect(rows[0].status).toBe("awaiting_approval");
    expect(rows[0].loopName).toBe("old");
    // resume folded into resume_state.
    const runsBacked = new DrizzleLoopRunStore(db, runsSqlite, "sqlite", true);
    expect(((await runsBacked.getRun("hist-1"))?.resume as any)?.accumText).toBe("x");

    // Idempotent — re-run inserts nothing new.
    await backfillLoopRunsIntoRuns(db, "sqlite");
    expect(await db.select().from(runsSqlite).where(eq(runsSqlite.id, "hist-1"))).toHaveLength(1);
  });

  it("after the PR4 flip, reads come from the shadow (runs), not legacy", async () => {
    const { DrizzleLoopRunStore, DualWriteLoopRunStore } = await import("../stores/loop-run-store.js");
    const { loopRunsSqlite } = await import("../schema/loop-runs.js");
    const { runsSqlite } = await import("../schema/runs.js");
    const legacy = new DrizzleLoopRunStore(db, loopRunsSqlite, "sqlite");
    const shadow = new DrizzleLoopRunStore(db, runsSqlite, "sqlite", true);
    const store = new DualWriteLoopRunStore(legacy, shadow, "shadow");

    await store.createRun({ id: "lr-flip", loop: { name: "review" }, agentName: "chat" } as any);
    // Diverge the two tables: legacy stays running, shadow completes.
    await legacy.updateRun("lr-flip", { status: "running" as any });
    await shadow.updateRun("lr-flip", { status: "completed" as any });

    // readFrom="shadow" → the dual-write store returns the shadow's value.
    expect((await store.getRun("lr-flip"))?.status).toBe("completed");
    expect((await store.listRuns()).find((r) => r.id === "lr-flip")?.status).toBe("completed");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SessionStore
// ═══════════════════════════════════════════════════════════════════════

describe("DrizzleSessionStore", () => {
  it("create + getSession", async () => {
    const id = await stores.sessionStore.create({ title: "My Session" });
    const session = await stores.sessionStore.getSession(id);
    expect(session).toBeDefined();
    expect(session!.title).toBe("My Session");
    expect(session!.messageCount).toBe(0);
  });

  it("addMessage + getMessages", async () => {
    const sid = await stores.sessionStore.create();
    await stores.sessionStore.addMessage(sid, "user", "Hello");
    await stores.sessionStore.addMessage(sid, "assistant", "Hi there");

    const msgs = await stores.sessionStore.getMessages(sid);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("user");
    expect(msgs[1].content).toBe("Hi there");
  });

  it("getRecentMessages returns last N", async () => {
    const sid = await stores.sessionStore.create();
    await stores.sessionStore.addMessage(sid, "user", "1");
    await new Promise((r) => setTimeout(r, 5));
    await stores.sessionStore.addMessage(sid, "assistant", "2");
    await new Promise((r) => setTimeout(r, 5));
    await stores.sessionStore.addMessage(sid, "user", "3");

    const recent = await stores.sessionStore.getRecentMessages(sid, 2);
    expect(recent).toHaveLength(2);
    expect(recent[0].content).toBe("2");
    expect(recent[1].content).toBe("3");
  });

  it("listSessions includes messageCount", async () => {
    const s1 = await stores.sessionStore.create({ title: "S1" });
    await stores.sessionStore.addMessage(s1, "user", "msg1");
    await stores.sessionStore.addMessage(s1, "assistant", "msg2");
    await stores.sessionStore.create({ title: "S2" });

    const list = await stores.sessionStore.listSessions();
    expect(list).toHaveLength(2);
    const withMessages = list.find((s) => s.title === "S1");
    expect(withMessages!.messageCount).toBe(2);
  });

  it("create with user + metadata persists both", async () => {
    const id = await stores.sessionStore.create({
      title: "Tagged",
      user: "u-42",
      metadata: { tenant: "acme", plan: "premium" },
    });
    const session = await stores.sessionStore.getSession(id);
    expect(session).toBeDefined();
    expect(session!.user).toBe("u-42");
    expect(session!.metadata).toEqual({ tenant: "acme", plan: "premium" });
  });

  it("listSessions filters by user", async () => {
    await stores.sessionStore.create({ title: "S-u1-a", user: "u1" });
    await stores.sessionStore.create({ title: "S-u1-b", user: "u1" });
    await stores.sessionStore.create({ title: "S-u2", user: "u2" });
    await stores.sessionStore.create({ title: "S-no-user" });

    const u1 = await stores.sessionStore.listSessions({ user: "u1" });
    expect(u1).toHaveLength(2);
    expect(u1.every((s) => s.user === "u1")).toBe(true);

    const u2 = await stores.sessionStore.listSessions({ user: "u2" });
    expect(u2).toHaveLength(1);
    expect(u2[0].title).toBe("S-u2");
  });

  it("listSessions filters by metadata (single key)", async () => {
    await stores.sessionStore.create({
      title: "Acme-prod",
      metadata: { tenant: "acme", env: "prod" },
    });
    await stores.sessionStore.create({
      title: "Acme-dev",
      metadata: { tenant: "acme", env: "dev" },
    });
    await stores.sessionStore.create({
      title: "Other",
      metadata: { tenant: "globex" },
    });

    const acme = await stores.sessionStore.listSessions({
      metadata: { tenant: "acme" },
    });
    expect(acme).toHaveLength(2);

    const acmeProd = await stores.sessionStore.listSessions({
      metadata: { tenant: "acme", env: "prod" },
    });
    expect(acmeProd).toHaveLength(1);
    expect(acmeProd[0].title).toBe("Acme-prod");
  });

  it("renameSession updates title", async () => {
    const id = await stores.sessionStore.create({ title: "Old" });
    const ok = await stores.sessionStore.renameSession(id, "New");
    expect(ok).toBe(true);

    const session = await stores.sessionStore.getSession(id);
    expect(session!.title).toBe("New");
  });

  it("deleteSession cascade-deletes messages", async () => {
    const id = await stores.sessionStore.create({ title: "Del" });
    await stores.sessionStore.addMessage(id, "user", "msg");
    const ok = await stores.sessionStore.deleteSession(id);
    expect(ok).toBe(true);

    expect(await stores.sessionStore.getSession(id)).toBeUndefined();
    expect(await stores.sessionStore.getMessages(id)).toEqual([]);
  });

  it("prune keeps the N most recent sessions", async () => {
    await stores.sessionStore.create({ title: "Old" });
    await stores.sessionStore.create({ title: "New" });

    const pruned = await stores.sessionStore.prune(1);
    expect(pruned).toBe(1);

    const list = await stores.sessionStore.listSessions();
    expect(list).toHaveLength(1);
  });

  it("getLatestSession returns most recently updated", async () => {
    await stores.sessionStore.create({ title: "First" });
    await new Promise((r) => setTimeout(r, 5));
    const id2 = await stores.sessionStore.create({ title: "Second" });

    const latest = await stores.sessionStore.getLatestSession();
    expect(latest).toBeDefined();
    expect(latest!.id).toBe(id2);
  });

  it("updateMessage changes content", async () => {
    const sid = await stores.sessionStore.create();
    const msg = await stores.sessionStore.addMessage(sid, "assistant", "draft");
    const ok = await stores.sessionStore.updateMessage(sid, msg.id, "final");
    expect(ok).toBe(true);

    const msgs = await stores.sessionStore.getMessages(sid);
    expect(msgs[0].content).toBe("final");
  });

  it("updateMessage persists assistant suggestions", async () => {
    const sid = await stores.sessionStore.create();
    const msg = await stores.sessionStore.addMessage(sid, "assistant", "draft");
    const suggestions = [{
      id: "suggestion_tests",
      label: "Add tests",
      prompt: "Add tests for this change.",
    }];
    const ok = await stores.sessionStore.updateMessage(
      sid,
      msg.id,
      "final",
      undefined,
      suggestions,
    );
    expect(ok).toBe(true);

    const messages = await stores.sessionStore.getMessages(sid);
    expect(messages[0]?.suggestions).toEqual(suggestions);
  });

  it("addMessage with ContentPart[] round-trips correctly", async () => {
    const sid = await stores.sessionStore.create();
    const parts = [
      { type: "text" as const, text: "Check this image" },
      { type: "image_url" as const, image_url: { url: "https://example.com/img.png", detail: "auto" } },
      { type: "file" as const, file_id: "att_abc123" },
    ];
    const msg = await stores.sessionStore.addMessage(sid, "user", parts);
    expect(msg.content).toEqual(parts);

    const msgs = await stores.sessionStore.getMessages(sid);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toEqual(parts);
    expect(Array.isArray(msgs[0].content)).toBe(true);
  });

  it("updateMessage with ContentPart[] round-trips correctly", async () => {
    const sid = await stores.sessionStore.create();
    const msg = await stores.sessionStore.addMessage(sid, "assistant", "draft");
    const parts = [
      { type: "text" as const, text: "Updated with parts" },
      { type: "file" as const, file_id: "att_xyz789" },
    ];
    const ok = await stores.sessionStore.updateMessage(sid, msg.id, parts);
    expect(ok).toBe(true);

    const msgs = await stores.sessionStore.getMessages(sid);
    expect(msgs[0].content).toEqual(parts);
  });

  it("plain string content still reads back as string", async () => {
    const sid = await stores.sessionStore.create();
    await stores.sessionStore.addMessage(sid, "user", "just a string");

    const msgs = await stores.sessionStore.getMessages(sid);
    expect(msgs[0].content).toBe("just a string");
    expect(typeof msgs[0].content).toBe("string");
  });

  it("atomically prepares a client-tool continuation and projects the resolved call", async () => {
    const sid = await stores.sessionStore.create({
      agent: "leo",
      user: "user-1",
      scope: { key: "site-1", version: "3" },
    });
    await stores.sessionStore.addMessage(sid, "user", "Build a booking site");
    const assistant = await stores.sessionStore.addMessage(sid, "assistant", "");
    await stores.sessionStore.updateMessage(sid, assistant.id, "", [{
      id: "call-1",
      name: "configure_site_module",
      arguments: { module: "booking" },
      state: "interrupted",
    }]);

    const prepared = await stores.sessionStore.prepareContinuation!({
      sessionId: sid,
      agent: "leo",
      user: "user-1",
      scope: { key: "site-1", version: "3" },
      toolCallId: "call-1",
      result: "{\"configured\":true}",
      expectedSessionVersion: 2,
      idempotencyKey: "continue-1",
      fingerprint: "sha256:one",
      runId: "chatcmpl-loop-1",
    });

    expect(prepared).toMatchObject({
      status: "prepared",
      sessionVersion: 3,
      runId: "chatcmpl-loop-1",
    });
    expect(prepared.messages.at(-1)).toMatchObject({
      role: "tool",
      toolCallId: "call-1",
    });
    expect(prepared.messages[1]?.toolCalls?.[0]).toMatchObject({
      id: "call-1",
      state: "completed",
      result: "{\"configured\":true}",
    });
    await expect(stores.sessionStore.getSession(sid)).resolves.toMatchObject({
      version: 3,
    });
  });

  it("replays the same continuation and rejects idempotency-key reuse", async () => {
    const sid = await stores.sessionStore.create({ agent: "leo" });
    const assistant = await stores.sessionStore.addMessage(sid, "assistant", "");
    await stores.sessionStore.updateMessage(sid, assistant.id, "", [{
      id: "call-1",
      name: "configure",
      state: "interrupted",
    }]);
    const input = {
      sessionId: sid,
      agent: "leo",
      toolCallId: "call-1",
      result: "ok",
      expectedSessionVersion: 1,
      idempotencyKey: "continue-1",
      fingerprint: "sha256:one",
      runId: "run-1",
    };

    await expect(stores.sessionStore.prepareContinuation!(input)).resolves.toMatchObject({
      status: "prepared",
    });
    await expect(stores.sessionStore.prepareContinuation!(input)).resolves.toMatchObject({
      status: "replay",
      runId: "run-1",
      sessionVersion: 2,
    });
    await expect(stores.sessionStore.prepareContinuation!({
      ...input,
      agent: "other-agent",
    })).rejects.toMatchObject({ code: "continuation_scope_mismatch" });
    await expect(stores.sessionStore.prepareContinuation!({
      ...input,
      fingerprint: "sha256:different",
    })).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("rejects stale versions and trusted-scope changes without appending", async () => {
    const sid = await stores.sessionStore.create({
      agent: "leo",
      user: "user-1",
      scope: { key: "site-1", version: "3" },
    });
    const assistant = await stores.sessionStore.addMessage(sid, "assistant", "");
    await stores.sessionStore.updateMessage(sid, assistant.id, "", [{
      id: "call-1",
      name: "configure",
      state: "interrupted",
    }]);
    const base = {
      sessionId: sid,
      agent: "leo",
      user: "user-1",
      scope: { key: "site-1", version: "3" },
      toolCallId: "call-1",
      result: "ok",
      expectedSessionVersion: 1,
      idempotencyKey: "continue-1",
      fingerprint: "sha256:one",
      runId: "run-1",
    };

    await expect(stores.sessionStore.prepareContinuation!({
      ...base,
      expectedSessionVersion: 0,
    })).rejects.toMatchObject({ code: "session_version_conflict" });
    await expect(stores.sessionStore.prepareContinuation!({
      ...base,
      scope: { key: "site-2", version: "3" },
    })).rejects.toMatchObject({ code: "continuation_scope_mismatch" });
    expect(await stores.sessionStore.getMessages(sid)).toHaveLength(1);
  });

  it("allows only one concurrent continuation for the same pending call", async () => {
    const sid = await stores.sessionStore.create({ agent: "leo" });
    const assistant = await stores.sessionStore.addMessage(sid, "assistant", "");
    await stores.sessionStore.updateMessage(sid, assistant.id, "", [{
      id: "call-1",
      name: "configure",
      state: "interrupted",
    }]);
    const makeInput = (suffix: string) => ({
      sessionId: sid,
      agent: "leo",
      toolCallId: "call-1",
      result: suffix,
      expectedSessionVersion: 1,
      idempotencyKey: `continue-${suffix}`,
      fingerprint: `sha256:${suffix}`,
      runId: `run-${suffix}`,
    });

    const outcomes = await Promise.allSettled([
      stores.sessionStore.prepareContinuation!(makeInput("a")),
      stores.sessionStore.prepareContinuation!(makeInput("b")),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(await stores.sessionStore.getMessages(sid)).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// ModelInvocationStore
// ═══════════════════════════════════════════════════════════════════════

describe("DrizzleModelInvocationStore", () => {
  it("append + get round-trips a normalized model invocation", async () => {
    const createdAt = new Date("2026-07-15T10:00:00.000Z");

    const saved = await stores.modelInvocationStore.append({
      id: "inv-1",
      projectId: "project-1",
      orgId: "org-1",
      runId: "run-1",
      sessionId: "session-1",
      turnId: "turn-1",
      agentName: "assistant",
      externalUser: "user-1",
      mode: "gateway",
      operation: "chat",
      requestedProvider: "anthropic",
      requestedModel: "claude-sonnet-5",
      resolvedProvider: "anthropic",
      resolvedModel: "claude-sonnet-5",
      finalProvider: "anthropic",
      attemptIndex: 0,
      attemptCount: 1,
      generationId: "gen-1",
      credentialType: "platform",
      status: "succeeded",
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 5,
      cachedTokens: 10,
      estimatedCostUsd: 0.03,
      billableCostUsd: 0.03,
      costSource: "gateway-metadata",
      billingOwner: "platform",
      rawMetadata: { gateway: { generationId: "gen-1" } },
      createdAt,
    });

    expect(saved.id).toBe("inv-1");
    expect(saved.createdAt?.toISOString()).toBe(createdAt.toISOString());

    const fetched = await stores.modelInvocationStore.get("inv-1");
    expect(fetched).toMatchObject({
      projectId: "project-1",
      runId: "run-1",
      mode: "gateway",
      operation: "chat",
      requestedModel: "claude-sonnet-5",
      billingOwner: "platform",
      rawMetadata: { gateway: { generationId: "gen-1" } },
    });
  });

  it("lists filtered invocations newest first", async () => {
    await stores.modelInvocationStore.append({
      id: "inv-old",
      projectId: "project-1",
      runId: "run-1",
      mode: "provider",
      operation: "audio.transcribe",
      requestedModel: "nova-2",
      status: "succeeded",
      costSource: "none",
      billingOwner: "external",
      createdAt: new Date("2026-07-15T09:00:00.000Z"),
    });
    await stores.modelInvocationStore.append({
      id: "inv-new",
      projectId: "project-1",
      runId: "run-1",
      mode: "gateway",
      operation: "chat",
      requestedModel: "gpt-4o",
      status: "succeeded",
      costSource: "gateway-metadata",
      billingOwner: "platform",
      createdAt: new Date("2026-07-15T10:00:00.000Z"),
    });
    await stores.modelInvocationStore.append({
      id: "inv-other",
      projectId: "project-2",
      runId: "run-2",
      mode: "gateway",
      operation: "chat",
      requestedModel: "gpt-4o",
      status: "failed",
      errorClass: "auth",
      costSource: "none",
      billingOwner: "external",
      createdAt: new Date("2026-07-15T11:00:00.000Z"),
    });

    const runItems = await stores.modelInvocationStore.list({ projectId: "project-1", runId: "run-1" });
    expect(runItems.map((item) => item.id)).toEqual(["inv-new", "inv-old"]);

    const limitedGateway = await stores.modelInvocationStore.list({ mode: "gateway", limit: 1 });
    expect(limitedGateway.map((item) => item.id)).toEqual(["inv-other"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// LogStore
// ═══════════════════════════════════════════════════════════════════════

describe("DrizzleLogStore", () => {
  it("startSession + append + getSessionEntries", async () => {
    const sid = await stores.logStore.startSession();
    expect(sid).toBeDefined();

    await stores.logStore.append({ ts: "2025-01-01T00:00:00Z", event: "task:started", data: { taskId: "t1" } });
    await stores.logStore.append({ ts: "2025-01-01T00:01:00Z", event: "task:done", data: { taskId: "t1" } });

    const entries = await stores.logStore.getSessionEntries(sid);
    expect(entries).toHaveLength(2);
    expect(entries[0].event).toBe("task:started");
    expect(entries[1].event).toBe("task:done");
  });

  it("getSessionId returns current", async () => {
    expect(await stores.logStore.getSessionId()).toBeUndefined();
    const sid = await stores.logStore.startSession();
    expect(await stores.logStore.getSessionId()).toBe(sid);
  });

  it("listSessions returns sessions with entry count", async () => {
    await stores.logStore.startSession();
    await stores.logStore.append({ ts: "2025-01-01T00:00:00Z", event: "e1", data: null });
    await stores.logStore.append({ ts: "2025-01-01T00:01:00Z", event: "e2", data: null });

    const sessions = await stores.logStore.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].entries).toBe(2);
  });

  it("auto-creates session on append if none started", async () => {
    await stores.logStore.append({ ts: "2025-01-01T00:00:00Z", event: "auto", data: null });
    const sid = await stores.logStore.getSessionId();
    expect(sid).toBeDefined();

    const entries = await stores.logStore.getSessionEntries(sid!);
    expect(entries).toHaveLength(1);
  });

  it("prune removes old sessions", async () => {
    await stores.logStore.startSession();
    await stores.logStore.append({ ts: "2025-01-01T00:00:00Z", event: "old", data: null });
    await stores.logStore.startSession();
    await stores.logStore.append({ ts: "2025-01-02T00:00:00Z", event: "new", data: null });

    const pruned = await stores.logStore.prune(1);
    expect(pruned).toBe(1);
    expect(await stores.logStore.listSessions()).toHaveLength(1);
  });

  it("createLogStore returns independent instances over the same db (no session hijack)", async () => {
    // One dedicated instance per consumer (e.g. per in-process task run):
    // each keeps its OWN current session…
    const a = stores.createLogStore!();
    const b = stores.createLogStore!();
    const sessA = await a.startSession();
    const sessB = await b.startSession();
    expect(sessA).not.toBe(sessB);

    await a.append({ ts: "2025-01-01T00:00:00Z", event: "from-a", data: null });
    await b.append({ ts: "2025-01-01T00:00:01Z", event: "from-b", data: null });

    expect((await a.getSessionEntries()).map(e => e.event)).toEqual(["from-a"]);
    expect((await b.getSessionEntries()).map(e => e.event)).toEqual(["from-b"]);

    // …while the shared bundle logStore's current session is untouched,
    // and all sessions live in the same database (cross-readable by id).
    expect(await stores.logStore.getSessionId()).toBeUndefined();
    expect((await stores.logStore.getSessionEntries(sessB)).map(e => e.event)).toEqual(["from-b"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// ApprovalStore
// ═══════════════════════════════════════════════════════════════════════

describe("DrizzleApprovalStore", () => {
  const makeApproval = (id: string, overrides: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
    id,
    gateId: "gate-1",
    gateName: "Deploy Gate",
    taskId: "t1",
    status: "pending",
    payload: null,
    requestedAt: new Date().toISOString(),
    ...overrides,
  });

  it("upsert + get round-trip", async () => {
    const req = makeApproval("a1");
    await stores.approvalStore.upsert(req);

    const fetched = await stores.approvalStore.get("a1");
    expect(fetched).toBeDefined();
    expect(fetched!.gateName).toBe("Deploy Gate");
    expect(fetched!.status).toBe("pending");
  });

  it("upsert updates on conflict", async () => {
    await stores.approvalStore.upsert(makeApproval("a1"));
    await stores.approvalStore.upsert(makeApproval("a1", {
      status: "approved",
      resolvedBy: "admin",
      resolvedAt: new Date().toISOString(),
    }));

    const fetched = await stores.approvalStore.get("a1");
    expect(fetched!.status).toBe("approved");
    expect(fetched!.resolvedBy).toBe("admin");
  });

  it("list filters by status", async () => {
    await stores.approvalStore.upsert(makeApproval("a1", { status: "pending" }));
    await stores.approvalStore.upsert(makeApproval("a2", { status: "approved" }));

    const pending = await stores.approvalStore.list("pending");
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe("a1");
  });

  it("listByTask filters by taskId", async () => {
    await stores.approvalStore.upsert(makeApproval("a1", { taskId: "t1" }));
    await stores.approvalStore.upsert(makeApproval("a2", { taskId: "t2" }));

    const t1 = await stores.approvalStore.listByTask("t1");
    expect(t1).toHaveLength(1);
    expect(t1[0].id).toBe("a1");
  });

  it("delete removes", async () => {
    await stores.approvalStore.upsert(makeApproval("a1"));
    const ok = await stores.approvalStore.delete("a1");
    expect(ok).toBe(true);
    expect(await stores.approvalStore.get("a1")).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// MemoryStore
// ═══════════════════════════════════════════════════════════════════════

describe("DrizzleMemoryStore", () => {
  it("starts empty", async () => {
    expect(await stores.memoryStore.exists()).toBe(false);
    expect(await stores.memoryStore.get()).toBe("");
  });

  it("save + get round-trip", async () => {
    await stores.memoryStore.save("Hello world");
    expect(await stores.memoryStore.exists()).toBe(true);
    expect(await stores.memoryStore.get()).toBe("Hello world");
  });

  it("save overwrites", async () => {
    await stores.memoryStore.save("first");
    await stores.memoryStore.save("second");
    expect(await stores.memoryStore.get()).toBe("second");
  });

  it("append adds lines", async () => {
    await stores.memoryStore.append("line 1");
    await stores.memoryStore.append("line 2");
    expect(await stores.memoryStore.get()).toBe("line 1\nline 2");
  });

  it("update replaces text", async () => {
    await stores.memoryStore.save("foo bar baz");
    const result = await stores.memoryStore.update("bar", "qux");
    expect(result).toBe(true);
    expect(await stores.memoryStore.get()).toBe("foo qux baz");
  });

  it("update returns error string when text not found", async () => {
    await stores.memoryStore.save("hello");
    const result = await stores.memoryStore.update("missing", "new");
    expect(typeof result).toBe("string");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// CheckpointStore
// ═══════════════════════════════════════════════════════════════════════

describe("DrizzleCheckpointStore", () => {
  it("load returns empty state when nothing saved", async () => {
    const state = await stores.checkpointStore.load();
    expect(state).toEqual({ definitions: {}, active: {}, resumed: [] });
  });

  it("save + load round-trip", async () => {
    const state = {
      definitions: { "mission-1": [{ name: "review", afterTasks: ["Task A"], blocksTasks: ["Task B"] }] },
      active: { "mission-1:review": { checkpoint: { name: "review", afterTasks: ["Task A"], blocksTasks: ["Task B"] }, reachedAt: "2025-01-01T00:00:00Z" } },
      resumed: [],
    };
    await stores.checkpointStore.save(state);

    const loaded = await stores.checkpointStore.load();
    expect(loaded.definitions["mission-1"]).toHaveLength(1);
    expect(loaded.active["mission-1:review"]).toBeDefined();
  });

  it("removeGroup clears group-specific data", async () => {
    const cp1 = { name: "cp1", afterTasks: ["A"], blocksTasks: ["B"] };
    const cp2 = { name: "cp2", afterTasks: ["C"], blocksTasks: ["D"] };
    const state = {
      definitions: { "g1": [cp1], "g2": [cp2] },
      active: {
        "g1:cp1": { checkpoint: cp1, reachedAt: "now" },
        "g2:cp2": { checkpoint: cp2, reachedAt: "now" },
      },
      resumed: ["g1:cp1", "g2:cp2"],
    };
    await stores.checkpointStore.save(state);

    const next = await stores.checkpointStore.removeGroup(state, "g1");
    expect(next.definitions["g1"]).toBeUndefined();
    expect(next.definitions["g2"]).toBeDefined();
    expect(next.active["g1:cp1"]).toBeUndefined();
    expect(next.active["g2:cp2"]).toBeDefined();
    expect(next.resumed).toEqual(["g2:cp2"]);

    // Verify persisted
    const reloaded = await stores.checkpointStore.load();
    expect(reloaded.definitions["g1"]).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// DelayStore
// ═══════════════════════════════════════════════════════════════════════

describe("DrizzleDelayStore", () => {
  it("load returns empty state when nothing saved", async () => {
    const state = await stores.delayStore.load();
    expect(state).toEqual({ definitions: {}, active: {}, expired: [] });
  });

  it("save + load round-trip", async () => {
    const delay = { name: "cooldown", duration: "PT5M", afterTasks: ["Task A"], blocksTasks: ["Task B"] };
    const state = {
      definitions: { "mission-1": [delay] },
      active: { "mission-1:cooldown": { delay, startedAt: "2025-01-01T00:00:00Z", expiresAt: "2025-01-01T00:05:00Z" } },
      expired: [],
    };
    await stores.delayStore.save(state);

    const loaded = await stores.delayStore.load();
    expect(loaded.definitions["mission-1"]).toHaveLength(1);
    expect(loaded.active["mission-1:cooldown"]).toBeDefined();
  });

  it("removeGroup clears group-specific data", async () => {
    const d1 = { name: "d1", duration: "PT5M", afterTasks: ["A"], blocksTasks: ["B"] };
    const d2 = { name: "d2", duration: "PT10M", afterTasks: ["C"], blocksTasks: ["D"] };
    const state = {
      definitions: { "g1": [d1], "g2": [d2] },
      active: {
        "g1:d1": { delay: d1, startedAt: "now", expiresAt: "later" },
        "g2:d2": { delay: d2, startedAt: "now", expiresAt: "later" },
      },
      expired: ["g1:d1", "g2:d2"],
    };
    await stores.delayStore.save(state);

    const next = await stores.delayStore.removeGroup(state, "g1");
    expect(next.definitions["g1"]).toBeUndefined();
    expect(next.active["g1:d1"]).toBeUndefined();
    expect(next.expired).toEqual(["g2:d2"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// ConfigStore
// ═══════════════════════════════════════════════════════════════════════

describe("DrizzleConfigStore", () => {
  it("exists returns false initially", async () => {
    expect(await stores.configStore.exists()).toBe(false);
  });

  it("save + get round-trip", async () => {
    const config = {
      settings: { storage: "postgres" as const, model: "claude-sonnet-4-20250514" },
    } as any;

    await stores.configStore.save(config);
    expect(await stores.configStore.exists()).toBe(true);

    const loaded = await stores.configStore.get();
    expect(loaded).toBeDefined();
    expect(loaded!.settings.storage).toBe("postgres");
  });

  it("save overwrites previous config", async () => {
    await stores.configStore.save({ settings: { workDir: "/old" } } as any);
    await stores.configStore.save({ settings: { workDir: "/new" } } as any);

    const loaded = await stores.configStore.get();
    expect(loaded!.settings.workDir).toBe("/new");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// TeamStore
// ═══════════════════════════════════════════════════════════════════════

describe("DrizzleTeamStore", () => {
  it("createTeam + getTeam round-trip", async () => {
    const team = await stores.teamStore.createTeam({ name: "alpha", agents: [] });
    expect(team.name).toBe("alpha");
    expect(team.agents).toEqual([]);

    const fetched = await stores.teamStore.getTeam("alpha");
    expect(fetched).toBeDefined();
    expect(fetched!.name).toBe("alpha");
  });

  it("getTeams returns all teams", async () => {
    await stores.teamStore.createTeam({ name: "alpha", agents: [] });
    await stores.teamStore.createTeam({ name: "beta", agents: [] });

    const teams = await stores.teamStore.getTeams();
    expect(teams).toHaveLength(2);
    const names = teams.map(t => t.name).sort();
    expect(names).toEqual(["alpha", "beta"]);
  });

  it("createTeam rejects duplicates", async () => {
    await stores.teamStore.createTeam({ name: "alpha", agents: [] });
    await expect(stores.teamStore.createTeam({ name: "alpha", agents: [] })).rejects.toThrow(/already exists/);
  });

  it("updateTeam merges description", async () => {
    await stores.teamStore.createTeam({ name: "alpha", agents: [], description: "old" });
    const updated = await stores.teamStore.updateTeam("alpha", { description: "new" });
    expect(updated.description).toBe("new");
  });

  it("renameTeam updates team and agent foreign keys", async () => {
    await stores.teamStore.createTeam({ name: "old-name", agents: [] });
    await stores.agentStore.createAgent({ name: "claude" } as any, "old-name");

    const renamed = await stores.teamStore.renameTeam("old-name", "new-name");
    expect(renamed.name).toBe("new-name");

    // Old name should not exist
    expect(await stores.teamStore.getTeam("old-name")).toBeUndefined();

    // Agent should be under the new team
    const agentTeam = await stores.agentStore.getAgentTeam("claude");
    expect(agentTeam).toBe("new-name");
  });

  it("deleteTeam cascade-deletes agents", async () => {
    await stores.teamStore.createTeam({ name: "alpha", agents: [] });
    await stores.agentStore.createAgent({ name: "claude" } as any, "alpha");

    const ok = await stores.teamStore.deleteTeam("alpha");
    expect(ok).toBe(true);

    expect(await stores.teamStore.getTeam("alpha")).toBeUndefined();
    expect(await stores.agentStore.getAgent("claude")).toBeUndefined();
  });

  it("deleteTeam returns false for non-existent", async () => {
    expect(await stores.teamStore.deleteTeam("ghost")).toBe(false);
  });

  it("seed skips existing teams", async () => {
    await stores.teamStore.createTeam({ name: "alpha", description: "original", agents: [] });
    await stores.teamStore.seed([
      { name: "alpha", description: "overwrite?", agents: [] },
      { name: "beta", agents: [] },
    ]);

    const alpha = await stores.teamStore.getTeam("alpha");
    expect(alpha!.description).toBe("original"); // not overwritten

    const beta = await stores.teamStore.getTeam("beta");
    expect(beta).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// AgentStore
// ═══════════════════════════════════════════════════════════════════════

describe("DrizzleAgentStore", () => {
  beforeEach(async () => {
    // Need a team to attach agents to
    await stores.teamStore.createTeam({ name: "alpha", agents: [] });
  });

  it("createAgent + getAgent round-trip", async () => {
    const agent = await stores.agentStore.createAgent({ name: "claude", role: "coder" } as any, "alpha");
    expect(agent.name).toBe("claude");
    expect(agent.role).toBe("coder");

    const fetched = await stores.agentStore.getAgent("claude");
    expect(fetched).toBeDefined();
    expect(fetched!.role).toBe("coder");
  });

  it("getAgents with and without team filter", async () => {
    await stores.teamStore.createTeam({ name: "beta", agents: [] });
    await stores.agentStore.createAgent({ name: "claude" } as any, "alpha");
    await stores.agentStore.createAgent({ name: "gpt" } as any, "beta");

    const all = await stores.agentStore.getAgents();
    expect(all).toHaveLength(2);

    const alphaOnly = await stores.agentStore.getAgents("alpha");
    expect(alphaOnly).toHaveLength(1);
    expect(alphaOnly[0].name).toBe("claude");
  });

  it("getAgentTeam returns team name", async () => {
    await stores.agentStore.createAgent({ name: "claude" } as any, "alpha");
    expect(await stores.agentStore.getAgentTeam("claude")).toBe("alpha");
    expect(await stores.agentStore.getAgentTeam("ghost")).toBeUndefined();
  });

  it("createAgent rejects duplicates", async () => {
    await stores.agentStore.createAgent({ name: "claude" } as any, "alpha");
    await expect(stores.agentStore.createAgent({ name: "claude" } as any, "alpha")).rejects.toThrow(/already exists/);
  });

  it("updateAgent merges fields", async () => {
    await stores.agentStore.createAgent({ name: "claude", role: "coder" } as any, "alpha");
    const updated = await stores.agentStore.updateAgent("claude", { role: "reviewer" });
    expect(updated.role).toBe("reviewer");
    expect(updated.name).toBe("claude");
  });

  it("does not persist legacy inline loop definitions on agents", async () => {
    await stores.agentStore.createAgent({
      name: "claude",
      assignedLoops: ["Coding Loop"],
      loops: { plan: { systemPrompt: "Plan" } },
      pipeline: { steps: [{ loop: "plan" }] },
    } as any, "alpha");

    const created = await stores.agentStore.getAgent("claude") as any;
    expect(created.assignedLoops).toEqual(["Coding Loop"]);
    expect(created.loops).toBeUndefined();
    expect(created.pipeline).toBeUndefined();

    const updated = await stores.agentStore.updateAgent("claude", {
      role: "coder",
      loops: { implement: { systemPrompt: "Build" } },
      pipeline: { steps: [{ loop: "implement" }] },
    } as any) as any;
    expect(updated.role).toBe("coder");
    expect(updated.loops).toBeUndefined();
    expect(updated.pipeline).toBeUndefined();
  });

  it("moveAgent changes team", async () => {
    await stores.teamStore.createTeam({ name: "beta", agents: [] });
    await stores.agentStore.createAgent({ name: "claude" } as any, "alpha");

    await stores.agentStore.moveAgent("claude", "beta");
    expect(await stores.agentStore.getAgentTeam("claude")).toBe("beta");
  });

  it("deleteAgent removes the agent", async () => {
    await stores.agentStore.createAgent({ name: "claude" } as any, "alpha");
    expect(await stores.agentStore.deleteAgent("claude")).toBe(true);
    expect(await stores.agentStore.getAgent("claude")).toBeUndefined();
    expect(await stores.agentStore.deleteAgent("ghost")).toBe(false);
  });

  it("seed skips existing agents", async () => {
    await stores.agentStore.createAgent({ name: "claude", role: "coder" } as any, "alpha");
    await stores.agentStore.seed([
      { name: "claude", role: "overwrite?", teamName: "alpha" } as any,
      { name: "gpt", role: "planner", teamName: "alpha" } as any,
    ]);

    const claude = await stores.agentStore.getAgent("claude");
    expect(claude!.role).toBe("coder"); // not overwritten

    const gpt = await stores.agentStore.getAgent("gpt");
    expect(gpt).toBeDefined();
    expect(gpt!.role).toBe("planner");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// VaultStore
// ═══════════════════════════════════════════════════════════════════════

describe("DrizzleVaultStore", () => {
  it("set + get round-trip with encryption", async () => {
    const entry = { type: "api_key" as const, credentials: { key: "sk-secret-123" } };
    await stores.vaultStore.set("claude", "openai", entry);

    const fetched = await stores.vaultStore.get("claude", "openai");
    expect(fetched).toBeDefined();
    expect(fetched!.type).toBe("api_key");
    expect(fetched!.credentials.key).toBe("sk-secret-123");
  });

  it("getAllForAgent returns map by service", async () => {
    await stores.vaultStore.set("claude", "openai", { type: "api_key" as const, credentials: { key: "k1" } });
    await stores.vaultStore.set("claude", "smtp", { type: "smtp" as const, credentials: { host: "mail.test" } });

    const all = await stores.vaultStore.getAllForAgent("claude");
    expect(Object.keys(all).sort()).toEqual(["openai", "smtp"]);
    expect(all.openai.credentials.key).toBe("k1");
  });

  it("set upserts on conflict", async () => {
    await stores.vaultStore.set("claude", "openai", { type: "api_key" as const, credentials: { key: "old" } });
    await stores.vaultStore.set("claude", "openai", { type: "api_key" as const, credentials: { key: "new" } });

    const fetched = await stores.vaultStore.get("claude", "openai");
    expect(fetched!.credentials.key).toBe("new");
  });

  it("patch merges credentials", async () => {
    await stores.vaultStore.set("claude", "smtp", { type: "smtp" as const, credentials: { host: "mail.test", port: "587" } });
    const keys = await stores.vaultStore.patch("claude", "smtp", { credentials: { user: "alice" } });
    expect(keys.sort()).toEqual(["host", "port", "user"]);

    const fetched = await stores.vaultStore.get("claude", "smtp");
    expect(fetched!.credentials.user).toBe("alice");
    expect(fetched!.credentials.host).toBe("mail.test"); // preserved
  });

  it("remove deletes entry", async () => {
    await stores.vaultStore.set("claude", "openai", { type: "api_key" as const, credentials: { key: "k" } });
    const ok = await stores.vaultStore.remove("claude", "openai");
    expect(ok).toBe(true);
    expect(await stores.vaultStore.get("claude", "openai")).toBeUndefined();
  });

  it("list returns metadata without full credentials", async () => {
    await stores.vaultStore.set("claude", "openai", { type: "api_key" as const, label: "Main", credentials: { key: "sk", org: "o" } });
    const list = await stores.vaultStore.list("claude");
    expect(list).toHaveLength(1);
    expect(list[0].service).toBe("openai");
    expect(list[0].type).toBe("api_key");
    expect(list[0].label).toBe("Main");
    expect(list[0].keys.sort()).toEqual(["key", "org"]);
  });

  it("hasEntries returns correct boolean", async () => {
    expect(await stores.vaultStore.hasEntries("claude")).toBe(false);
    await stores.vaultStore.set("claude", "openai", { type: "api_key" as const, credentials: { key: "k" } });
    expect(await stores.vaultStore.hasEntries("claude")).toBe(true);
  });

  it("renameAgent moves entries to new name", async () => {
    await stores.vaultStore.set("old-agent", "openai", { type: "api_key" as const, credentials: { key: "k" } });
    await stores.vaultStore.renameAgent("old-agent", "new-agent");

    expect(await stores.vaultStore.get("old-agent", "openai")).toBeUndefined();
    const fetched = await stores.vaultStore.get("new-agent", "openai");
    expect(fetched).toBeDefined();
    expect(fetched!.credentials.key).toBe("k");
  });

  it("removeAgent deletes all entries for agent", async () => {
    await stores.vaultStore.set("claude", "openai", { type: "api_key" as const, credentials: { key: "k1" } });
    await stores.vaultStore.set("claude", "smtp", { type: "smtp" as const, credentials: { host: "h" } });
    await stores.vaultStore.removeAgent("claude");

    expect(await stores.vaultStore.hasEntries("claude")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// PlaybookStore
// ═══════════════════════════════════════════════════════════════════════

describe("DrizzlePlaybookStore", () => {
  const makePlaybook = (name: string, overrides: Partial<any> = {}) => ({
    name,
    description: `Playbook ${name}`,
    mission: { prompt: "Do the thing", tasks: [] },
    ...overrides,
  });

  it("save + get round-trip", async () => {
    const path = await stores.playbookStore.save(makePlaybook("deploy-v1"));
    expect(path).toContain("deploy-v1");

    const fetched = await stores.playbookStore.get("deploy-v1");
    expect(fetched).not.toBeNull();
    expect(fetched!.name).toBe("deploy-v1");
    expect(fetched!.description).toBe("Playbook deploy-v1");
    expect(fetched!.mission).toEqual({ prompt: "Do the thing", tasks: [] });
  });

  it("save upserts on conflict", async () => {
    await stores.playbookStore.save(makePlaybook("pb", { description: "old" }));
    await stores.playbookStore.save(makePlaybook("pb", { description: "new" }));

    const fetched = await stores.playbookStore.get("pb");
    expect(fetched!.description).toBe("new");
  });

  it("list returns metadata for all playbooks", async () => {
    await stores.playbookStore.save(makePlaybook("alpha", {
      parameters: [{ name: "env", description: "Target environment", required: true }],
    }));
    await stores.playbookStore.save(makePlaybook("beta"));

    const list = await stores.playbookStore.list();
    expect(list).toHaveLength(2);

    const alpha = list.find(p => p.name === "alpha");
    expect(alpha).toBeDefined();
    expect(alpha!.parameters).toHaveLength(1);
    expect(alpha!.parameters[0].name).toBe("env");
    expect(alpha!.path).toContain("alpha");
  });

  it("get returns null for non-existent", async () => {
    expect(await stores.playbookStore.get("ghost")).toBeNull();
  });

  it("delete removes playbook", async () => {
    await stores.playbookStore.save(makePlaybook("del-me"));
    const ok = await stores.playbookStore.delete("del-me");
    expect(ok).toBe(true);
    expect(await stores.playbookStore.get("del-me")).toBeNull();
  });

  it("delete returns false for non-existent", async () => {
    expect(await stores.playbookStore.delete("ghost")).toBe(false);
  });

  it("preserves optional fields: version, author, tags", async () => {
    await stores.playbookStore.save(makePlaybook("rich", {
      version: "1.2.0",
      author: "alice",
      tags: ["infra", "deploy"],
    }));

    const fetched = await stores.playbookStore.get("rich");
    expect(fetched!.version).toBe("1.2.0");
    expect(fetched!.author).toBe("alice");
    expect(fetched!.tags).toEqual(["infra", "deploy"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SkillStore
// ═══════════════════════════════════════════════════════════════════════

describe("DrizzleSkillStore (SQLite)", () => {
  const baseRecord = {
    description: "A test skill",
    installedAt: "2026-04-19T00:00:00.000Z",
  };

  it("list() returns [] when table is empty", async () => {
    expect(await stores.skillStore.list()).toEqual([]);
  });

  it("get() returns undefined for unknown name", async () => {
    expect(await stores.skillStore.get("nope")).toBeUndefined();
  });

  it("upsert + get round-trip", async () => {
    await stores.skillStore.upsert({ name: "alpha", ...baseRecord });
    const got = await stores.skillStore.get("alpha");
    expect(got).toBeDefined();
    expect(got?.description).toBe("A test skill");
    expect(got?.installedAt).toBe("2026-04-19T00:00:00.000Z");
  });

  it("upsert overwrites the existing record (by name)", async () => {
    await stores.skillStore.upsert({ name: "x", ...baseRecord, description: "first" });
    await stores.skillStore.upsert({ name: "x", ...baseRecord, description: "second" });
    expect((await stores.skillStore.get("x"))?.description).toBe("second");
    expect((await stores.skillStore.list()).length).toBe(1);
  });

  it("list returns all upserted records", async () => {
    await stores.skillStore.upsert({ name: "a", ...baseRecord });
    await stores.skillStore.upsert({ name: "b", ...baseRecord });
    const names = (await stores.skillStore.list()).map((r) => r.name).sort();
    expect(names).toEqual(["a", "b"]);
  });

  it("remove returns true when the record existed", async () => {
    await stores.skillStore.upsert({ name: "rm", ...baseRecord });
    expect(await stores.skillStore.remove("rm")).toBe(true);
    expect(await stores.skillStore.get("rm")).toBeUndefined();
  });

  it("remove returns false when the record did not exist", async () => {
    expect(await stores.skillStore.remove("never-existed")).toBe(false);
  });

  it("round-trips all optional fields (source, tags, category, allowedTools)", async () => {
    await stores.skillStore.upsert({
      name: "full",
      description: "Everything set",
      source: "anthropics/skills",
      installedAt: "2026-04-19T12:34:56.000Z",
      allowedTools: ["read", "write", "http_fetch"],
      tags: ["ui", "react"],
      category: "frontend",
    });
    const got = await stores.skillStore.get("full");
    expect(got?.source).toBe("anthropics/skills");
    expect(got?.allowedTools).toEqual(["read", "write", "http_fetch"]);
    expect(got?.tags).toEqual(["ui", "react"]);
    expect(got?.category).toBe("frontend");
  });

  it("null/undefined optional fields are preserved across upsert", async () => {
    await stores.skillStore.upsert({ name: "minimal", ...baseRecord });
    const got = await stores.skillStore.get("minimal");
    expect(got?.source).toBeUndefined();
    expect(got?.allowedTools).toBeUndefined();
    expect(got?.tags).toBeUndefined();
    expect(got?.category).toBeUndefined();
  });

  it("upsert updates tags without touching other fields", async () => {
    await stores.skillStore.upsert({
      name: "mutate",
      ...baseRecord,
      tags: ["old"],
    });
    await stores.skillStore.upsert({
      name: "mutate",
      ...baseRecord,
      tags: ["new", "fresh"],
    });
    const got = await stores.skillStore.get("mutate");
    expect(got?.tags).toEqual(["new", "fresh"]);
  });

  it("remove preserves unrelated records", async () => {
    await stores.skillStore.upsert({ name: "keep", ...baseRecord });
    await stores.skillStore.upsert({ name: "drop", ...baseRecord });
    await stores.skillStore.remove("drop");
    expect((await stores.skillStore.list()).map((r) => r.name)).toEqual(["keep"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Factory function
// ═══════════════════════════════════════════════════════════════════════

describe("createSqliteStores", () => {
  it("returns all stores", () => {
    expect(stores.taskStore).toBeDefined();
    expect(stores.runStore).toBeDefined();
    expect(stores.sessionStore).toBeDefined();
    expect(stores.logStore).toBeDefined();
    expect(stores.approvalStore).toBeDefined();
    expect(stores.memoryStore).toBeDefined();
    expect(stores.checkpointStore).toBeDefined();
    expect(stores.delayStore).toBeDefined();
    expect(stores.configStore).toBeDefined();
    expect(stores.teamStore).toBeDefined();
    expect(stores.agentStore).toBeDefined();
    expect(stores.vaultStore).toBeDefined();
    expect(stores.playbookStore).toBeDefined();
    expect(stores.skillStore).toBeDefined();
  });
});
