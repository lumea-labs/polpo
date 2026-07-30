/**
 * OpenPolpo API types — mirrors the server contract.
 * Intentionally decoupled from @polpo-ai/core to avoid pulling
 * server-side dependencies (blessed, sqlite, etc.) into the client bundle.
 */

// === Task ===



// ── Domain types: canonical definitions live in @polpo-ai/core ──────────
// Type-only re-exports: zero runtime cost, no bundle impact. The hand-kept
// copies that used to live here had already drifted from core.
import type {
  AgentActivity,
  AgentConfig,
  AgentIdentity,
  AgentProcess,
  AgentResponsibility,
  ApprovalGateHandler,
  ApprovalRequest,
  ApprovalStatus,
  AskUserAnswer,
  AskUserOption,
  AskUserQuestion,
  AssessmentResult,
  AssessmentTrigger,
  CheckResult,
  Condition,
  CustomModelDef,
  DimensionScore,
  EvalDimension,
  ExpectedOutcome,
  FileEntry,
  LoadedSkill,
  LogEntry,
  CreateMemoryItemInput,
  MemoryItem,
  MemoryItemPatch,
  MemoryKind,
  MemoryListQuery,
  MemorySearchQuery,
  MemorySearchResult,
  MemoryScope,
  MemoryScopeKind,
  MemoryStatus,
  LoopApprovalSnapshot,
  LoopApprovedGate,
  LoopConfig,
  LoopHookAction,
  LoopLifecycleHook,
  LoopNext,
  LoopPermissionEffect,
  LoopPermissionMatch,
  LoopPermissionResource,
  LoopPolicyEffect,
  LoopResumeState,
  LoopRunRecord,
  LoopStepConfig,
  LoopToolChoice,
  LoopTraceEvent,
  LoopTraceEventType,
  MetricResult,
  Mission,
  MissionCheckpoint,
  MissionDelay,
  MissionQualityGate,
  MissionReport,
  MissionStatus,
  ModelAllowlistEntry,
  ModelConfig,
  ModelProfileReference,
  ModelProfileRegistry,
  ModelSelection,
  ModelTarget,
  NotificationChannelConfig,
  NotificationChannelType,
  NotificationRule,
  NotificationSeverity,
  OutcomeType,
  Pipeline,
  PolpoConfig,
  PolpoSettings,
  PolpoState,
  ProjectLoopConfig,
  ProjectLoopHooks,
  ProjectLoopKind,
  ProjectLoopPermission,
  ProjectLoopPolicy,
  ProjectLoopRunStatus,
  ProjectLoopVersion,
  ProviderConfig,
  ProfiledModelConfig,
  ProfiledModelSelection,
  QualityMetrics,
  ReasoningLevel,
  RetryPolicy,
  ReviewerExploration,
  ReviewerMessage,
  ReviewerResult,
  RuntimeSandboxOptions,
  SandboxIsolation,
  Schedule,
  ScheduleDriverRegistration,
  ScheduleEntry,
  ScheduleFilter,
  ScheduleInvocation,
  ScheduleMetadata,
  ScheduleMutationOptions,
  SchedulePolicy,
  ScheduleRun,
  ScheduleRunFilter,
  ScheduleRunStatus,
  ScheduleStatus,
  ScheduleTiming,
  CreateScheduleInput,
  UpdateScheduleInput,
  ScopedNotificationRules,
  SkillIndex,
  SkillIndexEntry,
  SkillInfo,
  SkillWithAssignment,
  Step,
  SwitchCase,
  Task,
  TaskExpectation,
  TaskMetric,
  TaskOutcome,
  TaskPhase,
  TaskResult,
  TaskStatus,
  Team,
  ToolCallState,
  WhileBlock,
} from "@polpo-ai/core";

