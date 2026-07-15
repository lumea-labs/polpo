/**
 * @polpo-ai/drizzle — Drizzle ORM store implementations for Polpo.
 *
 * Supports PostgreSQL (via postgres.js) and SQLite (via better-sqlite3).
 *
 * Usage:
 *   import { createPgStores } from "@polpo-ai/drizzle";
 *   import { drizzle } from "drizzle-orm/postgres-js";
 *   import postgres from "postgres";
 *
 *   const sql = postgres("postgres://...");
 *   const db = drizzle(sql);
 *   const stores = createPgStores(db);
 */

// ── Re-exports ────────────────────────────────────────────────────────

export * from "./stores/index.js";
export * from "./schema/index.js";
export { ensurePgSchema } from "./migrate.js";
export { migratePgSchema } from "./migrator.js";
export { ensureSqliteTables, ensureSqliteIndexes, migrateSqliteSchema } from "./sqlite-migrator.js";
export { backfillLoopRunsIntoRuns } from "./backfill.js";
export type { Dialect } from "./utils.js";

// ── Schema sets ───────────────────────────────────────────────────────

import {
  tasksPg, missionsPg, metadataPg, processesPg,
  tasksSqlite, missionsSqlite, metadataSqlite, processesSqlite,
} from "./schema/tasks.js";
import { runsPg, runsSqlite } from "./schema/runs.js";
import { loopRunsPg, loopRunsSqlite } from "./schema/loop-runs.js";
import { sessionsPg, messagesPg, sessionsSqlite, messagesSqlite } from "./schema/sessions.js";
import { logSessionsPg, logEntriesPg, logSessionsSqlite, logEntriesSqlite } from "./schema/logs.js";
import { modelInvocationLogsPg, modelInvocationLogsSqlite } from "./schema/model-invocations.js";
import { approvalsPg, approvalsSqlite } from "./schema/approvals.js";
import { memoryPg, memorySqlite } from "./schema/memory.js";
import {
  teamsPg, agentsPg,
  teamsSqlite, agentsSqlite,
} from "./schema/teams.js";
import { vaultPg, vaultSqlite } from "./schema/vault.js";
import { playbooksPg, playbooksSqlite } from "./schema/playbooks.js";
import { skillsPg, skillsSqlite } from "./schema/skills.js";

// ── Store classes ─────────────────────────────────────────────────────

import { DrizzleTaskStore } from "./stores/task-store.js";
import { DrizzleRunStore } from "./stores/run-store.js";
import { DrizzleLoopRunStore, DualWriteLoopRunStore } from "./stores/loop-run-store.js";
import { DrizzleSessionStore } from "./stores/session-store.js";
import { DrizzleLogStore } from "./stores/log-store.js";
import { DrizzleModelInvocationStore } from "./stores/model-invocation-store.js";
import { DrizzleApprovalStore } from "./stores/approval-store.js";
import { DrizzleMemoryStore } from "./stores/memory-store.js";
import { DrizzleCheckpointStore } from "./stores/checkpoint-store.js";
import { DrizzleDelayStore } from "./stores/delay-store.js";
import { DrizzleConfigStore } from "./stores/config-store.js";
import { DrizzleTeamStore } from "./stores/team-store.js";
import { DrizzleAgentStore } from "./stores/agent-store.js";
import { DrizzleVaultStore } from "./stores/vault-store.js";
import { DrizzlePlaybookStore } from "./stores/playbook-store.js";
import { DrizzleSkillStore } from "./stores/skill-store.js";

// ── Store bundle type ─────────────────────────────────────────────────

