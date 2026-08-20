import type {
  AgentActivity,
  AgentConfig,
  ModelAllowlistEntry,
  ModelProfileRegistry,
  ReasoningLevel,
  TaskOutcome,
  TaskResult,
} from "@polpo-ai/core/types";
import type { VaultStore } from "@polpo-ai/core/vault-store";
import type { MemoryStore } from "@polpo-ai/core/memory-store";
import type { FileSystem } from "@polpo-ai/core/filesystem";
import type { Shell } from "@polpo-ai/core/shell";
import type { LoopResumeState } from "@polpo-ai/core/loop-run-store";
import type { SteeringController } from "./steering.js";
import type { ModelSelection } from "./model-policy.js";
import type { RuntimePlan } from "./runtime-plan/index.js";
import type { RuntimeSandboxOptions } from "./runtime-sandbox.js";
import type {
  RunOutputPolicy,
  RunToolMiddleware,
  RuntimeOutputEnforcementMode,
} from "./guardrails/index.js";
import type {
  RuntimeContextResolution,
  RuntimeContextTrustMode,
  RuntimePromptContextSegment,
} from "./runtime-context/index.js";
import type {
  BrainReadService,
  BrainServiceContext,
} from "./brain/index.js";
import type { ToolInvocationContext } from "./tool-invocation.js";

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
  /**
   * Run-scoped steering surface. Messages are accepted while the run is
   * active and delivered only at model/tool safe points.
   */
  steering?: SteeringController;
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
  /** Current logical run id, when the host has allocated one. */
  runId?: string;
  /** Host-owned immutable identity supplied to custom tools for this run. */
  toolInvocation?: ToolInvocationContext;
  /** Host-owned resolver for invocation-scoped logical Connection slots. */
  connectionCapabilityResolver?: import("./connection-capability.js").ConnectionCapabilityResolver;
  /** Pre-resolved retrieval snapshot rendered into task system prompts. */
  runtimeContext?: RuntimeContextResolution;
  /** Per-task output directory (.polpo/output/<taskId>/). Agents write deliverables here. */
  outputDir?: string;
  /** Email domain allowlist — restricts email_send tool to these domains. */
  emailAllowedDomains?: string[];
  /** Global reasoning level from settings — used as fallback when agent doesn't specify one. */
  reasoning?: ReasoningLevel;
  /** Project model profiles available to this runtime host. */
  modelProfiles?: ModelProfileRegistry;
  /** Project model allowlist enforced after profile expansion. */
  modelAllowlist?: Record<string, ModelAllowlistEntry>;
  /** Vault store — for resolving agent credentials at runtime. */
  vaultStore?: VaultStore;
  /** Memory store — for agent-scoped memory_* tools. */
  memoryStore?: MemoryStore;
  /** Scoped Brain reader — omitted when Brain is unavailable in this host. */
  brainService?: BrainReadService;
  /** Host-resolved Brain actor and scopes. Never supplied by the model. */
  brainContext?: BrainServiceContext;
  /** FileSystem implementation — created by the orchestrator, passed down to tools. */
  fs?: FileSystem;
  /** Shell implementation — created by the orchestrator, passed down to tools. */
  shell?: Shell;
  /** Host-owned checkpoint for manually managed hydrated sandbox volumes. */
  checkpointSandboxVolume?: (name?: string) => Promise<void>;
  /** LLM gateway configuration — passed per-request for multi-tenant support. */
  gatewayConfig?: unknown;
  /** Source- and trust-labelled prompt context for this run. */
  promptContextSegments?: readonly RuntimePromptContextSegment[];
  /** Explicit context-trust rollout mode. */
  contextTrust?: RuntimeContextTrustMode;
  /**
   * Optional host-resolved guardrail middleware for locally executed tools.
   * Hosts own policy configuration and rollout. Undefined preserves the
   * historical direct execution path.
   */
  runToolMiddleware?: RunToolMiddleware;
  /** Optional final-output policy for background runtime turns. */
  runOutputPolicy?: RunOutputPolicy;
  /** Enforcement mode for runOutputPolicy. Defaults to enforce. */
  runOutputPolicyMode?: RuntimeOutputEnforcementMode;
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
  /** Run-scoped steering inbox shared by every session in this execution. */
  steering?: SteeringController;
  /**
   * Token-level streaming sink: called for each model text-delta as it arrives,
   * for hosts that stream token-by-token (chat-via-executeRun, migration F1b).
   * Kept SEPARATE from onTranscript so per-token deltas reach the live consumer
   * WITHOUT polluting the turn-granularity transcript persistence. Optional and
   * additive — background hosts leave it undefined ⇒ no per-delta emission, the
   * historical whole-turn behaviour. Best-effort; must not throw.
   */
  onDelta?: (delta: { text: string; kind?: "text" | "reasoning" }) => void;
  /**
   * Initial transcript sink available at spawn time. Runners also set
   * AgentHandle.onTranscript after spawn, but in-process engines can emit very
   * early events before the handle is returned; this fallback prevents losing
   * live events in that small window.
   */
  onTranscript?: (entry: Record<string, unknown>) => void;
  /**
   * Chat-session injection (migration F1c). When set, the engine runs a CHAT
   * turn loop using these pre-resolved inputs (model/prompt/tools/messages from
   * the completions route) INSTEAD of resolving from the AgentConfig — so
   * chat-via-executeRun is at parity with the inline chat handler by
   * construction. Absent for task/background runs ⇒ the historical path is
   * byte-identical.
   */
  inject?: ChatSessionInjection;
}