export type {
  AgentActivity,
  AgentConfig,
  AgentIdentity,
  AgentProcess,
  AgentResponsibility,
  ApprovalGateHandler,
  ApprovalRequest,
  ApprovalStatus,
  AskUserAnswer,
  AskUserOption,
  AskUserQuestion,
  AssessmentResult,
  AssessmentTrigger,
  CheckResult,
  Condition,
  CustomModelDef,
  DimensionScore,
  EvalDimension,
  ExpectedOutcome,
  FileEntry,
  LoadedSkill,
  LogEntry,
  CreateMemoryItemInput,
  MemoryItem,
  MemoryItemPatch,
  MemoryKind,
  MemoryListQuery,
  MemorySearchQuery,
  MemorySearchResult,
  MemoryScope,
  MemoryScopeKind,
  MemoryStatus,
  LoopApprovalSnapshot,
  LoopApprovedGate,
  LoopConfig,
  LoopHookAction,
  LoopLifecycleHook,
  LoopNext,
  LoopPermissionEffect,
  LoopPermissionMatch,
  LoopPermissionResource,
  LoopPolicyEffect,
  LoopResumeState,
  LoopRunRecord,
  LoopStepConfig,
  LoopToolChoice,
  LoopTraceEvent,
  LoopTraceEventType,
  MetricResult,
  Mission,
  MissionCheckpoint,
  MissionDelay,
  MissionQualityGate,
  MissionReport,
  MissionStatus,
  ModelAllowlistEntry,
  ModelConfig,
  ModelProfileReference,
  ModelProfileRegistry,
  ModelSelection,
  ModelTarget,
  NotificationChannelConfig,
  NotificationChannelType,
  NotificationRule,
  NotificationSeverity,
  OutcomeType,
  Pipeline,
  PolpoConfig,
  PolpoSettings,
  PolpoState,
  ProjectLoopConfig,
  ProjectLoopHooks,
  ProjectLoopKind,
  ProjectLoopPermission,
  ProjectLoopPolicy,
  ProjectLoopRunStatus,
  ProjectLoopVersion,
  ProviderConfig,
  ProfiledModelConfig,
  ProfiledModelSelection,
  QualityMetrics,
  ReasoningLevel,
  RetryPolicy,
  ReviewerExploration,
  ReviewerMessage,
  ReviewerResult,
  RuntimeSandboxOptions,
  SandboxIsolation,
  Schedule,
  ScheduleDriverRegistration,
  ScheduleEntry,
  ScheduleFilter,
  ScheduleInvocation,
  ScheduleMetadata,
  ScheduleMutationOptions,
  SchedulePolicy,
  ScheduleRun,
  ScheduleRunFilter,
  ScheduleRunStatus,
  ScheduleStatus,
  ScheduleTiming,
  CreateScheduleInput,
  UpdateScheduleInput,
  ScopedNotificationRules,
  SkillIndex,
  SkillIndexEntry,
  SkillInfo,
  SkillWithAssignment,
  Step,
  SwitchCase,
  Task,
  TaskExpectation,
  TaskMetric,
  TaskOutcome,
  TaskPhase,
  TaskResult,
  TaskStatus,
  Team,
  ToolCallState,
  WhileBlock,
};

export type ListMemoryItemsQuery = Omit<MemoryListQuery, "now">;
export type ListMemoryItemsPageQuery = ListMemoryItemsQuery & {
  readonly cursor?: string;
};
export interface MemoryItemsPage {
  readonly items: MemoryItem[];
  readonly nextCursor: string | null;
}
export type SearchMemoryRequest = Omit<MemorySearchQuery, "now">;

export interface DimensionScoreEvidence {
  file: string;
  line: number;
  note: string;
}






// === Outcomes ===






// === Agent ===

// === MCP Server Config ===

