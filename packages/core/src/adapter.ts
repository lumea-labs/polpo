import type { AgentActivity, TaskResult, TaskOutcome, ReasoningLevel } from "@polpo-ai/core/types";
import type { VaultStore } from "@polpo-ai/core/vault-store";
import type { MemoryStore } from "@polpo-ai/core/memory-store";
import type { FileSystem } from "@polpo-ai/core/filesystem";
import type { Shell } from "@polpo-ai/core/shell";
import type { LoopResumeState } from "@polpo-ai/core/loop-run-store";

/**
 * Handle returned by the engine after spawning an agent.
 * The orchestrator uses this to monitor and control the agent.
 */
export interface AgentHandle {
  /** Agent name from config */
  agentName: string;
  /** Task ID this handle is working on */
  taskId: string;
  /** When the agent was started */
  startedAt: string;
  /** Process ID (0 when running in-process) */
  pid: number;
  /** Session ID — for reading conversation transcripts */
  sessionId?: string;
  /** Live activity data — updated in place by the engine */
  activity: AgentActivity;
  /** Resolves when the agent finishes (success or failure) */
  done: Promise<TaskResult>;
  /** Check if the agent is still running */
  isAlive(): boolean;
  /** Kill the agent process */
  kill(): void;
  /**
   * Transcript callback — set by the runner to persist every agent message.
   * The engine calls this for each message/event (assistant text, tool use, tool result, etc.)
   */
  onTranscript?: (entry: Record<string, unknown>) => void;
  /**
   * Auto-collected outcomes from tool executions.
   * Populated by the engine when tools produce files, media, or other artifacts.
   * The runner reads this after completion and stores them on the run record.
   */
  outcomes?: TaskOutcome[];
}

/** Extra context passed to the engine at spawn time. */
export interface SpawnContext {
  /** Absolute path to the .polpo directory. Used for skill loading, logs, etc. */
  polpoDir: string;
  /** Per-task output directory (.polpo/output/<taskId>/). Agents write deliverables here. */
  outputDir?: string;
  /** Email domain allowlist — restricts email_send tool to these domains. */
  emailAllowedDomains?: string[];
  /** Global reasoning level from settings — used as fallback when agent doesn't specify one. */
  reasoning?: ReasoningLevel;
  /** Vault store — for resolving agent credentials at runtime. */
  vaultStore?: VaultStore;
  /** Memory store — for agent-scoped memory_* tools. */
  memoryStore?: MemoryStore;
  /** FileSystem implementation — created by the orchestrator, passed down to tools. */
  fs?: FileSystem;
  /** Shell implementation — created by the orchestrator, passed down to tools. */
  shell?: Shell;
  /** LLM gateway configuration — passed per-request for multi-tenant support. */
  gatewayConfig?: unknown;
  /**
   * Durable-turns checkpoint from a previous interrupted run. Single-session
   * loops seed their conversation history from it and continue at turn + 1;
   * pipeline (project-loop graph) runs additionally restore the pipeline
   * position — completed steps are never re-executed (their outputs replay
   * from the recorded context bag), an in-flight agent step resumes at its
   * saved turn. Tools that already ran are replayed from their recorded
   * results, never re-executed.
   */
  resumeState?: LoopResumeState;
  /**
   * Durable-turns checkpoint sink: called after every completed turn and —
   * on pipeline runs — after every completed pipeline step, with ONE
   * composed LoopResumeState (pipeline position + step-local session
   * history). The runner wires it to RunStore.updateResumeState.
   * Best-effort — implementations should not throw (the engine swallows
   * errors anyway).
   */
  onTurnCheckpoint?: (state: LoopResumeState) => void | Promise<void>;
  /**
   * Token-level streaming sink: called for each model text-delta as it arrives,
   * for hosts that stream token-by-token (chat-via-executeRun, migration F1b).
   * Kept SEPARATE from onTranscript so per-token deltas reach the live consumer
   * WITHOUT polluting the turn-granularity transcript persistence. Optional and
   * additive — background hosts leave it undefined ⇒ no per-delta emission, the
   * historical whole-turn behaviour. Best-effort; must not throw.
   */
  onDelta?: (delta: { text: string }) => void;
}