/**
 * Pre-resolved inputs for running a chat completion through the shared run
 * lifecycle (F1c). Built server-side from the completions route's already
 * resolved model/prompt/tools/messages and threaded down through
 * ExecuteRunDeps → SpawnContext. AI-SDK types are kept opaque (unknown) so core
 * takes no dependency on `ai`.
 */
export interface ChatSessionInjection {
  /** Conversation session that groups this streaming run with its chat transcript. */
  sessionId?: string;
  /** Frozen, secret-free planning decision for this invocation. */
  runtimePlan?: RuntimePlan;
  /** Explicit context-trust rollout mode for model-bound history. */
  contextTrust?: RuntimeContextTrustMode;
  /** Resolved agent config (for the RunnerConfig the driver builds). */
  agent: AgentConfig;
  /** Optional session title (first user text). */
  title?: string;
  /** Original model policy. When present, the engine can execute fallback attempts. */
  modelSelection?: ModelSelection;
  /** Resolved model (the same ResolvedModel the engine's prepareSpawn would build). */
  model: { aiModel: unknown; contextWindow?: number; maxTokens?: number };
  /** Host resolver for model policy attempts beyond the pre-resolved primary model. */
  resolveModelAttempt?: (model: string) => Promise<{
    model: { aiModel: unknown; contextWindow?: number; maxTokens?: number };
    providerOptions?: Record<string, Record<string, unknown>>;
  }>;
  /** Full system prompt (conversational preamble + agent prompt + memory). */
  systemPrompt: string;
  providerOptions?: Record<string, Record<string, unknown>>;
  maxTurns: number;
  /** streamText toolChoice, if the route set one. */
  toolChoice?: unknown;
  /** Provider-neutral AI SDK structured output specification, kept opaque in core. */
  output?: unknown;
  /** Seed conversation (AI-SDK ModelMessage[]). */
  seedMessages: unknown[];
  /** AI-SDK ToolSet (declaration-only) fed to streamText. */
  toolSet: Record<string, unknown>;
  /** Dynamic tool names exposed to the model for the next turn. */
  activeToolNames?: () => string[];
  /** Executes a tool call, returning the string result ("Error:" prefix on failure). */
  executor: (
    name: string,
    args: Record<string, unknown>,
    options?: { callId?: string; signal?: AbortSignal },
  ) => Promise<string>;
  /** Client-side tool names that interrupt the loop (returned to the caller). */
  clientSideToolNames: ReadonlySet<string>;
  /** Provider-executed tool names to record but not dispatch. */
  providerToolNames: ReadonlySet<string>;
  /** Runtime sandbox policy requested by this chat turn. */
  sandbox?: RuntimeSandboxOptions;
  /** Tools value used for compaction token estimation — MUST match the chat path. */
  compactionTools: unknown[];
  /** Dynamic Polpo tool definitions used for compaction estimation. */
  activeCompactionTools?: () => unknown[];
  /** Compaction mode ("chat" mirrors the inline handler). */
  compactionMode: "chat" | "task";
}