/** Stdio-based MCP server — spawns a child process */
export interface McpStdioServerConfig {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** SSE-based MCP server (legacy, prefer HTTP) */
export interface McpSseServerConfig {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
}

/** HTTP-based MCP server (streamable HTTP, recommended for remote) */
export interface McpHttpServerConfig {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}

/** Union of all supported MCP server configs */
export type McpServerConfig =
  | McpStdioServerConfig
  | McpSseServerConfig
  | McpHttpServerConfig;

// === Agent Identity & Vault ===






export const LOOP_LIFECYCLE_HOOKS = [
  "loop:start",
  "step:before",
  "model:before",
  "tool:before",
  "tool:after",
  "step:after",
  "loop:stop",
  "loop:transition",
  "loop:end",
] as const;














export interface LoopRunFilters {
  loopName?: string;
  agentName?: string;
  sessionId?: string;
  user?: string;
  status?: ProjectLoopRunStatus;
  limit?: number;
}










// === Team ===


// === Assessment ===








// === Mission ===



// === Mission Document Types (parsed from Mission.data JSON) ===



/** Runtime state of an active delay (timer started, waiting to expire). */
export interface ActiveDelay {
  /** Mission group name. */
  group: string;
  /** Delay name. */
  delayName: string;
  /** Full delay definition. */
  delay: MissionDelay;
  /** ISO timestamp when the delay timer started. */
  startedAt: string;
  /** ISO timestamp when the delay will expire. */
  expiresAt: string;
}



// === Notifications ===

export type NotificationStatus = "sent" | "failed";






export interface NotificationRecord {
  id: string;
  timestamp: string;
  ruleId: string;
  ruleName: string;
  channel: string;
  channelType: string;
  status: NotificationStatus;
  error?: string;
  title: string;
  body: string;
  severity: NotificationSeverity;
  sourceEvent: string;
  attachmentCount: number;
  attachmentTypes?: OutcomeType[];
}

export interface NotificationStats {
  total: number;
  sent: number;
  failed: number;
}

export interface SendNotificationRequest {
  channel: string;
  title: string;
  body: string;
  severity?: NotificationSeverity;
  delayMs?: number;
}

export interface SendNotificationResult {
  id: string;
  scheduledAt: string;
  firesAt: string;
}

// === Approval Gates ===



// === Scheduling ===


// === Quality & SLA ===


// === Playbooks ===

export interface PlaybookParameter {
  /** Parameter name — used as {{name}} in the mission playbook. */
  name: string;
  /** Human-readable description. */
  description: string;
  /** Value type. Default: "string". */
  type?: "string" | "number" | "boolean";
  /** Whether the parameter must be provided. Default: false. */
  required?: boolean;
  /** Default value when not provided. */
  default?: string | number | boolean;
  /** Allowed values (enum constraint). */
  enum?: (string | number)[];
}

/** Lightweight playbook metadata (no mission body). */
export interface PlaybookInfo {
  name: string;
  description: string;
  parameters: PlaybookParameter[];
  /** Absolute path to the playbook directory. */
  path: string;
}

/** Full playbook definition including the mission body. */
export interface PlaybookDefinition {
  name: string;
  description: string;
  mission: Record<string, unknown>;
  parameters?: PlaybookParameter[];
}

/** Result of running a playbook. */
export interface PlaybookRunResult {
  mission: Mission;
  tasks: number;
  group: string;
  /** Non-blocking validation warnings (e.g. unknown parameters). */
  warnings?: string[];
}

// Backward-compat aliases
/** @deprecated Use PlaybookParameter instead. */
export type TemplateParameter = PlaybookParameter;
/** @deprecated Use PlaybookInfo instead. */
export type TemplateInfo = PlaybookInfo;
/** @deprecated Use PlaybookDefinition instead. */
export type TemplateDefinition = PlaybookDefinition;
/** @deprecated Use PlaybookRunResult instead. */
export type TemplateRunResult = PlaybookRunResult;

// === Config ===









export interface AddTeamRequest {
  name: string;
  description?: string;
}

// === API ===

export type ErrorCode =
  | "NOT_FOUND"
  | "INVALID_STATE"
  | "VALIDATION_ERROR"
  | "AUTH_REQUIRED"
  | "FORBIDDEN"
  | "CONFLICT"
  | "INTERNAL_ERROR";

export interface ApiResponse<T> {
  ok: true;
  data: T;
}

export interface ApiError {
  ok: false;
  error: string;
  code: ErrorCode;
  details?: unknown;
}

export type ApiResult<T> = ApiResponse<T> | ApiError;

// === Request DTOs ===

export interface CreateTaskRequest {
  title: string;
  description: string;
  assignTo: string;
  /** Runtime sandbox policy for this task. */
  sandbox?: RuntimeSandboxOptions;
  /** Create task as draft (won't be picked up until queued). Default: false. */
  draft?: boolean;
  expectations?: TaskExpectation[];
  expectedOutcomes?: ExpectedOutcome[];
  dependsOn?: string[];
  group?: string;
  maxDuration?: number;
  retryPolicy?: RetryPolicy;
  notifications?: ScopedNotificationRules;
  /** Opaque end-user identifier (OpenAI-compat). Persisted on the task and propagated to runs. */
  user?: string;
}

export interface UpdateTaskRequest {
  description?: string;
  assignTo?: string;
  sandbox?: RuntimeSandboxOptions;
  status?: TaskStatus;
  expectations?: TaskExpectation[];
}

export interface CreateMissionRequest {
  data: string;
  prompt?: string;
  name?: string;
  status?: MissionStatus;
  /**
   * Cron expression or ISO timestamp for scheduled execution.
   * @deprecated Use `createScheduleV2` with a `legacy_mission` invocation.
   */
  schedule?: string;
  /** Absolute deadline for the entire mission (ISO timestamp). */
  deadline?: string;
  /**
   * End date for recurring schedules (ISO timestamp).
   * @deprecated Use v2 Schedule compatibility metadata.
   */
  endDate?: string;
  notifications?: ScopedNotificationRules;
  /** Opaque end-user identifier (OpenAI-compat). Tasks generated by this mission inherit this user. */
  user?: string;
}

export interface UpdateMissionRequest {
  data?: string;
  status?: MissionStatus;
  name?: string;
  /**
   * Cron expression or ISO timestamp. Pass `null` to clear.
   * @deprecated Use `updateScheduleV2`.
   */
  schedule?: string | null;
  /** Absolute deadline (ISO timestamp). Pass `null` to clear. */
  deadline?: string | null;
  /**
   * End date for recurring schedules (ISO timestamp). Pass `null` to clear.
   * @deprecated Use `updateScheduleV2`.
   */
  endDate?: string | null;
}

// === Atomic Mission Data Request DTOs ===

export interface AddMissionTaskRequest {
  title: string;
  description: string;
  assignTo?: string;
  dependsOn?: string[];
  expectations?: TaskExpectation[];
  expectedOutcomes?: ExpectedOutcome[];
  maxDuration?: number;
  retryPolicy?: RetryPolicy;
  notifications?: ScopedNotificationRules;
}

export interface UpdateMissionTaskRequest {
  title?: string;
  description?: string;
  assignTo?: string;
  dependsOn?: string[];
  expectations?: TaskExpectation[];
  expectedOutcomes?: ExpectedOutcome[];
  maxDuration?: number;
  retryPolicy?: RetryPolicy;
  notifications?: ScopedNotificationRules;
}

export interface ReorderMissionTasksRequest {
  titles: string[];
}

export interface AddMissionCheckpointRequest {
  name: string;
  afterTasks: string[];
  blocksTasks: string[];
  message?: string;
  notifyChannels?: string[];
}

export interface UpdateMissionCheckpointRequest {
  name?: string;
  afterTasks?: string[];
  blocksTasks?: string[];
  message?: string;
  notifyChannels?: string[];
}

export interface AddMissionDelayRequest {
  name: string;
  afterTasks: string[];
  blocksTasks: string[];
  duration: string;
  message?: string;
  notifyChannels?: string[];
}

export interface UpdateMissionDelayRequest {
  name?: string;
  afterTasks?: string[];
  blocksTasks?: string[];
  duration?: string;
  message?: string;
  notifyChannels?: string[];
}

export interface AddMissionQualityGateRequest {
  name: string;
  afterTasks: string[];
  blocksTasks: string[];
  minScore?: number;
  requireAllPassed?: boolean;
  condition?: string;
  notifyChannels?: string[];
}

export interface UpdateMissionQualityGateRequest {
  name?: string;
  afterTasks?: string[];
  blocksTasks?: string[];
  minScore?: number;
  requireAllPassed?: boolean;
  condition?: string;
  notifyChannels?: string[];
}

export interface AddMissionTeamMemberRequest {
  name: string;
  role?: string;
  model?: ProfiledModelSelection;
  systemPrompt?: string;
  allowedTools?: string[];
}

export interface UpdateMissionTeamMemberRequest {
  name?: string;
  role?: string;
  model?: ProfiledModelSelection;
  systemPrompt?: string;
  allowedTools?: string[];
}

export interface UpdateMissionNotificationsRequest {
  notifications: ScopedNotificationRules | null;
}

export interface AddAgentRequest {
  name: string;
  role?: string;
  model?: ProfiledModelSelection;
  /** Optional narrowing allowlist for profile references used by this agent. */
  allowedModelProfiles?: string[];
  /** Default runtime sandbox policy for this agent. */
  sandbox?: RuntimeSandboxOptions;
  allowedTools?: string[];
  systemPrompt?: string;
  skills?: string[];
  maxTurns?: number;
  runtime?: string;
  assignedLoops?: string[];
  loops?: Record<string, LoopConfig>;
  pipeline?: Pipeline;
  /** Max concurrent tasks for this agent. */
  maxConcurrency?: number;
  /** MCP servers to connect to. */
  mcpServers?: Record<string, McpServerConfig>;
  /** Filesystem sandbox — directories the agent is allowed to access. */
  allowedPaths?: string[];
  /** Agent identity (display name, bio, avatar). */
  identity?: AgentIdentity;
  // NOTE: Vault credentials managed via encrypted store, not in API body.
  /** Org chart: who this agent reports to. */
  reportsTo?: string;
  /** Allowed email recipient domains (overrides global setting). */
  emailAllowedDomains?: string[];
  // Tool categories activated via allowedTools (e.g. ["browser_*", "email_*", "image_*", "video_*", "audio_*", "excel_*", "pdf_*", "docx_*", "search_*"])
}

export interface UpdateAgentRequest {
  role?: string;
  model?: ProfiledModelSelection;
  allowedModelProfiles?: string[];
  sandbox?: RuntimeSandboxOptions;
  allowedTools?: string[];
  allowedPaths?: string[];
  systemPrompt?: string;
  skills?: string[];
  maxTurns?: number;
  maxConcurrency?: number;
  runtime?: string;
  assignedLoops?: string[];
  loops?: Record<string, LoopConfig>;
  pipeline?: Pipeline;
  identity?: AgentIdentity;
  reportsTo?: string;
  reasoning?: string;
  browserProfile?: string;
  emailAllowedDomains?: string[];
  /** Move agent to a different team. */
  team?: string;
}

export interface UpdateSettingsRequest {
  orchestratorModel?: ProfiledModelSelection;
  modelProfiles?: ModelProfileRegistry;
  imageModel?: string | null;
  reasoning?: ReasoningLevel;
}

// === SSE ===

export interface SSEEvent<
  TEvent extends string = string,
  TData = unknown,
> {
  id: string;
  event: TEvent;
  data: TData;
  timestamp: string;
}

// === Health ===

export interface HealthResponse {
  status: string;
  version: string;
  uptime: number;
}

// === Task Filters ===

export interface TaskFilters {
  /** Single status or comma-separated list (e.g. "pending,in_progress") */
  status?: TaskStatus | string;
  group?: string;
  assignTo?: string;
}

// === Execution results ===

export interface ExecuteMissionResult {
  tasks: Task[];
  group: string;
}

export interface ResumeMissionResult {
  retried: number;
  pending: number;
}

// === File Browser types ===

export interface FileRoot {
  id: string;
  name: string;
  path: string;
  absolutePath: string;
  description: string;
  icon: string;
  totalFiles: number;
  totalSize: number;
}


export interface FilePreview {
  path: string;
  name: string;
  mimeType: string;
  size: number;
  previewable: boolean;
  type: "text" | "image" | "pdf" | "audio" | "video" | "binary";
  url: string;
  content?: string;
  truncated?: boolean;
}

// === Log types ===

export interface LogSession {
  sessionId: string;
  startedAt: string;
  entries: number;
}


// === Run Activity types ===

/** A single entry from the per-run JSONL activity log. */
export interface RunActivityEntry {
  /** ISO timestamp (present on all entries except the header) */
  ts?: string;
  /** Event type: "spawning", "spawned", "activity", "sigterm", "done", "error" */
  event?: string;
  /** Transcript type: "stdout", "tool_use", "tool_result", "assistant", "error", "result" */
  type?: string;
  /** Agent output text (for stdout/assistant entries) */
  text?: string;
  /** Payload data (activity snapshot, lifecycle info, etc.) */
  data?: unknown;

