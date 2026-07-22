/**
 * Task domain — task lifecycle, expectations, outcomes, watchers.
 */

import type { EvalDimension, AssessmentResult } from "./assessment.js";
import type { ScopedNotificationRules, NotificationAction } from "./notifications.js";
import type { RuntimeSandboxOptions } from "../runtime-sandbox.js";

// === Task ===

export type TaskStatus =
  | "draft"
  | "pending"
  | "awaiting_approval"
  | "assigned"
  | "in_progress"
  | "review"
  | "done"
  | "failed";

export interface TaskExpectation {
  type: "test" | "file_exists" | "script" | "llm_review";
  command?: string;
  paths?: string[];
  criteria?: string;
  /** For llm_review: evaluation dimensions with weights and rubrics */
  dimensions?: EvalDimension[];
  /** For llm_review: minimum weighted score (1-5) to pass. Default 3.0 */
  threshold?: number;
  /** Whether this expectation is a firm requirement or an estimate that can be auto-corrected.
   *  Default: "estimated" for file_exists, "firm" for test/script/llm_review. */
  confidence?: "firm" | "estimated";
}

export interface TaskMetric {
  name: string;
  command: string;
  threshold: number;
}

export interface RetryPolicy {
  /** After this many failures, escalate to fallbackAgent */
  escalateAfter?: number;
  /** Agent to use for escalation retries */
  fallbackAgent?: string;
  /** Model override for escalation (e.g. switch from haiku to sonnet) */
  escalateModel?: string;
}

export type TaskPhase = "execution" | "review" | "fix" | "clarification";

// === Outcomes ===

/** What type of artifact a task can produce. */
export type OutcomeType = "file" | "text" | "url" | "json" | "media";

/**
 * A concrete artifact produced by a task at runtime.
 * Populated automatically by tool interception and/or explicitly by agent output.
 */
export interface TaskOutcome {
  /** Unique outcome ID (nanoid). */
  id: string;
  /** Outcome category. */
  type: OutcomeType;
  /** Human-readable label (e.g. "Sales Report", "Transcription", "Generated Audio"). */
  label: string;

  // --- Type-specific payload ---

  /** file/media: relative or absolute path to the produced file. */
  path?: string;
  /** file/media: MIME type (auto-detected from extension or explicit). */
  mimeType?: string;
  /** file/media: file size in bytes. */
  size?: number;
  /** text: the content itself (transcription, summary, analysis, etc.). */
  text?: string;
  /** url: link to external resource (deploy URL, PR, page, etc.). */
  url?: string;
  /** json: structured data payload (query results, metrics, report, etc.). */
  data?: unknown;

  // --- Metadata ---

  /** Tool name that generated this outcome (auto-collected). */
  producedBy?: string;
  /** ISO timestamp when the outcome was created. */
  producedAt: string;
  /** User-defined tags for filtering and categorization. */
  tags?: string[];
}

/**
 * Declared in task/mission definitions — tells the agent what it should produce.
 * Used for validation: the orchestrator checks that expected outcomes are fulfilled.
 */
export interface ExpectedOutcome {
  /** Expected outcome type. */
  type: OutcomeType;
  /** Human-readable label — also used to match against produced TaskOutcome.label. */
  label: string;
  /** Hints for the agent about what to produce. */
  description?: string;
  /** Expected file path (optional — agent can choose). */
  path?: string;
  /** Expected MIME type (e.g. "audio/mpeg", "application/pdf"). */
  mimeType?: string;
  /** Whether this outcome is required for the task to pass. Default: true. */
  required?: boolean;
  /** Tags to auto-apply to the produced outcome. */
  tags?: string[];
}

