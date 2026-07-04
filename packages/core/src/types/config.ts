/**
 * Config domain — project configuration (polpo.json), settings, providers,
 * model config, runner config, and persisted state.
 */

import type { Task, RetryPolicy } from "./task.js";
import type { AgentConfig, AgentProcess, Team, ReasoningLevel } from "./agent.js";
import type { ApprovalGate, SLAConfig } from "./mission.js";
import type { NotificationsConfig, EscalationPolicy } from "./notifications.js";
import type { LoopResumeState } from "../loop/run-store.js";

// === Runner Config ===

export interface RunnerConfig {
  runId: string;
  taskId: string;
  agent: AgentConfig;
  task: Task;
  polpoDir: string;
  cwd: string;
  /** Per-task output directory (.polpo/output/<taskId>/). Agents should write deliverables here. */
  outputDir: string;
  storage?: "file" | "sqlite" | "postgres";
  /** PostgreSQL connection URL (for storage: "postgres"). */
  databaseUrl?: string;
  /** UDS path for push-notifying the orchestrator on completion. */
  notifySocket?: string;
  /** Email domain allowlist (from settings or agent config). */
  emailAllowedDomains?: string[];
  /** Global reasoning level from settings — used as fallback for agents that don't specify one. */
  reasoning?: ReasoningLevel;
  /**
   * Provider overrides from polpo.json (custom baseUrl endpoints: Ollama,
   * vLLM, proxies). The runner subprocess never reads polpo.json, so the
   * overrides must travel with the config or custom-provider agents break
   * inside the runner.
   */
  providers?: Record<string, ProviderConfig>;
  /**
   * Durable-turns resume checkpoint from a previous interrupted run
   * (orphan recovery). When present, the engine seeds its conversation
   * from the recorded history and continues at turn + 1 instead of
   * starting the task over.
   */
  resumeState?: LoopResumeState;
}

// === Polpo File Config (.polpo/polpo.json — persistent project configuration) ===

export interface PolpoFileConfig {
  project: string;
  /** Multiple teams — each with its own agents.
   *  @since 0.2 — replaces the old singular `team` field. */
  teams: Team[];
  settings: PolpoSettings;
  providers?: Record<string, ProviderConfig>;

  // ── Ink registry metadata (optional) ──

  /** Semantic version (e.g. "1.0.0"). Used by Ink registry for company package identification. */
  version?: string;
  /** Author name or "Name <email>" string. */
  author?: string;
  /** Searchable tags for registry discovery (e.g. ["saas", "startup", "fullstack"]). */
  tags?: string[];
}

/** Shape that parseConfig() accepts from disk — supports both old `team` and new `teams`. */
export interface PolpoFileConfigRaw {
  project?: string;
  teams?: Team[];
  settings?: Partial<PolpoSettings>;
  providers?: Record<string, ProviderConfig>;
}

// === Provider Config ===

export interface ProviderConfig {
  /** Override base URL for the provider (e.g. custom proxy, Ollama, vLLM). */
  baseUrl?: string;
  /** API compatibility mode for custom endpoints. */
  api?: "openai-completions" | "openai-responses" | "anthropic-messages";
  /** Custom model definitions for this provider (used with custom endpoints). */
  models?: CustomModelDef[];
}

/** Custom model definition for non-catalog providers (Ollama, vLLM, LM Studio, etc.) */
export interface CustomModelDef {
  /** Model ID used in API calls. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Whether the model supports extended thinking / reasoning. */
  reasoning?: boolean;
  /** Supported input types. Default: ["text"] */
  input?: ("text" | "image")[];
  /** Cost per million tokens. Default: all zeros (free/local). */
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** Context window size in tokens. Default: 200000 */
  contextWindow?: number;
  /** Max output tokens. Default: 8192 */
  maxTokens?: number;
}

// === Model Config (primary + fallbacks) ===

export interface ModelConfig {
  /** Primary model spec (e.g. "anthropic/claude-opus-4-6"). */
  primary?: string;
  /** Ordered fallback models — tried when primary fails. */
  fallbacks?: string[];
}

/** Model allowlist entry with optional alias. */
export interface ModelAllowlistEntry {
  /** Display alias for this model (e.g. "Sonnet", "GPT"). */
  alias?: string;
  /** Per-model parameter overrides. */
  params?: Record<string, unknown>;
}

// === Config (.polpo/polpo.json) ===

export interface PolpoConfig {
  version: string;
  project: string;
  teams: Team[];
  tasks: Omit<Task, "status" | "retries" | "result" | "createdAt" | "updatedAt">[];
  settings: PolpoSettings;
  /** Per-provider API key and base URL overrides. */
  providers?: Record<string, ProviderConfig>;
}