  // ── tool_use fields ──
  /** Tool name (present on tool_use and tool_result entries) */
  tool?: string;
  /** Tool call ID (present on tool_use and tool_result entries) */
  toolId?: string;
  /** Tool input arguments (present on tool_use entries) */
  input?: Record<string, unknown>;

  // ── tool_result fields ──
  /** Tool output content (present on tool_result entries) */
  content?: string;
  /** Whether the tool call errored (present on tool_result entries) */
  isError?: boolean;

  /** Present on the header line only */
  _run?: boolean;
  runId?: string;
  taskId?: string;
  agentName?: string;
  startedAt?: string;
  pid?: number;
}

/**
 * Composite task activity response — returned by GET /tasks/:id/activity.
 * Bundles the task row, its current run, the resolved log session, and
 * the session entries in a single call so dashboards don't have to fan
 * out across getTask + getRun + listSessions + getSessionEntries.
 */
export interface TaskActivityPayload {
  /** The task row (null if the task doesn't exist). */
  task: Task | null;
  /** The current run for the task (null if never executed). */
  run: AgentProcess | null;
  /** Resolved log session ID, or null if no session could be matched. */
  sessionId: string | null;
  /** How `sessionId` was resolved:
   *  - "explicit": from run.sessionId / task.sessionId set by the runner
   *  - "matched-log-session": time-window match against log_sessions
   *  - "missing": no session found
   */
  sessionResolution: "explicit" | "matched-log-session" | "missing";
  /** Log entries for the resolved session (empty if sessionId is null). */
  entries: LogEntry[];
}

// === Skill types ===






/** Request body for creating a new skill. */
export interface CreateSkillRequest {
  name: string;
  description: string;
  content: string;
  allowedTools?: string[];
}

/** Result of installing skills from a source (GitHub repo or local path). */
export interface InstallSkillsResult {
  installed: string[];
  skipped: string[];
  errors: string[];
  source: string;
}

/** Options for installing skills. */
export interface InstallSkillsOptions {
  skillNames?: string[];
  force?: boolean;
}

/** Request body for creating a schedule. */
export interface CreateScheduleRequest {
  missionId: string;
  expression: string;
  recurring?: boolean;
  endDate?: string;
}

/** Request body for updating a schedule. */
export interface UpdateScheduleRequest {
  expression?: string;
  recurring?: boolean;
  enabled?: boolean;
  endDate?: string | null;
}

/** Manual trigger input. Reusing a key returns the same durable Schedule Run. */
export interface TriggerScheduleRequest {
  idempotencyKey: string;
}

/** V2 schedules return the deleted record; legacy adapters wrap compatibility. */
export type DeleteScheduleResult =
  | Schedule
  | { deleted: true; schedule: Schedule };

/** Request body for creating/updating a playbook. */
export interface CreatePlaybookRequest {
  name: string;
  description: string;
  mission: Record<string, unknown>;
  parameters?: PlaybookParameter[];
}

// === Chat Session types ===

export interface ChatSession {
  id: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  /** Agent name when this session targets a specific agent (agent-direct mode). Absent for orchestrator sessions. */
  agent?: string;
  /** Opaque end-user identifier (OpenAI-compat). Present when scoped to a specific end-user. */
  user?: string;
  /** Arbitrary key/value tags attached at create time. */
  metadata?: Record<string, string>;
}

/** An ordered segment in the assistant message stream. */
export type MessageSegment =
  | { type: "text"; content: string }
  | { type: "tool_call"; toolCall: ToolCallEvent };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string | ContentPart[];
  ts: string;
  /** Tool calls executed during this assistant message (only for role=assistant) */
  toolCalls?: ToolCallEvent[];
  /** Ordered segments preserving chronological interleaving of text and tool calls (assistant only). */
  segments?: MessageSegment[];
}

