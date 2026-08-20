/**
 * @polpo-ai/drizzle — PostgreSQL tests for all Drizzle stores.
 *
 * Mirrors stores.test.ts but runs against a real PostgreSQL database.
 * Requires TEST_DATABASE_URL env var (default: postgresql://postgres:postgres@localhost:5432/polpo_test).
 * Skipped when no PG connection is available.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { createPgStores, type DrizzleStores } from "../index.js";
import { ensurePgSchema } from "../migrate.js";
import type { ApprovalRequest } from "@polpo-ai/core/types";

// Provide a deterministic vault key for tests (32 bytes hex-encoded)
process.env.POLPO_VAULT_KEY = randomBytes(32).toString("hex");

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/polpo_test";

// All tables managed by ensurePgSchema, in safe truncation order (children before parents)
const ALL_TABLES = [
  "run_stream_events",
  "run_event_sequences",
  "run_execution_leases",
  "run_cancellation_requests",
  "conversation_channel_routes",
  "conversation_channels",
  "log_entries",
  "model_invocation_logs",
  "messages",
  "approvals",
  "runs",
  "tasks",
  "missions",
  "processes",
  "metadata",
  "sessions",
  "log_sessions",
  "memory",
  "agents",
  "teams",
  "vault",
  "playbooks",
  "skills",
] as const;

// ── Connection check ──────────────────────────────────────────────────

let canConnect = false;
try {
  const probe = postgres(DATABASE_URL, { max: 1, connect_timeout: 3 });
  await probe`SELECT 1`;
  await probe.end();
  canConnect = true;
} catch {
  canConnect = false;
}

// ── Test suite ────────────────────────────────────────────────────────

describe.skipIf(!canConnect)("PostgreSQL Drizzle stores", () => {
  let pgClient: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;
  let stores: DrizzleStores;

  beforeAll(async () => {
    pgClient = postgres(DATABASE_URL, { max: 10 });
    db = drizzle(pgClient);
    await ensurePgSchema(db);
    stores = createPgStores(db);
  });

  afterAll(async () => {
    await pgClient.end();
  });

  /** Truncate all tables and recreate stores between tests for full isolation. */
  beforeEach(async () => {
    // TRUNCATE CASCADE handles foreign key dependencies
    for (const table of ALL_TABLES) {
      await db.execute(sql.raw(`TRUNCATE TABLE "${table}" CASCADE`));
    }
    // Recreate stores to reset in-memory state (e.g. LogStore.currentSessionId)
    stores = createPgStores(db);
  });

  it("ensurePgSchema creates every runs column (F2 migrate.ts drift guard)", async () => {
    // migrate.ts (ensurePgSchema) is hand-maintained ALTER TABLE lines — a
    // forgotten column here breaks only the cloud/release PG path (SQLite
    // auto-derives, so PR CI on SQLite stays green). This asserts parity with
    // the canonical runsPg schema.
    const { getTableConfig } = await import("drizzle-orm/pg-core");
    const { runsPg } = await import("../schema/index.js");
    const list: any[] = await db.execute(sql.raw(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'runs'`,
    ));
    const present = new Set(list.map((r: any) => r.column_name));
    for (const col of getTableConfig(runsPg).columns.map((c) => c.name)) {
      expect(present.has(col), `migrate.ts missing runs column: ${col}`).toBe(true);
    }
  });

  it("ensurePgSchema creates every tasks column", async () => {
    const { getTableConfig } = await import("drizzle-orm/pg-core");
    const { tasksPg } = await import("../schema/index.js");
    const list: any[] = await db.execute(sql.raw(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'tasks'`,
    ));
    const present = new Set(list.map((r: any) => r.column_name));
    for (const col of getTableConfig(tasksPg).columns.map((c) => c.name)) {
      expect(present.has(col), `migrate.ts missing tasks column: ${col}`).toBe(true);
    }
  });

  it("ensurePgSchema provisions durable run event and lease tables", async () => {
    const expected = [
      "run_event_sequences",
      "run_stream_events",
      "run_execution_leases",
      "run_cancellation_requests",
    ];
    for (const table of expected) {
      const rows: any[] = await db.execute(sql.raw(
        `SELECT to_regclass('public.${table}') AS name`,
      ));
      expect(rows[0]?.name, `migrate.ts missing table: ${table}`).toBe(table);
    }
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

    it("persists runtime routing labels as JSONB", async () => {
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

      // pending -> assigned is valid
      const assigned = await stores.taskStore.transition(task.id, "assigned");
      expect(assigned.status).toBe("assigned");

      // assigned -> pending is invalid
      await expect(stores.taskStore.transition(task.id, "pending")).rejects.toThrow();
    });

    it("transition increments retries on failed->pending", async () => {
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

      // pending -> done is not a valid transition, but unsafeSetStatus allows it
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

    it("atomically appends jsonb trace events and lists correlated session runs", async () => {
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

      await Promise.all([
        stores.runStore.appendTrace!("r-trace-1", {
          id: "event-a",
          type: "sandbox.acquire.started",
          ts: "2025-01-01T00:00:01Z",
          operation: "acquire",
        }),
        stores.runStore.appendTrace!("r-trace-1", {
          id: "event-b",
          type: "sandbox.acquired",
          ts: "2025-01-01T00:00:02Z",
          operation: "acquire",
          sandboxId: "sandbox-1",
        }),
      ]);
      await stores.runStore.appendTrace!("r-trace-1", {
        id: "event-a",
        type: "sandbox.acquire.started",
        ts: "2025-01-01T00:00:01Z",
        operation: "acquire",
      });

      const trace = (await stores.runStore.getRun("r-trace-1"))?.trace ?? [];
      expect(trace).toHaveLength(2);
      expect(new Set(trace.map((event) => event.id))).toEqual(new Set(["event-a", "event-b"]));
      const traceTypes = await db.execute(sql`
        select jsonb_typeof(trace) as type from runs where id = 'r-trace-1'
      `) as unknown as Array<{ type: string }>;
      expect(traceTypes[0]?.type).toBe("array");
      expect((await stores.runStore.getRunsBySessionId!("session-chat")).map((run) => run.id)).toEqual([
        "r-trace-2",
        "r-trace-1",
      ]);
    });

    it("normalizes legacy string traces and invalid scalars before appending", async () => {
      await stores.runStore.upsertRun({
        ...makeRun("r-trace-legacy", "chat-legacy"),
        trace: [],
      } as any);
      const legacy = JSON.stringify([{
        id: "event-legacy",
        type: "sandbox.acquire.started",
        ts: "2025-01-01T00:00:00Z",
        operation: "acquire",
      }]);
      await db.execute(sql`
        update runs set trace = to_jsonb(${legacy}::text) where id = 'r-trace-legacy'
      `);

      await stores.runStore.appendTrace!("r-trace-legacy", {
        id: "event-new",
        type: "sandbox.acquired",
        ts: "2025-01-01T00:00:01Z",
        operation: "acquire",
        sandboxId: "sandbox-legacy",
      });
      expect((await stores.runStore.getRun("r-trace-legacy"))?.trace?.map((event) => event.id)).toEqual([
        "event-legacy",
        "event-new",
      ]);

      await db.execute(sql`
        update runs set trace = to_jsonb('legacy-invalid'::text) where id = 'r-trace-legacy'
      `);
      await stores.runStore.appendTrace!("r-trace-legacy", {
        id: "event-recovered",
        type: "sandbox.released",
        ts: "2025-01-01T00:00:02Z",
        operation: "release",
      });
      expect((await stores.runStore.getRun("r-trace-legacy"))?.trace?.map((event) => event.id)).toEqual([
        "event-recovered",
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

    it("updateResumeState round-trips the durable-turns checkpoint (jsonb)", async () => {
      await stores.runStore.upsertRun(makeRun("r-resume", "t-resume") as any);

      await stores.runStore.updateResumeState!("r-resume", {
        context: {}, steps: [], loopName: "default", turn: 2,
        history: [
          { role: "user", content: "do the thing" },
          { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "bash", input: {} }] },
        ],
        accumText: "working",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as any);

      const fetched = await stores.runStore.getRun("r-resume");
      expect(fetched!.resumeState).toMatchObject({ loopName: "default", turn: 2, accumText: "working" });
      expect(fetched!.resumeState!.history).toHaveLength(2);

      const active = await stores.runStore.getActiveRuns();
      expect(active.find((r) => r.id === "r-resume")!.resumeState!.turn).toBe(2);
    });

    it("upsertRun on conflict preserves an existing resume checkpoint", async () => {
      await stores.runStore.upsertRun(makeRun("r-keep", "t-keep") as any);
      await stores.runStore.updateResumeState!("r-keep", {
        context: {}, steps: [], loopName: "default", turn: 1,
        history: [{ role: "user", content: "hi" }],
        createdAt: new Date().toISOString(),
      } as any);

      await stores.runStore.upsertRun({ ...makeRun("r-keep", "t-keep"), pid: 4242 } as any);

      const fetched = await stores.runStore.getRun("r-keep");
      expect(fetched!.pid).toBe(4242);
      expect(fetched!.resumeState!.turn).toBe(1);
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

    it("atomically prepares and replays a client-tool continuation", async () => {
      const sid = await stores.sessionStore.create({
        agent: "leo",
        user: "user-1",
        scope: { key: "tenant:site", version: "3" },
      });
      const assistant = await stores.sessionStore.addMessage(sid, "assistant", "Choose");
      await stores.sessionStore.updateMessage(sid, assistant.id, "Choose", [{
        id: "call-1",
        name: "configure_site_module",
        state: "interrupted",
      }]);
      const input = {
        sessionId: sid,
        agent: "leo",
        user: "user-1",
        scope: { key: "tenant:site", version: "3" },
        toolCallId: "call-1",
        result: "configured",
        expectedSessionVersion: 1,
        idempotencyKey: "idem-1",
        fingerprint: "fingerprint-1",
        runId: "looprun-1",
      } as const;

      await expect(stores.sessionStore.prepareContinuation!(input)).resolves.toMatchObject({
        status: "prepared",
        sessionVersion: 2,
        runId: "looprun-1",
      });
      await expect(stores.sessionStore.prepareContinuation!(input)).resolves.toMatchObject({
        status: "replay",
        runId: "looprun-1",
      });
      await expect(stores.sessionStore.prepareContinuation!({
        ...input,
        scope: { key: "other-site", version: "3" },
      })).rejects.toMatchObject({ code: "continuation_scope_mismatch" });
      await expect(stores.sessionStore.prepareContinuation!({
        ...input,
        fingerprint: "different",
      })).rejects.toMatchObject({ code: "idempotency_conflict" });
      expect(await stores.sessionStore.getMessages(sid)).toHaveLength(2);
    });

    it("allows only one concurrent continuation for one pending call", async () => {
      const sid = await stores.sessionStore.create();
      const assistant = await stores.sessionStore.addMessage(sid, "assistant", "Choose");
      await stores.sessionStore.updateMessage(sid, assistant.id, "Choose", [{
        id: "call-1",
        name: "configure",
        state: "interrupted",
      }]);
      const base = {
        sessionId: sid,
        toolCallId: "call-1",
        result: "configured",
        expectedSessionVersion: 1,
        fingerprint: "fingerprint",
      } as const;

      const outcomes = await Promise.allSettled([
        stores.sessionStore.prepareContinuation!({
          ...base,
          idempotencyKey: "idem-a",
          runId: "looprun-a",
        }),
        stores.sessionStore.prepareContinuation!({
          ...base,
          idempotencyKey: "idem-b",
          runId: "looprun-b",
        }),
      ]);

      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
      expect(await stores.sessionStore.getMessages(sid)).toHaveLength(2);
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
  // AttachmentStore
  // ═══════════════════════════════════════════════════════════════════════


  // ═══════════════════════════════════════════════════════════════════════
  // Factory function
  // ═══════════════════════════════════════════════════════════════════════

  describe("DrizzleSkillStore", () => {
    const baseRecord = {
      description: "A test skill",
      installedAt: "2026-04-19T00:00:00.000Z",
    };

    it("list() returns [] when the table is empty", async () => {
      expect(await stores.skillStore.list()).toEqual([]);
    });

    it("get() returns undefined for unknown names", async () => {
      expect(await stores.skillStore.get("nope")).toBeUndefined();
    });

    it("upsert + get round-trip", async () => {
      await stores.skillStore.upsert({ name: "alpha", ...baseRecord });
      const got = await stores.skillStore.get("alpha");
      expect(got).toBeDefined();
      expect(got?.description).toBe("A test skill");
    });

    it("upsert overwrites existing record by name", async () => {
      await stores.skillStore.upsert({ name: "x", ...baseRecord, description: "first" });
      await stores.skillStore.upsert({ name: "x", ...baseRecord, description: "second" });
      expect((await stores.skillStore.get("x"))?.description).toBe("second");
      expect((await stores.skillStore.list()).length).toBe(1);
    });

    it("remove returns true/false correctly", async () => {
      await stores.skillStore.upsert({ name: "rm", ...baseRecord });
      expect(await stores.skillStore.remove("rm")).toBe(true);
      expect(await stores.skillStore.remove("rm")).toBe(false);
    });

    it("round-trips optional fields including JSONB arrays", async () => {
      await stores.skillStore.upsert({
        name: "full",
        description: "Everything set",
        source: "anthropics/skills",
        installedAt: "2026-04-19T12:34:56.000Z",
        allowedTools: ["read", "write"],
        tags: ["ui"],
        category: "frontend",
      });
      const got = await stores.skillStore.get("full");
      expect(got?.source).toBe("anthropics/skills");
      expect(got?.allowedTools).toEqual(["read", "write"]);
      expect(got?.tags).toEqual(["ui"]);
      expect(got?.category).toBe("frontend");
    });

    it("null optional fields are preserved", async () => {
      await stores.skillStore.upsert({ name: "minimal", ...baseRecord });
      const got = await stores.skillStore.get("minimal");
      expect(got?.source).toBeUndefined();
      expect(got?.allowedTools).toBeUndefined();
      expect(got?.tags).toBeUndefined();
      expect(got?.category).toBeUndefined();
    });
  });

  describe("createPgStores", () => {
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
      expect(stores.missionStore).toBeDefined();
      expect(stores.skillStore).toBeDefined();
    });
  });
});
