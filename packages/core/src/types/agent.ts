/**
 * Agent domain — agent configuration, identity, vault, runtime activity,
 * teams, and multi-team helpers.
 */

import type { LoopConfig, LoopToolChoice, Pipeline } from "../loop/types.js";
import type { ProfiledModelSelection } from "./config.js";
import type { RuntimeSandboxOptions } from "../runtime-sandbox.js";
import type { ExecutionRouterConfig } from "../execution-router.js";
import type {
  BillingOwner,
  CostSource,
  CredentialType,
  ModelInvocationStatus,
  ModelOperation,
  ModelRuntimeMode,
} from "../model-runtime.js";

// === Reasoning / Thinking ===

/** Reasoning level for LLM calls (maps to the provider's thinking/reasoning level). */
export type ReasoningLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

// === Agent Identity & Vault ===

/** Agent identity — who this agent is and how it behaves */
/** A structured responsibility area */
export interface AgentResponsibility {
  /** Responsibility area (e.g. "Customer Relations", "Content Creation") */
  area: string;
  /** What the agent does in this area */
  description: string;
  /** Priority level — affects how the agent prioritizes competing tasks */
  priority?: "critical" | "high" | "medium" | "low";
}

export interface AgentIdentity {
  displayName?: string;      // "Alice Chen"
  title?: string;            // "Social Media Manager"
  company?: string;          // "Acme Corp"
  email?: string;            // Primary email address (also default SMTP from)
  bio?: string;              // Brief persona description
  timezone?: string;         // "Europe/Rome"

  /** Avatar image path relative to project root (e.g. ".polpo/avatars/alice.png").
   *  Served via GET /api/v1/files/read?path=<avatar> */
  avatar?: string;

  /** Responsibilities — simple strings or structured objects with area/description/priority.
   *  Structured format is preferred for clarity. */
  responsibilities?: (string | AgentResponsibility)[];

  /** Communication tone — HOW the agent communicates.
   *  Examples: "Professional but warm", "Concise and data-driven", "Casual and friendly" */
  tone?: string;

  /** Personality traits — WHO the agent IS as a persona.
   *  Examples: "Detail-oriented and empathetic", "Creative problem-solver" */
  personality?: string;

  /** Social & web accounts — free-form key-value.
   *  Keys are platform names, values are handles/URLs.
   *  Examples: { x: "@alice", linkedin: "linkedin.com/in/alice", github: "alice", website: "https://alice.dev" } */
  socials?: Record<string, string>;
}

/** Vault credential entry */
export interface VaultEntry {
  /** Service type for semantic meaning */
  type: "smtp" | "imap" | "oauth" | "api_key" | "login" | "custom";
  /** Human-readable label */
  label?: string;
  /** Credential fields — values can be literals or ${ENV_VAR} references */
  credentials: Record<string, string>;
}

// === Agent ===

export interface AgentConfig {
  name: string;
  /** ISO timestamp of when this agent was created / added to the team. Auto-set by addAgent(). */
  createdAt?: string;
  role?: string;
  /** Model to use. Strings remain concrete ids; profile references are explicit objects. */
  model?: ProfiledModelSelection;
  /** Optional narrowing allowlist for profile references used by this agent. */
  allowedModelProfiles?: string[];
  /** Image generation model. Format: "provider/model".
   *  Default: "fal/fal-ai/flux/dev". Drives the image_generate tool.
   *  Provider must be in the supported set: fal. */
  image_model?: string;
  /** Video generation model. Format: "provider/model".
   *  Default: "fal/luma-ray-2-flash". Drives the video_generate tool.
   *  Provider must be in the supported set: fal. */
  video_model?: string;
  /** Vision model for image_analyze. Format: "provider/model".
   *  Default: "openai/gpt-4o-mini". Must be a multimodal LLM.
   *  Provider must be in the supported set: openai, anthropic. */
  vision_model?: string;
  /** Speech-to-text model. Format: "provider/model".
   *  Default: "openai/whisper-1". Drives the audio_transcribe tool.
   *  Provider must be in the supported set: openai, deepgram. */
  transcribe_model?: string;
  /** Text-to-speech model. Format: "provider/model".
   *  Default: "openai/tts-1". Drives the audio_speak tool.
   *  Provider must be in the supported set: openai, deepgram, elevenlabs, edge.
   *  Use "edge/edge-tts" for the free local Microsoft Edge voices. */
  tts_model?: string;
  /** Web search backend for search_web / search_find_similar.
   *  Default: "exa". Currently only "exa" is supported in OSS;
   *  cloud may add more. */
  search_provider?: string;
  /** Allowed tools for the agent (e.g. ["read", "write", "edit", "bash", "glob", "grep", "browser_*", "email_*", "image_*", "video_*", "audio_*", "excel_*", "pdf_*", "docx_*"]).
   *  Core tools (always available): read, write, edit, bash, glob, grep, ls, http_fetch, http_download, register_outcome, vault_get, vault_list. */
  allowedTools?: string[];
  /** Filesystem sandbox — directories the agent is allowed to access.
   *  Paths can be absolute or relative to workDir. When set, all file tool operations
   *  and bash cwd are validated against these paths. When omitted, defaults to [workDir]. */
  allowedPaths?: string[];
  /** Agent's identity — persona, responsibilities, communication style */
  identity?: AgentIdentity;
  // NOTE: Vault credentials are stored in .polpo/vault.enc (encrypted).
  // Use EncryptedVaultStore to manage credentials — NOT inline on the agent config.
  /** Agent this one reports to — org chart hierarchy for escalation.
   *  When a task fails or needs a decision, escalates up the chain. */
  reportsTo?: string;
  /** System prompt appended to the agent's base prompt */
  systemPrompt?: string;
  /** Installed skill names (e.g. "find-skills", "frontend-design") */
  skills?: string[];
  /** Max conversation turns before stopping. Default 150 */
  maxTurns?: number;
  /** Max concurrent tasks for this agent. Default: unlimited (undefined). */
  maxConcurrency?: number;
  /** Reasoning / deep thinking level for this agent's LLM calls.
   *  "off" disables thinking (default). Higher levels = more reasoning tokens = better quality but slower + more expensive.
   *  Falls back to the global `settings.reasoning` when not set. */
  reasoning?: ReasoningLevel;
  /** Runtime/environment ref for configurable loop execution. */
  runtime?: string;
  /** Runtime-only model tool-choice policy materialized from an active loop step. */
  toolChoice?: LoopToolChoice;
  /** Project-level loop names this agent is allowed to use. */
  assignedLoops?: string[];
  /** Optional direct-vs-loop router. Off by default. */
  executionRouter?: ExecutionRouterConfig;
  /** Legacy inline loop steps. Prefer project-level loops + assignedLoops. */
  loops?: Record<string, LoopConfig>;
  /** Legacy inline pipeline wiring loop, switch, parallel, and human steps. */
  pipeline?: Pipeline;
  /** Volatile agent — created for a specific mission, auto-removed when mission completes */
  volatile?: boolean;
  /** Mission group this volatile agent belongs to */
  missionGroup?: string;