// === Chat Completions types (OpenAI-compatible) ===

/** A text content part. */
export interface TextContentPart {
  type: "text";
  text: string;
}

/** An image content part (data URL or HTTPS URL). */
export interface ImageUrlContentPart {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "auto" | "low" | "high";
  };
}

/** A file content part — references an uploaded attachment by ID. */
export interface FileContentPart {
  type: "file";
  /** Attachment ID from a previous upload. */
  file_id: string;
}

export type ContentPart = TextContentPart | ImageUrlContentPart | FileContentPart;

export interface ChatCompletionMessage {
  role: "system" | "user" | "assistant" | "tool";
  /** Plain string or multimodal content parts (text, images, files). */
  content: string | ContentPart[];
  /** Tool calls made by the assistant (for assistant messages with client-side tool calls). */
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  /** ID of the tool call this message responds to (for role=tool). */
  tool_call_id?: string;
  /** Tool name (for role=tool). */
  name?: string;
}

/**
 * Runtime choices already accepted by the OpenAI-compatible completion
 * endpoint. Keeping them in one contract lets higher-level SDKs expose the
 * same request controls without redefining their wire shape.
 */
export interface RuntimeCompletionRequestOptions {
  /** Optional per-request model override for the selected agent. */
  model?: string;
  /** Optional runtime sandbox policy for this chat request. */
  sandbox?: RuntimeSandboxOptions;
  /** Target a project-level loop assigned to the selected agent. */
  loop?: string;
}