import type { MissionStore } from "@polpo-ai/core";
import type { TaskStore } from "@polpo-ai/core/task-store";
import type { RunStore } from "@polpo-ai/core/run-store";
import type { LoopRunStore } from "@polpo-ai/core/loop-run-store";
import type { SessionStore } from "@polpo-ai/core/session-store";
import type { LogStore } from "@polpo-ai/core/log-store";
import type { ModelInvocationStore } from "@polpo-ai/core/model-invocation-store";
import type { ApprovalStore } from "@polpo-ai/core/approval-store";
import type { MemoryStore } from "@polpo-ai/core/memory-store";
import type { CheckpointStore } from "@polpo-ai/core/checkpoint-store";
import type { DelayStore } from "@polpo-ai/core/delay-store";
import type { ConfigStore } from "@polpo-ai/core/config-store";
import type { TeamStore } from "@polpo-ai/core/team-store";
import type { AgentStore } from "@polpo-ai/core/agent-store";
import type { VaultStore } from "@polpo-ai/core/vault-store";
import type { PlaybookStore } from "@polpo-ai/core/playbook-store";
import type { SkillStore } from "@polpo-ai/core/skill-store";

export interface DrizzleStores {
  /** Mission persistence — same instance as taskStore (implements both). */
  missionStore: MissionStore;
  taskStore: TaskStore;
  runStore: RunStore;
  loopRunStore: LoopRunStore;
  sessionStore: SessionStore;
  logStore: LogStore;
  modelInvocationStore: ModelInvocationStore;
  approvalStore: ApprovalStore;
  memoryStore: MemoryStore;
  checkpointStore: CheckpointStore;
  delayStore: DelayStore;
  configStore: ConfigStore;
  teamStore: TeamStore;
  agentStore: AgentStore;
  vaultStore: VaultStore;
  playbookStore: PlaybookStore;
  skillStore: SkillStore;
  /**
   * Fresh LogStore over the SAME db handle (no second connection).
   * LogStore keeps its current session as instance state, so anything
   * that needs a private transcript session per consumer (e.g. one per
   * in-process task run) must get a dedicated instance instead of
   * sharing `logStore` — sharing would hijack its current session.
   * Optional for backward compatibility with external bundles.
   */
  createLogStore?(): LogStore;
}

// ── PostgreSQL factory ────────────────────────────────────────────────

/**
 * Create all Drizzle stores backed by PostgreSQL.
 *
 * @param db A Drizzle database instance (e.g. from `drizzle(postgres(...))`)
 */
export function createPgStores(db: any): DrizzleStores {
  const taskStore = new DrizzleTaskStore(db, {
    tasks: tasksPg, missions: missionsPg, metadata: metadataPg, processes: processesPg,
  }, "pg");
  return {
    taskStore,
    // Same instance: the Drizzle task store also implements the mission block.
    missionStore: taskStore as unknown as MissionStore,
    runStore: new DrizzleRunStore(db, runsPg, "pg"),
    // F2: dual-write loop runs to both loop_runs (legacy) and runs (shadow,
    // engine="graph"). Reads now come from runs (shadow) — flipped in PR4 after
    // the backfill. loop_runs is still written for rollback until PR5 drops it.
    loopRunStore: new DualWriteLoopRunStore(
      new DrizzleLoopRunStore(db, loopRunsPg, "pg"),
      new DrizzleLoopRunStore(db, runsPg, "pg", true),
      "shadow",
    ),
    sessionStore: new DrizzleSessionStore(db, sessionsPg, messagesPg, "pg"),
    logStore: new DrizzleLogStore(db, logSessionsPg, logEntriesPg, "pg"),
    modelInvocationStore: new DrizzleModelInvocationStore(db, modelInvocationLogsPg, "pg"),
    createLogStore: () => new DrizzleLogStore(db, logSessionsPg, logEntriesPg, "pg"),
    approvalStore: new DrizzleApprovalStore(db, approvalsPg, "pg"),
    memoryStore: new DrizzleMemoryStore(db, memoryPg),
    checkpointStore: new DrizzleCheckpointStore(db, metadataPg, "pg"),
    delayStore: new DrizzleDelayStore(db, metadataPg, "pg"),
    configStore: new DrizzleConfigStore(db, metadataPg, "pg"),
    teamStore: new DrizzleTeamStore(db, teamsPg, agentsPg, "pg"),
    agentStore: new DrizzleAgentStore(db, agentsPg, "pg"),
    vaultStore: new DrizzleVaultStore(db, vaultPg),
    playbookStore: new DrizzlePlaybookStore(db, playbooksPg, "pg"),
    skillStore: new DrizzleSkillStore(db, skillsPg, "pg"),
  };
}

