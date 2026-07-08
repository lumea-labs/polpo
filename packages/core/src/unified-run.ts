/**
 * Unified Run — the convergence target for chat, task and (later) mission.
 *
 * Today the codebase carries three run-shaped records that only overlap by soft
 * ids: `RunRecord` (task path, run-store.ts), `LoopRunRecord` (chat/loop path,
 * loop/run-store.ts) and the raw sessions/messages transcript. This module
 * defines the ONE record they converge onto — the vocabulary for the chat+task
 * unification (migration plan F0).
 *
 * F0 is additive and code-only: nothing consumes these types yet. They pin the
 * target shape so later phases (route chat through `executeRun`, fold
 * `loop_runs` into `runs`) migrate toward a single agreed contract instead of
 * inventing it mid-refactor.
 *
 * The chat/task distinction survives as two ORTHOGONAL AXES on one record,
 * never as two entities:
 *   - engine:   how a run executes  — "agent" (a trivial single-node loop, i.e.
 *               plain chat/task) or "graph" (a multi-step project-loop DAG).
 *   - delivery: how a run is consumed — "stream" (attached over a live SSE, the
 *               chat surface) or "background" (detached, poll/webhook, the task
 *               surface).
 * Every task-only and loop-only field below is OPTIONAL, so a run of either
 * origin fits without loss — the guarantee that unifying costs no capability.
 */
import type { AgentActivity, TaskResult, TaskOutcome, RunnerConfig } from "./types.js";
import type { RunStatus } from "./run-store.js";
import type { ContextBag, LoopTraceEvent } from "./loop/types.js";
import type { LoopResumeState, LoopApprovalSnapshot, ProjectLoopRunStatus } from "./loop/run-store.js";

/**
 * Superset of both run-status vocabularies. Defined as the union of the two
 * existing types so it stays in sync automatically: `RunStatus` contributes
 * "killed", `ProjectLoopRunStatus` contributes the approval/resuming/cancelled
 * states. A value of either type is assignable to this without a cast.
 */
export type UnifiedRunStatus = RunStatus | ProjectLoopRunStatus;

/** How a run executes: a plain turn-loop (chat/task) or a multi-step graph (project loop). */
export type RunEngine = "agent" | "graph";

/** How a run is consumed: attached over a live stream, or detached in the background. */
export type RunDelivery = "stream" | "background";

/** Terminal statuses — a run in one of these will not change again. */
export const UNIFIED_RUN_TERMINAL_STATUSES = [
  "completed",
  "failed",
  "killed",
  "cancelled",
  "approval_rejected",
] as const satisfies readonly UnifiedRunStatus[];

/** True when the status is terminal (covers both the task and loop vocabularies). */
export function isTerminalRunStatus(status: UnifiedRunStatus): boolean {
  return (UNIFIED_RUN_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * The convergence target for `RunRecord` + `LoopRunRecord`. Common fields are
 * required; task-origin and loop-origin fields are optional so a run of either
 * origin fits without loss. Not persisted yet — this is the contract the
 * migration converges on, not a live store shape.
 */
export interface UnifiedRunRecord {
  // ── identity / common ──
  id: string;
  agentName: string;
  sessionId?: string;
  user?: string;
  status: UnifiedRunStatus;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;

  // ── the two axes that replace the chat/task entity split ──
  engine: RunEngine;
  delivery: RunDelivery;

  // ── shared durable state (already one format across both paths today) ──
  resumeState?: LoopResumeState;

  // ── task-origin fields (optional) ──
  taskId?: string;
  pid?: number;
  activity?: AgentActivity;
  result?: TaskResult;
  outcomes?: TaskOutcome[];
  config?: RunnerConfig;
  configPath?: string;
  executionMode?: string;

  // ── loop-origin fields (optional) ──
  loopName?: string;
  context?: ContextBag;
  trace?: LoopTraceEvent[];
  error?: string;
  approvalRequestId?: string;
  approval?: LoopApprovalSnapshot;
  metadata?: Record<string, unknown>;
}