export interface ChatCompletionRequest extends RuntimeCompletionRequestOptions {
  messages: ChatCompletionMessage[];
  stream?: boolean;
  /** Polpo extension: target a specific project by ID. If omitted, uses the first registered project. */
  project?: string;
  /** Session ID for conversation persistence. If omitted, server auto-selects or creates one. */
  sessionId?: string;
  /** Target a specific agent by name for direct conversation. Uses the agent's own model, system prompt, and coding tools. Omit to talk to the orchestrator (default). */
  agent?: string;
  /**
   * Opaque end-user identifier (OpenAI-compat). Persisted on the session and
   * available for filtering, per-user analytics, and pass-through to billing
   * integrations (e.g. Autumn customer_id).
   */
  user?: string;
  /**
   * Arbitrary key/value tags (OpenAI-compat). Up to 16 keys, key ≤64 chars,
   * value ≤512 chars. Use for tenant_id, plan, identity_provider, ab_variant.
   */
  metadata?: Record<string, string>;
}

export interface ChatCompletionChoice {
  index: number;
  message: { role: "assistant"; content: string };
  finish_reason: "stop" | "length" | "tool_calls" | "ask_user" | "mission_preview" | "vault_preview" | "open_file" | "navigate_to" | "open_tab";
  /** Present when finish_reason is "ask_user" — structured questions for the user. */
  ask_user?: AskUserPayload;
  /** Present when finish_reason is "mission_preview" — proposed mission for user review. */
  mission_preview?: MissionPreviewPayload;
  /** Present when finish_reason is "vault_preview" — proposed vault entry for user review. */
  vault_preview?: VaultPreviewPayload;
  /** Present when finish_reason is "open_file" — file path to open in preview dialog. */
  open_file?: OpenFilePayload;
  /** Present when finish_reason is "navigate_to" — navigate the UI to a specific page. */
  navigate_to?: NavigateToPayload;
  /** Present when finish_reason is "open_tab" — open a URL in a new browser tab. */
  open_tab?: OpenTabPayload;
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  /** Polpo extension: structured runtime trace for project loop executions. */
  loop_trace?: LoopTraceEvent[];
  /** Polpo extension: durable loop run id, when loop run persistence is configured. */
  loop_run_id?: string;
}