// ── SQLite factory ────────────────────────────────────────────────────

/**
 * Create all Drizzle stores backed by SQLite (better-sqlite3).
 *
 * @param db A Drizzle database instance (e.g. from `drizzle(new Database(...))`)
 */
export function createSqliteStores(db: any): DrizzleStores {
  const taskStore = new DrizzleTaskStore(db, {
    tasks: tasksSqlite, missions: missionsSqlite, metadata: metadataSqlite, processes: processesSqlite,
  }, "sqlite");
  return {
    taskStore,
    // Same instance: the Drizzle task store also implements the mission block.
    missionStore: taskStore as unknown as MissionStore,
    runStore: new DrizzleRunStore(db, runsSqlite, "sqlite"),
    // F2: dual-write, reads from shadow (see pg factory above).
    loopRunStore: new DualWriteLoopRunStore(
      new DrizzleLoopRunStore(db, loopRunsSqlite, "sqlite"),
      new DrizzleLoopRunStore(db, runsSqlite, "sqlite", true),
      "shadow",
    ),
    sessionStore: new DrizzleSessionStore(db, sessionsSqlite, messagesSqlite, "sqlite"),
    logStore: new DrizzleLogStore(db, logSessionsSqlite, logEntriesSqlite, "sqlite"),
    modelInvocationStore: new DrizzleModelInvocationStore(db, modelInvocationLogsSqlite, "sqlite"),
    createLogStore: () => new DrizzleLogStore(db, logSessionsSqlite, logEntriesSqlite, "sqlite"),
    approvalStore: new DrizzleApprovalStore(db, approvalsSqlite, "sqlite"),
    memoryStore: new DrizzleMemoryStore(db, memorySqlite),
    checkpointStore: new DrizzleCheckpointStore(db, metadataSqlite, "sqlite"),
    delayStore: new DrizzleDelayStore(db, metadataSqlite, "sqlite"),
    configStore: new DrizzleConfigStore(db, metadataSqlite, "sqlite"),
    teamStore: new DrizzleTeamStore(db, teamsSqlite, agentsSqlite, "sqlite"),
    agentStore: new DrizzleAgentStore(db, agentsSqlite, "sqlite"),
    vaultStore: new DrizzleVaultStore(db, vaultSqlite),
    playbookStore: new DrizzlePlaybookStore(db, playbooksSqlite, "sqlite"),
    skillStore: new DrizzleSkillStore(db, skillsSqlite, "sqlite"),
  };
}

// ── All PG table references (for drizzle-kit migrations) ──────────────

export const pgSchema = {
  tasks: tasksPg,
  missions: missionsPg,
  metadata: metadataPg,
  processes: processesPg,
  runs: runsPg,
  loopRuns: loopRunsPg,
  sessions: sessionsPg,
  messages: messagesPg,
  logSessions: logSessionsPg,
  logEntries: logEntriesPg,
  modelInvocationLogs: modelInvocationLogsPg,
  approvals: approvalsPg,
  memory: memoryPg,
  teams: teamsPg,
  agents: agentsPg,
  vault: vaultPg,
  playbooks: playbooksPg,
  skills: skillsPg,
};

export const sqliteSchema = {
  tasks: tasksSqlite,
  missions: missionsSqlite,
  metadata: metadataSqlite,
  processes: processesSqlite,
  runs: runsSqlite,
  loopRuns: loopRunsSqlite,
  sessions: sessionsSqlite,
  messages: messagesSqlite,
  logSessions: logSessionsSqlite,
  logEntries: logEntriesSqlite,
  modelInvocationLogs: modelInvocationLogsSqlite,
  approvals: approvalsSqlite,
  memory: memorySqlite,
  teams: teamsSqlite,
  agents: agentsSqlite,
  vault: vaultSqlite,
  playbooks: playbooksSqlite,
  skills: skillsSqlite,
};