  // ── Tool activation ──
  // Core tools (always available): read, write, edit, bash, glob, grep, ls, http_fetch, http_download, register_outcome, vault_get, vault_list.
  // Extended tool categories are activated via allowedTools (e.g. ["browser_*", "email_*"]).
  // No enable flags needed — if a tool name appears in allowedTools, it's loaded.
  // Available extension categories: browser_*, email_*, image_*, video_*, audio_*, excel_*, pdf_*, docx_*, search_*.
  // Git and dependency operations should be done via bash.

  /** Browser profile name for persistent context (cookies, auth, localStorage).
   *  Defaults to agent name. Used with agent-browser's --profile flag.
   *  Profiles stored in .polpo/browser-profiles/<name>/. */
  browserProfile?: string;
  /** Where this agent's task runs execute. Precedence: task > agent > settings. */
  executionMode?: import("./config.js").ExecutionMode;
  /** Default runtime sandbox policy for this agent. Request/task overrides beat this. */
  sandbox?: RuntimeSandboxOptions;
  /** Allowed recipient email domains for email_send (e.g. ["acme.com", "partner.io"]).
   *  When set, emails can only be sent to addresses in these domains.
   *  When omitted, all domains are allowed (backwards compatible). */
  emailAllowedDomains?: string[];

  // ── Ink registry metadata (optional) ──

  /** Semantic version (e.g. "1.0.0"). Used by Ink registry for package identification. */
  version?: string;
  /** Author name or "Name <email>" string. */
  author?: string;
  /** Searchable tags for registry discovery (e.g. ["frontend", "react", "testing"]). */
  tags?: string[];
}

export interface AgentActivity {
  lastTool?: string;        // last tool the agent used (e.g. "Write", "Edit", "Bash")
  lastFile?: string;        // last file touched
  filesCreated: string[];   // files created during this task
  filesEdited: string[];    // files edited during this task
  toolCalls: number;        // total tool calls made
  totalTokens: number;      // cumulative token usage across all turns
  lastUpdate: string;       // ISO timestamp of last activity
  summary?: string;         // agent's last text output / message
  sessionId?: string;       // SDK session ID for transcript access
  /**
   * Model-using tool facts captured from tool results. Gateway-backed tools
   * may include billable cost metadata; direct provider/local tools report
   * factual usage with non-platform billing semantics. Hosts decide how to
   * persist or bill these records.
   */
  toolUsage?: ToolUsageRecord[];
}

/** One model-using tool invocation fact harvested from a tool result. */
export interface ToolUsageRecord {
  toolName: string;
  mode?: ModelRuntimeMode;
  operation?: ModelOperation;
  requestedProvider?: string;
  requestedModel?: string;
  resolvedProvider?: string;
  resolvedModel?: string;
  finalProvider?: string;
  generationId?: string;
  credentialType?: CredentialType;
  status?: ModelInvocationStatus;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedTokens?: number;
  audioInputSeconds?: number;
  audioOutputSeconds?: number;
  imageCount?: number;
  videoSeconds?: number;
  estimatedCostUsd?: number;
  billableCostUsd?: number;
  marketCostUsd?: number;
  actualCostUsd?: number;
  costSource?: CostSource;
  billingOwner?: BillingOwner;
  rawMetadata?: Record<string, unknown>;
}

export interface AgentProcess {
  agentName: string;
  pid: number;
  taskId: string;
  startedAt: string;
  alive: boolean;
  activity: AgentActivity;
}

// === Team ===

export interface Team {
  name: string;
  description?: string;
  agents: AgentConfig[];
}

// === Multi-team helpers ===

/** Get all agents across all teams (flattened). */
export function getAllAgents(teams: Team[]): AgentConfig[] {
  return teams.flatMap(t => t.agents);
}

/** Find a specific agent by name across all teams. */
export function findAgent(teams: Team[], agentName: string): AgentConfig | undefined {
  for (const t of teams) {
    const agent = t.agents.find(a => a.name === agentName);
    if (agent) return agent;
  }
  return undefined;
}

/** Find the team an agent belongs to. */
export function findAgentTeam(teams: Team[], agentName: string): Team | undefined {
  return teams.find(t => t.agents.some(a => a.name === agentName));
}