export interface ChatCompletionChunkDelta {
  role?: string;
  content?: string;
  /** Standard OpenAI tool_calls in the delta (for client-side tools like ask_user_question). */
  tool_calls?: Array<{
    index: number;
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

// === Tool Call streaming ===


export interface ToolCallEvent {
  /** Tool call ID from the LLM */
  id: string;
  /** Tool name (e.g. "create_task", "get_status") */
  name: string;
  /** Tool input arguments (present when state is "calling") */
  arguments?: Record<string, unknown>;
  /**
   * Raw arguments JSON accumulated so far, streamed token-by-token while the
   * model is still generating the call (state "preparing"). Partial and may
   * not parse as JSON until complete; superseded by `arguments` once "calling".
   * Lets the UI show the tool input live instead of waiting for the full call.
   */
  argumentsText?: string;
  /** Tool execution result (present when state is "completed" or "error") */
  result?: string;
  /** Current state of the tool call */
  state: ToolCallState;
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: ChatCompletionChunkDelta;
    finish_reason: string | null;
    /** Present when finish_reason is "ask_user" — structured questions for the user. */
    ask_user?: AskUserPayload;
    /** Present when finish_reason is "mission_preview" — proposed mission for user review. */
    mission_preview?: MissionPreviewPayload;
    /** Present when finish_reason is "vault_preview" — proposed vault entry for user review. */
    vault_preview?: VaultPreviewPayload;
    /** Present when finish_reason is "open_file" — file path to open in preview dialog. */
    open_file?: OpenFilePayload;
    /** Present when finish_reason is "navigate_to" — navigate the UI to a specific page. */
    navigate_to?: NavigateToPayload;
    /** Present when finish_reason is "open_tab" — open a URL in a new browser tab. */
    open_tab?: OpenTabPayload;
    /** Present when the server is executing a tool call. */
    tool_call?: ToolCallEvent;
    /** Present when a project loop runtime trace event is emitted. */
    loop_trace?: LoopTraceEvent;
    /** Present when the model is emitting thinking/reasoning tokens. */
    thinking?: string;
  }>;
}

// === Ask User (structured clarification questions) ===



export interface AskUserPayload {
  questions: AskUserQuestion[];
}


// === Mission Preview (interactive review before creation) ===

export interface MissionPreviewPayload {
  /** Proposed mission name */
  name: string;
  /** Parsed mission document (tasks, qualityGates, etc.) */
  data: unknown;
  /** Original user prompt that generated this mission */
  prompt?: string;
}

// === Vault Entry Metadata (safe listing — no secret values) ===

export interface VaultEntryMeta {
  /** Service name (vault key, e.g. "gmail", "stripe") */
  service: string;
  /** Credential type */
  type: "smtp" | "imap" | "oauth" | "api_key" | "login" | "custom";
  /** Human-readable label */
  label?: string;
  /** Credential field names (e.g. ["host", "port", "user", "pass"]) — values are NOT exposed */
  keys: string[];
}

// === Auth Profile Metadata (safe — no tokens exposed) ===

export type AuthProfileStatus = "active" | "cooldown" | "billing_disabled" | "expired";
export type AuthProfileType = "oauth" | "api_key";

/** Metadata for a single auth profile — tokens are NEVER exposed. */
export interface AuthProfileMeta {
  id: string;
  type: AuthProfileType;
  email?: string;
  expires?: number;
  expired: boolean;
  hasRefresh: boolean;
  lastUsed?: string;
  createdAt: string;
  status: AuthProfileStatus;
  cooldownUntil?: number;
  disabledUntil?: number;
  lastErrorReason?: string;
  disabledReason?: string;
  errorCount?: number;
}

/** Per-provider auth health info. */
export interface ProviderAuthInfo {
  hasEnvKey: boolean;
  envVar?: string;
  profiles: AuthProfileMeta[];
  oauthAvailable: boolean;
  oauthProviderName?: string;
  oauthFlow?: string;
}

/** Full auth status response — all providers. */
export interface AuthStatusResponse {
  providers: Record<string, ProviderAuthInfo>;
}

// === Vault Preview (interactive credential review before saving) ===

export interface VaultPreviewPayload {
  /** Agent name */
  agent: string;
  /** Service name (vault key, e.g. "gmail", "stripe") */
  service: string;
  /** Credential type */
  type: "smtp" | "imap" | "oauth" | "api_key" | "login" | "custom";
  /** Human-readable label */
  label?: string;
  /** Credential key-value pairs — user can edit before confirming */
  credentials: Record<string, string>;
}

// === Client-side tools (executed on the user's device, not the server) ===

export interface OpenFilePayload {
  /** File path relative to project root */
  path: string;
}

export interface NavigateToPayload {
  /** Target page: dashboard, tasks, task, missions, mission, agents, agent, skills, skill, files, activity, chat, memory, settings */
  target: string;
  /** Entity ID for detail pages (task, mission) */
  id?: string;
  /** Entity name for detail pages (agent, skill) */
  name?: string;
  /** Directory path for files target */
  path?: string;
  /** File to highlight/select for files target */
  highlight?: string;
}

/** Payload for open_tab — opens a URL in a new browser tab. */
export interface OpenTabPayload {
  /** The URL to open */
  url: string;
  /** Optional human-readable label */
  label?: string;
}
