import type { AgentActivity, TaskResult, TaskOutcome, RunnerConfig } from "./types.js";
import type { LoopResumeState } from "./loop/run-store.js";
import type { LoopTraceEvent } from "./loop/types.js";

export type RunStatus = "running" | "completed" | "failed" | "killed";

export interface RunRecord {
  id: string;
  taskId: string;
  pid: number;
  agentName: string;
  sessionId?: string;
  status: RunStatus;
  startedAt: string;
  updatedAt: string;
  activity: AgentActivity;
  result?: TaskResult;
  /** Outcomes auto-collected during execution (files, media, text artifacts). */
  outcomes?: TaskOutcome[];
  /** Full runner configuration (used by runners that read config from DB instead of file). */
  config?: RunnerConfig;
  configPath: string;
  /**
   * Opaque end-user identifier (OpenAI-compat `user`), propagated from the
   * parent Task. Used for per-user analytics and billing attribution.
   */
  user?: string;
  /**
   * Durable-turns checkpoint (history + turn position), written by the
   * runner once per completed turn. Orphan recovery reads it to re-spawn
   * the task with a resume instead of retrying from zero.
   */
  resumeState?: LoopResumeState;
  /** Execution mode this run was spawned with ("subprocess" | "in-process"). */
  executionMode?: string;
  /** Execution engine discriminator used by the unified Run model. */
  engine?: "agent" | "graph";
  /** Interactive streams are excluded from background task collection. */
  delivery?: "stream" | "background";
  /** Ordered technical events emitted by this run, including sandbox lifecycle events. */
  trace?: LoopTraceEvent[];
  /** Timestamp set when execution entered a terminal state. */
  completedAt?: string;
  /** Timestamp set after the task supervisor durably consumed the result. */
  collectedAt?: string;
}

export interface RunStore {
  upsertRun(run: RunRecord): Promise<void>;
  updateActivity(runId: string, activity: AgentActivity): Promise<void>;
  /** Store auto-collected outcomes on the run record (called before completeRun). */
  updateOutcomes(runId: string, outcomes: TaskOutcome[]): Promise<void>;
  /**
   * Persist the durable-turns resume checkpoint (one write per completed
   * turn). Optional and best-effort: stores that don't implement it simply
   * lose crash-resumability, never correctness — recovery falls back to
   * retry-from-zero.
   */
  updateResumeState?(runId: string, state: LoopResumeState): Promise<void>;
  /** Update host-assigned spawn metadata without overwriting status or result. */
  updateSpawnInfo?(runId: string, pid: number, configPath: string): Promise<void>;
  completeRun(runId: string, status: RunStatus, result: TaskResult): Promise<void>;
  /** Acknowledge a terminal result while retaining its Run history. */
  markRunCollected?(runId: string): Promise<void>;
  /**
   * Append one technical event without replacing events written concurrently.
   * Optional for compatibility with third-party stores created before run traces.
   */
  appendTrace?(runId: string, event: LoopTraceEvent): Promise<void>;
  getRun(runId: string): Promise<RunRecord | undefined>;
  getRunByTaskId(taskId: string): Promise<RunRecord | undefined>;
  /**
   * Return the newest runs correlated to a conversation or transcript session.
   * Optional for compatibility with third-party stores.
   */
  getRunsBySessionId?(sessionId: string, limit?: number): Promise<RunRecord[]>;
  getActiveRuns(): Promise<RunRecord[]>;
  getTerminalRuns(): Promise<RunRecord[]>;
  deleteRun(runId: string): Promise<void>;
  close(): Promise<void> | void;
}
