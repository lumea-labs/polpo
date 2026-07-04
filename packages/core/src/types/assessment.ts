/**
 * Assessment domain — evaluation dimensions, reviewer results, assessment
 * outcomes, and the review context passed to LLM reviewers.
 */

import type { TaskExpectation, TaskOutcome, TaskResult } from "./task.js";

export interface EvalDimension {
  name: string;              // e.g. "correctness", "completeness"
  description: string;       // what this dimension measures
  weight: number;            // 0-1, weights should sum to ~1
  rubric?: Record<number, string>; // 1-5 score descriptions per level
}

export interface DimensionScore {
  dimension: string;         // dimension name
  score: number;             // 1-5
  reasoning: string;         // chain-of-thought for this score
  weight: number;            // weight used for global score
  evidence?: { file: string; line: number; note: string }[];
}

// === Assessment ===

/** Serializable representation of a single message in the reviewer's conversation */
export interface ReviewerMessage {
  role: "user" | "assistant" | "toolResult";
  /** For user/assistant: text content. For toolResult: the tool output text. */
  content: string;
  /** Tool calls made by the assistant (if role === "assistant") */
  toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[];
  /** For toolResult messages */
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  timestamp: number;
}

/** Phase 1 exploration trace from a single reviewer */
export interface ReviewerExploration {
  /** Full analysis text produced by the reviewer during exploration */
  analysis: string;
  /** Files read by the reviewer during exploration */
  filesRead: string[];
  /** Complete conversation (user prompts, assistant responses, tool calls & results) */
  messages: ReviewerMessage[];
}

/** Individual reviewer result from llm_review multi-evaluator consensus */
export interface ReviewerResult {
  /** Reviewer index (1-based) */
  index: number;
  /** Per-dimension scores from this reviewer */
  scores: { dimension: string; score: number; reasoning: string; evidence?: { file: string; line: number; note: string }[] }[];
  /** Reviewer's summary */
  summary: string;
  /** Weighted average score for this reviewer */
  globalScore: number;
  /** Phase 1 exploration trace (analysis, files read, full conversation) */
  exploration?: ReviewerExploration;
  /** Errors from scoring strategy attempts (Phase 2 fallback chain) */
  scoringAttemptErrors?: string[];
}

export interface CheckResult {
  type: TaskExpectation["type"];
  passed: boolean;
  message: string;
  details?: string;
  /** Per-dimension scores from llm_review (consensus/median) */
  scores?: DimensionScore[];
  /** Weighted average score (1-5) from llm_review */
  globalScore?: number;
  /** Individual reviewer results (llm_review only) — shows how each reviewer voted */
  reviewers?: ReviewerResult[];
}

export interface MetricResult {
  name: string;
  value: number;
  threshold: number;
  passed: boolean;
}

export type AssessmentTrigger = "initial" | "reassess" | "fix" | "retry" | "auto-correct" | "judge";

export interface AssessmentResult {
  passed: boolean;
  checks: CheckResult[];
  metrics: MetricResult[];
  llmReview?: string;            // LLM reviewer's detailed feedback
  scores?: DimensionScore[];     // aggregated dimension scores
  globalScore?: number;          // aggregated weighted score (1-5)
  timestamp: string;
  /** What triggered this assessment. Defaults to "initial" for backwards compatibility. */
  trigger?: AssessmentTrigger;
}

/**
 * Replace the current assessment on a TaskResult, archiving the old one in assessmentHistory.
 * Also tags the new assessment with the given trigger.
 */
export function setAssessment(result: TaskResult, assessment: AssessmentResult, trigger: AssessmentTrigger): void {
  if (result.assessment) {
    if (!result.assessmentHistory) result.assessmentHistory = [];
    result.assessmentHistory.push(result.assessment);
  }
  assessment.trigger = trigger;
  result.assessment = assessment;
}

// === Review Context (passed to LLM reviewers for richer assessment) ===

export interface ReviewContext {
  taskTitle: string;
  taskDescription: string;

  // --- Agent output ---
  /** Last assistant message from the agent conversation. */
  agentOutput?: string;
  /** Agent stderr (errors, warnings). */
  agentStderr?: string;
  /** Agent exit code. */
  exitCode?: number;
  /** Agent execution duration in ms. */
  duration?: number;

  // --- File activity ---
  filesCreated?: string[];
  filesEdited?: string[];

  // --- Execution metadata ---
  /** Total tool calls made by the agent. */
  toolCalls?: number;
  /** Summary of tools used (name → count). */
  toolsSummary?: string;

  // --- Execution transcript ---
  /**
   * Structured execution timeline built from the JSONL activity log.
   * Shows what the agent did step-by-step: tool calls, text messages, outcomes.
   * This is the primary evidence for reviewing non-file-based tasks.
   */
  executionSummary?: string;

  // --- Registered outcomes ---
  /** Explicit outcomes registered by the agent (files, text, URLs, JSON data). */
  outcomes?: TaskOutcome[];
}