export interface PolpoSettings {
  maxRetries: number;
  workDir: string;
  logLevel: "quiet" | "normal" | "verbose";
  taskTimeout?: number;            // default timeout per task (ms). Default: 30min
  staleThreshold?: number;         // ms idle before agent considered stale. Default: 5min
  defaultRetryPolicy?: RetryPolicy;
  /** Whether missions can define volatile agents in their team: section. Default: true */
  enableVolatileTeams?: boolean;
  /** When to clean up volatile agents: "on_complete" (default) removes them when the mission
   *  finishes, "manual" keeps them until the user explicitly removes them or the mission is deleted */
  volatileCleanup?: "on_complete" | "manual";
  /** Max fix attempts per review cycle before falling back to full retry. Default: 2 */
  maxFixAttempts?: number;
  /** Max auto-answer rounds per task when agent asks questions. Default: 2 */
  maxQuestionRounds?: number;
  /** Max deadlock resolution attempts per task. Default: 2 */
  maxResolutionAttempts?: number;
  /** Auto-correct correctable expectations (e.g. file_exists paths) on assessment failure. Default: true */
  autoCorrectExpectations?: boolean;
  /** Skills to load into the orchestrator's system prompt.
   *  Skill names are resolved against the pool (project + global). */
  orchestratorSkills?: string[];
  /** Model for orchestrator LLM calls (question detection, deadlock, missions).
   *  Can be a simple string ("anthropic/claude-opus-4-6") or a ModelConfig with fallbacks. */
  orchestratorModel?: string | ModelConfig;
  /** Image-capable model for tasks that need vision (falls back to orchestratorModel). */
  imageModel?: string;
  /** Model allowlist — when set, only these models can be used.
   *  Keys are model specs (e.g. "anthropic/claude-opus-4-6"), values are aliases/params. */
  modelAllowlist?: Record<string, ModelAllowlistEntry>;
  /** Global reasoning / deep thinking level for orchestrator LLM calls (chat, plan generation, assessment).
   *  "off" disables thinking (default). Can be overridden per-agent via AgentConfig.reasoning.
   *  Higher levels produce better results but are slower and more expensive. */
  reasoning?: ReasoningLevel;
  /** Storage backend for tasks, missions, and runs. Default: "file" (filesystem JSON).
   *  "postgres" requires @polpo-ai/drizzle and a databaseUrl. */
  storage?: "file" | "sqlite" | "postgres";
  /** PostgreSQL connection URL (required when storage is "postgres").
   *  Example: "postgres://user:pass@localhost:5432/polpo" */
  databaseUrl?: string;
  /** Max assessment retries when all reviewers fail before falling back to fix/retry. Default: 1 */
  maxAssessmentRetries?: number;
  /** Max concurrent agent processes. Default: unlimited (undefined). */
  maxConcurrency?: number;
  /** Approval gates — checkpoints that block task/mission execution until approved. */
  approvalGates?: ApprovalGate[];
  /** Notification system — routes events to external channels (Slack, email, Telegram). */
  notifications?: NotificationsConfig;
  /** Default escalation policy — defines escalation chain when tasks fail repeatedly. */
  escalationPolicy?: EscalationPolicy;
  /** SLA monitoring configuration. */
  sla?: SLAConfig;
  /** Enable the scheduling engine. Default: true if any mission has a schedule. */
  enableScheduler?: boolean;
  /** Default quality threshold for missions (1-5). Missions below this score are marked failed. */
  defaultQualityThreshold?: number;
  /** Allowed recipient email domains — applies to all agents (can be overridden per-agent). */
  emailAllowedDomains?: string[];
  /** LLM gateway configuration. */
  gateway?: {
    /** Gateway endpoint URL (e.g. "https://ai-gateway.vercel.sh/v1", "http://localhost:11434/v1") */
    url: string;
    /** Environment variable name containing the API key (e.g. "AI_GATEWAY_API_KEY"). The key itself is NOT stored in config. */
    apiKeyEnv?: string;
    /** Custom headers to send with every request (e.g. OpenRouter requires HTTP-Referer). */
    headers?: Record<string, string>;
  };
}

// === Polpo State (persisted in .polpo/state.json) ===

export interface PolpoState {
  project: string;
  teams: Team[];
  tasks: Task[];
  processes: AgentProcess[];
  startedAt?: string;
  completedAt?: string;
}

// === Extended Settings ===

export interface PolpoSettingsExtended {
  /** Approval gates configuration. */
  approvalGates?: ApprovalGate[];
  /** Notification system configuration. */
  notifications?: NotificationsConfig;
  /** Default escalation policy for tasks. */
  escalationPolicy?: EscalationPolicy;
}

// === Quality & Scheduling Settings (on PolpoSettings) ===
// These are added to PolpoSettings directly — see the interface above.