export interface Task {
  id: string;
  title: string;
  description: string;
  assignTo: string;
  /** Project loop this task runs (a name in the agent's assignedLoops, or an
   *  inline loop). Explicit — omitted means the agent runs as-is, no loop. */
  loop?: string;
  group?: string;
  /** ID of the mission this task belongs to (set when created via executeMission). */
  missionId?: string;
  dependsOn: string[];
  status: TaskStatus;
  expectations: TaskExpectation[];
  metrics: TaskMetric[];
  retries: number;
  maxRetries: number;
  maxDuration?: number;       // ms, 0 = no timeout
  retryPolicy?: RetryPolicy;
  result?: TaskResult;
  phase?: TaskPhase;             // current phase (execution/review/fix/clarification)
  fixAttempts?: number;          // fix attempts in current review cycle
  questionRounds?: number;       // Q&A rounds with orchestrator (max default: 2)
  resolutionAttempts?: number;   // deadlock resolution attempts (max default: 2)
  originalDescription?: string;  // preserved before first retry/fix
  sessionId?: string;            // SDK session ID from the last agent run (for transcript access)
  /** Absolute deadline (ISO timestamp). Task is SLA-violated if not done by this time. */
  deadline?: string;
  /** Priority weight for quality scoring (higher = more important). Default: 1.0 */
  priority?: number;
  /** Declared expected outcomes — what this task should produce. */
  expectedOutcomes?: ExpectedOutcome[];
  /** Actual outcomes produced at runtime (auto-collected + explicit). */
  outcomes?: TaskOutcome[];
  /** Number of approval revision rounds this task has gone through. */
  revisionCount?: number;
  /** Scoped notification rules — override or extend global/mission rules for this task. */
  notifications?: ScopedNotificationRules;
  /**
   * Whether this task produces irreversible side effects (email sends, API calls,
   * WhatsApp messages, etc.). When true, automatic retry/fix is blocked and the
   * task transitions to `awaiting_approval` so a human can approve re-execution.
   * Set by the orchestrator LLM when creating/planning tasks.
   */
  sideEffects?: boolean;
  /**
   * Opaque end-user identifier (OpenAI-compat `user`). Set by integrators to
   * scope this task to their authenticated end-user. Polpo never verifies it.
   * Propagates from Task → Run for per-user attribution and metering.
   */
  user?: string;
  /** Execution mode override for this task (wins over agent and settings). */
  executionMode?: import("./config.js").ExecutionMode;
  /** Runtime sandbox policy override for this task (wins over agent and settings). */
  sandbox?: RuntimeSandboxOptions;
  createdAt: string;
  updatedAt: string;
}

export interface TaskResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  duration: number;
  assessment?: AssessmentResult;
  /** All previous assessments (oldest first). Current assessment is always in `assessment`. */
  assessmentHistory?: AssessmentResult[];
}

// === Ask User (structured clarification questions) ===

export interface AskUserOption {
  label: string;
  description?: string;
}

export interface AskUserQuestion {
  /** Unique question key for matching answers (e.g. "auth-method") */
  id: string;
  /** The question text */
  question: string;
  /** Short label for compact display (max 30 chars) */
  header?: string;
  /** Pre-populated selectable options */
  options: AskUserOption[];
  /** Allow selecting multiple options (default: false) */
  multiple?: boolean;
  /** Whether to add a "Type your own answer" custom input (default: true) */
  custom?: boolean;
}

export interface AskUserAnswer {
  questionId: string;
  /** Labels of selected options */
  selected: string[];
  /** Custom text typed by user (if custom input was used) */
  customText?: string;
}

export interface AskUserRequest {
  questions: AskUserQuestion[];
}

// === Task Watchers ===

/** A watcher that fires an action when a task reaches a target status. */
export interface TaskWatcher {
  /** Unique watcher ID. */
  id: string;
  /** Task ID to watch. */
  taskId: string;
  /** Target status to trigger on. */
  targetStatus: TaskStatus;
  /** Action to execute when triggered. */
  action: NotificationAction;
  /** Whether the watcher has already fired. */
  fired: boolean;
  /** Created at (ISO). */
  createdAt: string;
  /** Fired at (ISO). */
  firedAt?: string;
}
