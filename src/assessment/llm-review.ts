/**
 * G-Eval LLM-as-Judge review using Vercel AI SDK.
 *
 * Architecture: 2-phase review for reliability.
 *
 * Phase 1 — EXPLORATION (tool loop via generateText + maxSteps)
 *   The reviewer explores the codebase using read_file, glob, grep.
 *   AI SDK handles the tool loop internally via `stopWhen: stepCountIs(20)`.
 *   After exploration, we collect all assistant text as the "analysis".
 *
 * Phase 2 — SCORING (structured output via Output.object)
 *   A separate generateText call receives the full analysis from Phase 1
 *   and produces structured scores via Output.object() — the provider
 *   enforces JSON schema compliance, zero manual parsing needed.
 *
 * This separation makes the system robust: exploration failures don't
 * block scoring, and scoring failures are isolated from exploration.
 *
 * Runs 3 independent reviewers in parallel (multi-evaluator consensus).
 */

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, relative } from "node:path";
import { z } from "zod";
import {
  generateText,
  Output,
  tool,
  stepCountIs,
} from "ai";
import type { TaskExpectation, EvalDimension, DimensionScore, CheckResult, ReviewContext, ReviewerMessage } from "../core/types.js";
import { DEFAULT_DIMENSIONS, buildRubricSection, computeWeightedScore, computeMedianScores } from "./scoring.js";
import { validateReviewPayload, type ValidatedReviewPayload } from "./schemas.js";
import { ReviewPayloadSchema } from "@polpo-ai/core/assessment-schemas";
import { withRetry } from "../llm/retry.js";
import { resolveModel, mapReasoningToProviderOptions } from "../llm/pi-client.js";
import type { ResolvedModel } from "../llm/pi-client.js";
import type { ReasoningLevel } from "../core/types.js";

export type LLMQueryFn = (prompt: string, cwd: string) => Promise<string>;

interface ReviewPayload {
  scores: { dimension: string; score: number; reasoning: string; evidence?: { file: string; line: number; note: string }[] }[];
  summary: string;
  /** Phase 1 exploration trace — carried through for persistence */
  exploration?: {
    analysis: string;
    filesRead: string[];
    messages: ReviewerMessage[];
  };
  /** Errors from Phase 2 scoring attempt */
  scoringAttemptErrors?: string[];
}

// ── Tool Execution Helpers ────────────────────────────────────────────

function readFileImpl(cwd: string, args: { path: string; limit?: number }): string {
  const filePath = resolve(cwd, args.path);
  try {
    const raw = readFileSync(filePath, "utf-8");
    const lines = raw.split("\n");
    const limit = args.limit ?? 500;
    const sliced = lines.slice(0, limit);
    return sliced.map((l, i) => `${i + 1}\t${l}`).join("\n") +
      (lines.length > limit ? `\n... (${lines.length - limit} more lines)` : "");
  } catch (err) {
    return `Error reading ${args.path}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function globImpl(cwd: string, args: { pattern: string }): string {
  try {
    const result = execSync(
      `find ${JSON.stringify(cwd)} -type f -name ${JSON.stringify(args.pattern)} 2>/dev/null | head -200`,
      { encoding: "utf-8", timeout: 10_000 },
    ).trim();
    return result ? result.split("\n").map(f => relative(cwd, f)).join("\n") : "No files found";
  } catch {
    return "No files found";
  }
}

function grepImpl(cwd: string, args: { pattern: string; include?: string }): string {
  const includeFlag = args.include ? `--include=${JSON.stringify(args.include)}` : "";
  try {
    const result = execSync(
      `grep -rn ${includeFlag} -E ${JSON.stringify(args.pattern)} ${JSON.stringify(cwd)} 2>/dev/null | head -100`,
      { encoding: "utf-8", timeout: 15_000 },
    ).trim();
    return result || "No matches found";
  } catch {
    return "No matches found";
  }
}

// ── Build exploration tools for AI SDK ────────────────────────────────

function buildExplorationTools(cwd: string, filesRead: string[], onProgress?: (msg: string) => void) {
  return {
    read_file: tool({
      description: "Read the contents of a file. Returns numbered lines.",
      inputSchema: z.object({
        path: z.string().describe("File path relative to project root"),
        limit: z.number().optional().describe("Max lines to read (default: 500)"),
      }),
      execute: async (args) => {
        filesRead.push(args.path);
        onProgress?.(`Reading ${args.path.split("/").pop()}`);
        return readFileImpl(cwd, args);
      },
    }),
    glob: tool({
      description: "Find files matching a pattern. Returns file paths.",
      inputSchema: z.object({
        pattern: z.string().describe("Glob pattern (e.g. '*.ts', 'src/**/*.js')"),
      }),
      execute: async (args) => {
        onProgress?.(`Searching ${args.pattern}`);
        return globImpl(cwd, args);
      },
    }),
    grep: tool({
      description: "Search for a pattern in files. Returns matching lines with paths and line numbers.",
      inputSchema: z.object({
        pattern: z.string().describe("Regex pattern to search for"),
        include: z.string().optional().describe("File glob filter (e.g. '*.ts')"),
      }),
      execute: async (args) => {
        onProgress?.(`Grep: ${String(args.pattern).slice(0, 30)}`);
        return grepImpl(cwd, args);
      },
    }),
  };
}

// ── Trace Serialization ───────────────────────────────────────────────

/** Convert AI SDK steps to serializable ReviewerMessage[] for persistence */
function serializeSteps(steps: ReadonlyArray<{ readonly text: string; readonly toolCalls: ReadonlyArray<any>; readonly toolResults: ReadonlyArray<any> }>): ReviewerMessage[] {
  const messages: ReviewerMessage[] = [];
  for (const step of steps) {
    // Assistant message with text + tool calls
    const toolCalls = step.toolCalls.map(tc => ({
      id: tc.toolCallId,
      name: tc.toolName,
      arguments: tc.input as Record<string, unknown>,
    }));
    messages.push({
      role: "assistant" as const,
      content: step.text || "",
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      timestamp: Date.now(),
    });
    // Tool result messages
    for (const tr of step.toolResults) {
      messages.push({
        role: "toolResult" as const,
        content: typeof tr.result === "string" ? tr.result : JSON.stringify(tr.result),
        toolCallId: tr.toolCallId,
        toolName: tr.toolName,
        isError: false,
        timestamp: Date.now(),
      });
    }
  }
  return messages;
}

// ── Phase 1: Exploration ───────────────────────────────────────────────

const MAX_EXPLORATION_STEPS = 20;

/**
 * Phase 1: Let the reviewer freely explore the codebase.
 * Returns the accumulated analysis text from all assistant messages.
 */
async function runExploration(
  reviewPrompt: string,
  cwd: string,
  model: string | undefined,
  onProgress?: (msg: string) => void,
  reasoning?: ReasoningLevel,
): Promise<{ analysis: string; filesRead: string[]; messages: ReviewerMessage[] }> {
  const m = resolveModel(model);
  const providerOptions = mapReasoningToProviderOptions(m.provider, reasoning, m.maxTokens);

  const filesRead: string[] = [];
  const explorationTools = buildExplorationTools(cwd, filesRead, onProgress);

  const result = await generateText({
    model: m.aiModel,
    system: "You are a thorough code reviewer. Use tools to explore the codebase. Focus on finding evidence for each evaluation dimension. Do NOT attempt to output scores as text \u2014 you will be given a dedicated scoring step after exploration.",
    prompt: reviewPrompt,
    tools: explorationTools,
    stopWhen: stepCountIs(MAX_EXPLORATION_STEPS),
    ...(providerOptions ? { providerOptions: providerOptions as Record<string, Record<string, any>> } : {}),
  });

  // Collect all assistant text across steps as the analysis
  const analysisBlocks: string[] = [];
  for (const step of result.steps) {
    if (step.text.trim()) {
      analysisBlocks.push(step.text);
    }
  }

  return {
    analysis: analysisBlocks.join("\n\n") || "The reviewer explored the codebase but produced no written analysis.",
    filesRead,
    messages: serializeSteps(result.steps),
  };
}

// ── Phase 2: Scoring ───────────────────────────────────────────────────

const SCORING_SYSTEM_PROMPT = `You are a code review scorer. You have received a detailed analysis of code from Phase 1.
Your ONLY job is to convert this analysis into structured scores.
Output a JSON object matching the required schema. Score each dimension 1-5 based on the rubric.
Each reasoning MUST include specific file:line references from the analysis.`;

/**
 * Phase 2: Given the exploration analysis, force the model to produce
 * structured scores via Output.object() — the provider enforces JSON schema.
 *
 * This replaces the old 3-strategy fallback chain (toolChoice -> prompt -> raw JSON)
 * with a single call. AI SDK handles structured output at the provider level.
 */
async function runScoring(
  analysis: string,
  rubricSection: string,
  dimNames: string,
  model: string | undefined,
  onProgress?: (msg: string) => void,
  reasoning?: ReasoningLevel,
): Promise<{ payload: ReviewPayload | null; attemptErrors: string[] }> {
  const m = resolveModel(model);
  const providerOptions = mapReasoningToProviderOptions(m.provider, reasoning, m.maxTokens);

  const scoringPrompt = `Based on the following code analysis, produce structured scores for each dimension.

ANALYSIS FROM CODE EXPLORATION:
${analysis.slice(0, 12000)}

EVALUATION DIMENSIONS AND RUBRICS:
${rubricSection}

DIMENSIONS TO SCORE: ${dimNames}

RULES:
- Score each dimension 1-5 as an integer.
- Your reasoning MUST reference specific file:line evidence from the analysis above.
- Include ALL dimension scores and a summary.`;

  const attemptErrors: string[] = [];

  onProgress?.("Scoring with structured output...");
  try {
    const result = await generateText({
      model: m.aiModel,
      system: SCORING_SYSTEM_PROMPT,
      prompt: scoringPrompt,
      output: Output.object({ schema: ReviewPayloadSchema }),
      ...(providerOptions ? { providerOptions: providerOptions as Record<string, Record<string, any>> } : {}),
    });

    const raw = result.output;
    if (!raw) {
      attemptErrors.push("Output.object() returned null/undefined");
      return { payload: null, attemptErrors };
    }

    // Run through validateReviewPayload for normalization (coercion, clamping, etc.)
    const validated = validateReviewPayload(raw);
    if (validated.success) {
      return { payload: validated.data as ReviewPayload, attemptErrors };
    }

    attemptErrors.push(`Structured output validation failed: ${validated.error}`);
  } catch (err) {
    attemptErrors.push(`Structured output: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Fallback: try plain text generation and parse JSON from response
  onProgress?.("Fallback: requesting plain text JSON scores...");
  try {
    const fallbackResult = await generateText({
      model: m.aiModel,
      system: "You are a JSON-only scorer. Output ONLY valid JSON matching the requested schema. No markdown fences, no explanations, no commentary \u2014 just the raw JSON object.",
      prompt: `Score these dimensions based on the analysis below. Return ONLY a JSON object, no other text.

DIMENSIONS: ${dimNames}

ANALYSIS:
${analysis.slice(0, 8000)}

Return this exact JSON structure (nothing else):
{"scores":[{"dimension":"<name>","score":<1-5>,"reasoning":"<brief>"}],"summary":"<overall summary>"}`,
      ...(providerOptions ? { providerOptions: providerOptions as Record<string, Record<string, any>> } : {}),
    });

    const parsed = tryParseReviewJSON(fallbackResult.text);
    if (parsed) return { payload: parsed, attemptErrors };
    attemptErrors.push(`Fallback JSON parse failed. Text preview: ${fallbackResult.text.slice(0, 200)}`);
  } catch (err) {
    attemptErrors.push(`Fallback: ${err instanceof Error ? err.message : String(err)}`);
  }

  onProgress?.(`All scoring strategies failed (provider: ${m.provider}):\n${attemptErrors.join("\n")}`);
  return { payload: null, attemptErrors };
}

/** Try to extract a ReviewPayload from free-text JSON output, validated with Zod. */
function tryParseReviewJSON(output: string): ReviewPayload | null {
  if (!output || !output.trim()) return null;
  let text = output.trim();

  // Strip markdown code fences (```json ... ``` or ``` ... ```)
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) text = fenceMatch[1].trim();

  // Find the outermost JSON object
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  let jsonStr = jsonMatch[0];

  // Common LLM JSON quirks: trailing commas, single quotes, comments
  jsonStr = jsonStr.replace(/,\s*([}\]])/g, "$1");                      // trailing commas
  jsonStr = jsonStr.replace(/\/\/[^\n]*/g, "");                          // single-line comments
  jsonStr = jsonStr.replace(/\/\*[\s\S]*?\*\//g, "");                   // block comments

  // Try parsing and validating with Zod
  const tryParse = (s: string): ReviewPayload | null => {
    try {
      const parsed = JSON.parse(s);
      const result = validateReviewPayload(parsed);
      if (result.success) return result.data as ReviewPayload;
    } catch { /* fall through */ }
    return null;
  };

  // Attempt 1: direct parse
  const direct = tryParse(jsonStr);
  if (direct) return direct;

  // Attempt 2: replace single quotes with double quotes (common LLM mistake)
  if (!jsonStr.includes('"') && jsonStr.includes("'")) {
    const doubleQuoted = jsonStr.replace(/'/g, '"');
    const sq = tryParse(doubleQuoted);
    if (sq) return sq;
  }

  return null;
}

// ── Combined Single Review (Phase 1 + Phase 2) ────────────────────────

async function runSingleReview(
  explorationPrompt: string,
  rubricSection: string,
  dimNames: string,
  cwd: string,
  model: string | undefined,
  onProgress?: (msg: string) => void,
  reasoning?: ReasoningLevel,
  skipExploration?: boolean,
): Promise<ReviewPayload | null> {
  let analysis: string;
  let filesRead: string[] = [];
  let explorationMessages: ReviewerMessage[] = [];

  if (skipExploration) {
    // Output-based review: the prompt already contains all the evidence.
    // Run a single LLM call to produce the analysis from the provided context.
    onProgress?.("Analyzing execution evidence (no file exploration needed)...");
    const m = resolveModel(model);
    const providerOptions = mapReasoningToProviderOptions(m.provider, reasoning, m.maxTokens);

    const result = await generateText({
      model: m.aiModel,
      system: "You are a thorough reviewer. Analyze the provided execution evidence and write a detailed assessment for each evaluation dimension. Do NOT attempt to output scores as text \u2014 you will be given a dedicated scoring step after your analysis.",
      prompt: explorationPrompt,
      ...(providerOptions ? { providerOptions: providerOptions as Record<string, Record<string, any>> } : {}),
    });

    analysis = result.text.trim() || "The reviewer analyzed the execution evidence but produced no written analysis.";
    explorationMessages = [{
      role: "user" as const,
      content: explorationPrompt,
      timestamp: Date.now(),
    }, {
      role: "assistant" as const,
      content: result.text,
      timestamp: Date.now(),
    }];
  } else {
    // File-based review: explore the codebase with tools
    onProgress?.("Phase 1: Exploring codebase...");
    const result = await runExploration(explorationPrompt, cwd, model, onProgress, reasoning);
    analysis = result.analysis;
    filesRead = result.filesRead;
    explorationMessages = result.messages;
    onProgress?.(`Exploration complete \u2014 read ${filesRead.length} files, ${analysis.length} chars of analysis.`);
  }

  // Phase 2: Score
  onProgress?.("Phase 2: Producing structured scores...");
  const { payload, attemptErrors } = await runScoring(analysis, rubricSection, dimNames, model, onProgress, reasoning);

  if (payload) {
    onProgress?.(`Scoring complete \u2014 ${payload.scores.length} dimensions scored.`);
    // Attach exploration trace and scoring attempt errors to the payload
    payload.exploration = { analysis, filesRead, messages: explorationMessages };
    if (attemptErrors.length > 0) payload.scoringAttemptErrors = attemptErrors;
    return payload;
  } else {
    onProgress?.("Scoring failed \u2014 reviewer could not produce structured scores.");
    return null;
  }
}

// ── Single Review with Retry ───────────────────────────────────────────

async function runSingleReviewWithRetry(
  explorationPrompt: string,
  rubricSection: string,
  dimNames: string,
  cwd: string,
  model: string | undefined,
  onProgress?: (msg: string) => void,
  reasoning?: ReasoningLevel,
  skipExploration?: boolean,
): Promise<ReviewPayload | null> {
  try {
    return await withRetry(
      async () => {
        const result = await runSingleReview(explorationPrompt, rubricSection, dimNames, cwd, model, onProgress, reasoning, skipExploration);
        if (!result) throw new Error("Reviewer produced no structured result after Phase 1 + Phase 2");
        return result;
      },
      { maxRetries: 1, initialDelayMs: 2000, checkTransient: false },
    );
  } catch (err) {
    onProgress?.(`Reviewer failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ── Context Classification ─────────────────────────────────────────────

/**
 * Determine if this review involves file changes that need filesystem exploration,
 * or if the execution evidence (stdout, transcript, outcomes) is sufficient.
 */
function hasFileChanges(context?: ReviewContext): boolean {
  if (!context) return true; // conservative: explore when unknown
  return (context.filesCreated?.length ?? 0) > 0 || (context.filesEdited?.length ?? 0) > 0;
}

// ── Prompt Builder (Phase 1 only — no submit_review instructions) ──────

function buildContextSection(context?: ReviewContext): string {
  if (!context) return "";

  const parts: string[] = [
    `TASK CONTEXT:`,
    `Title: ${context.taskTitle}`,
    `Description: ${context.taskDescription}`,
  ];

  if (context.exitCode !== undefined) parts.push(`Exit code: ${context.exitCode}`);
  if (context.duration !== undefined) parts.push(`Duration: ${Math.round(context.duration / 1000)}s`);
  if (context.toolCalls !== undefined) parts.push(`Total tool calls: ${context.toolCalls}`);
  if (context.toolsSummary) parts.push(`Tools used: ${context.toolsSummary}`);

  if (context.filesCreated?.length) parts.push(`\nFiles created by agent: ${context.filesCreated.join(", ")}`);
  if (context.filesEdited?.length) parts.push(`Files edited by agent: ${context.filesEdited.join(", ")}`);

  if (context.outcomes?.length) {
    parts.push(`\nREGISTERED OUTCOMES:`);
    for (const o of context.outcomes) {
      let desc = `- [${o.type}] ${o.label}`;
      if (o.path) desc += ` (${o.path})`;
      if (o.url) desc += ` \u2192 ${o.url}`;
      if (o.text) desc += `: ${o.text.slice(0, 300)}${o.text.length > 300 ? "..." : ""}`;
      parts.push(desc);
    }
  }

  if (context.executionSummary) {
    parts.push(`\n${context.executionSummary}`);
  }

  if (context.agentOutput) {
    parts.push(`\nAGENT FINAL OUTPUT:\n${context.agentOutput.slice(-3000)}`);
  }

  if (context.agentStderr) {
    parts.push(`\nAGENT STDERR:\n${context.agentStderr.slice(-1000)}`);
  }

  return parts.join("\n");
}

function buildExplorationPrompt(
  criteria: string,
  rubricSection: string,
  dimNames: string,
  context?: ReviewContext,
): string {
  const contextSection = buildContextSection(context);

  return `You are a senior code reviewer performing a G-Eval evaluation.
Your task is to EXPLORE the codebase and build a detailed analysis for each evaluation dimension.

ACCEPTANCE CRITERIA:
${criteria}

${contextSection}

EVALUATION DIMENSIONS:
${rubricSection}

INSTRUCTIONS:
1. Use read_file, glob, and grep tools to explore the codebase and find relevant files.
2. Start by examining the files listed above (created/edited by the agent) \u2014 they are the primary evidence.
3. Read the code carefully and understand what it does relative to the acceptance criteria.
4. For EACH dimension (${dimNames}), write your analysis noting:
   - Specific file:line references as evidence
   - How the code performs on this dimension
   - What score (1-5) you would give based on the rubric
5. Be thorough \u2014 read all relevant files before concluding.

OUTPUT:
Write your analysis as free text. Include specific file:line references for each dimension.
You will be asked to submit structured scores in a separate step after exploration.`;
}

/**
 * Build a prompt for output-based review (no file exploration needed).
 * Used when the agent worked via external tools, APIs, or text output only.
 */
function buildOutputBasedReviewPrompt(
  criteria: string,
  rubricSection: string,
  dimNames: string,
  context: ReviewContext,
): string {
  const contextSection = buildContextSection(context);

  return `You are a senior reviewer performing a G-Eval evaluation.
The agent completed a task that did NOT produce file changes on disk. Instead, the agent's work
is evidenced by its execution timeline, tool usage, registered outcomes, and text output below.

ACCEPTANCE CRITERIA:
${criteria}

${contextSection}

EVALUATION DIMENSIONS:
${rubricSection}

INSTRUCTIONS:
1. Carefully review the execution timeline, agent output, and registered outcomes above.
2. Assess whether the agent correctly completed the task based on the acceptance criteria.
3. For EACH dimension (${dimNames}), write your analysis noting:
   - Specific evidence from the execution timeline or agent output
   - How the agent's work performs on this dimension
   - What score (1-5) you would give based on the rubric
4. Note: the agent may have used external tools (email, APIs, web requests, etc.) \u2014 the tool call
   results in the timeline ARE the evidence of work. Do NOT penalize for lack of file changes.

OUTPUT:
Write your analysis as free text. Reference specific timeline entries or output sections as evidence.
You will be asked to submit structured scores in a separate step.`;
}

// ── CheckResult Builder ────────────────────────────────────────────────

function buildCheckResult(
  parsed: ReviewPayload,
  dimensions: EvalDimension[],
  threshold: number,
  individualReviews?: ReviewPayload[],
): CheckResult {
  const dimScores: DimensionScore[] = parsed.scores.map(s => {
    const dim = dimensions.find(d => d.name === s.dimension);
    return {
      dimension: s.dimension,
      score: Math.max(1, Math.min(5, Math.round(s.score))),
      reasoning: s.reasoning,
      weight: dim?.weight ?? (1 / dimensions.length),
      evidence: s.evidence,
    };
  });

  const globalScore = computeWeightedScore(dimScores);
  const passed = globalScore >= threshold;

  const scoreLines = dimScores.map(s =>
    `  ${s.dimension}: ${s.score}/5 (weight: ${s.weight}) \u2014 ${s.reasoning}`
  ).join("\n");
  const details = `Global score: ${globalScore.toFixed(2)}/5 (threshold: ${threshold})\n\n${scoreLines}\n\nSummary: ${parsed.summary}`;

  const msg = passed
    ? `Score ${globalScore.toFixed(1)}/5 \u2014 ${parsed.summary.slice(0, 100)}`
    : `Score ${globalScore.toFixed(1)}/5 (below ${threshold}) \u2014 ${parsed.summary.slice(0, 100)}`;

  // Build individual reviewer results for transparency
  const reviewers: import("../core/types.js").ReviewerResult[] | undefined = individualReviews?.map((review, i) => {
    const reviewDimScores: DimensionScore[] = review.scores.map(s => {
      const dim = dimensions.find(d => d.name === s.dimension);
      return {
        dimension: s.dimension,
        score: Math.max(1, Math.min(5, Math.round(s.score))),
        reasoning: s.reasoning,
        weight: dim?.weight ?? (1 / dimensions.length),
        evidence: s.evidence,
      };
    });
    return {
      index: i + 1,
      scores: review.scores,
      summary: review.summary,
      globalScore: Math.round(computeWeightedScore(reviewDimScores) * 100) / 100,
      exploration: review.exploration,
      scoringAttemptErrors: review.scoringAttemptErrors,
    };
  });

  return {
    type: "llm_review",
    passed,
    message: msg,
    details,
    scores: dimScores,
    globalScore: Math.round(globalScore * 100) / 100,
    reviewers,
  };
}

// ── Dynamic Dimension Generation ───────────────────────────────────────

/**
 * Ask the LLM to generate 3-4 evaluation dimensions tailored to the specific task.
 * Falls back to DEFAULT_DIMENSIONS if the LLM call fails or returns invalid data.
 */
async function generateDimensions(
  context: ReviewContext | undefined,
  model: string | undefined,
  onProgress?: (msg: string) => void,
): Promise<EvalDimension[]> {
  if (!context?.taskTitle) return DEFAULT_DIMENSIONS;

  onProgress?.("Generating task-specific evaluation dimensions...");

  try {
    const m = resolveModel(model);
    const result = await generateText({
      model: m.aiModel,
      system: "You are an evaluation expert. Output ONLY a valid JSON array. No markdown fences, no explanations.",
      prompt: `Generate 3-4 evaluation dimensions for assessing the following task. Each dimension must be specific and relevant to THIS task \u2014 do NOT use generic coding metrics unless the task is about writing code.

TASK TITLE: ${context.taskTitle}
TASK DESCRIPTION: ${context.taskDescription}
${context.filesCreated?.length ? `FILES CREATED: ${context.filesCreated.join(", ")}` : ""}

Return ONLY a JSON array (no markdown fences, no explanation). Each element must have:
- "name": snake_case identifier (e.g. "visual_quality", "data_accuracy")
- "description": one sentence explaining what this dimension measures
- "weight": number 0.15-0.40 (all weights must sum to 1.0)
- "rubric": object with keys 1-5, each a one-sentence description for that score level

Example for an image generation task:
[{"name":"visual_quality","description":"Is the generated image sharp, well-composed, and visually appealing?","weight":0.30,"rubric":{"1":"Unusable \u2014 heavily distorted or corrupted","2":"Poor quality \u2014 major visual artifacts","3":"Acceptable \u2014 meets basic standards","4":"Good \u2014 clean and well-composed","5":"Excellent \u2014 professional-grade visual quality"}},{"name":"prompt_adherence","description":"Does the image match the requested subject, style, and details?","weight":0.35,"rubric":{"1":"Completely ignores the prompt","2":"Loosely related but misses key elements","3":"Partially matches \u2014 some elements present","4":"Good match \u2014 most details captured","5":"Perfect match \u2014 every detail faithfully rendered"}},{"name":"completeness","description":"Are all requested deliverables produced in the correct formats?","weight":0.35,"rubric":{"1":"No deliverables produced","2":"Partial output \u2014 missing files or formats","3":"Core deliverables present but extras missing","4":"Nearly complete \u2014 minor omissions","5":"All deliverables produced correctly"}}]`,
    });

    let text = result.text.trim();

    // Strip markdown fences if present
    const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fenceMatch) text = fenceMatch[1].trim();

    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed) || parsed.length < 2 || parsed.length > 6) {
      throw new Error(`Expected 2-6 dimensions, got ${Array.isArray(parsed) ? parsed.length : typeof parsed}`);
    }

    // Validate and normalize
    const dimensions: EvalDimension[] = [];
    let totalWeight = 0;
    for (const d of parsed) {
      if (!d.name || !d.description || typeof d.weight !== "number") continue;
      const rubric: Record<number, string> = {};
      if (d.rubric && typeof d.rubric === "object") {
        for (const [k, v] of Object.entries(d.rubric)) {
          const num = Number(k);
          if (num >= 1 && num <= 5 && typeof v === "string") rubric[num] = v;
        }
      }
      dimensions.push({
        name: String(d.name),
        description: String(d.description),
        weight: d.weight,
        ...(Object.keys(rubric).length > 0 ? { rubric } : {}),
      });
      totalWeight += d.weight;
    }

    if (dimensions.length < 2) {
      throw new Error(`Only ${dimensions.length} valid dimensions parsed`);
    }

    // Normalize weights to sum to 1.0
    if (Math.abs(totalWeight - 1.0) > 0.01) {
      for (const dim of dimensions) {
        dim.weight = dim.weight / totalWeight;
      }
    }

    onProgress?.(`Generated ${dimensions.length} task-specific dimensions: ${dimensions.map(d => d.name).join(", ")}`);
    return dimensions;
  } catch (err) {
    onProgress?.(`Dimension generation failed (${err instanceof Error ? err.message : String(err)}), using defaults.`);
    return DEFAULT_DIMENSIONS;
  }
}

// ── Main Entry Point ───────────────────────────────────────────────────

/**
 * Run a G-Eval LLM-as-Judge review (2-phase architecture).
 *
 * Phase 1: Each reviewer explores the codebase with tools (read_file, glob, grep).
 * Phase 2: Structured scoring via Output.object() extracts validated scores.
 *
 * Runs 3 independent reviewers in parallel (multi-evaluator consensus).
 * Falls back to single-reviewer if <2 succeed.
 */
export async function runLLMReview(
  expectation: TaskExpectation,
  cwd: string,
  onProgress?: (msg: string) => void,
  context?: ReviewContext,
  reasoning?: ReasoningLevel,
): Promise<CheckResult> {
  const criteria = expectation.criteria || "The work should be correct, well-structured, and meet the task requirements.";
  const threshold = expectation.threshold ?? 3.0;

  const reviewModel = process.env.POLPO_JUDGE_MODEL || process.env.POLPO_MODEL || "anthropic:claude-sonnet-4.5";

  // Generate task-specific dimensions via LLM when not explicitly provided
  const dimensions = expectation.dimensions ?? await generateDimensions(context, reviewModel, onProgress);

  const dimNames = dimensions.map((d: EvalDimension) => d.name).join(", ");
  const rubricSection = buildRubricSection(dimensions);

  // Decide review mode: file-based (with exploration) or output-based (no exploration)
  const needsExploration = hasFileChanges(context);
  const skipExploration = !needsExploration;

  const reviewPrompt = needsExploration
    ? buildExplorationPrompt(criteria, rubricSection, dimNames, context)
    : buildOutputBasedReviewPrompt(criteria, rubricSection, dimNames, context!);

  // Judge reasoning: explicit param > POLPO_JUDGE_REASONING env var > undefined
  const judgeReasoning = reasoning ?? (process.env.POLPO_JUDGE_REASONING as ReasoningLevel | undefined);

  const modeLabel = skipExploration ? "output-based" : "file-exploration";
  onProgress?.(`Starting 3 independent review agents (${modeLabel} \u2192 score)...`);

  // Stagger reviewers by 1s to reduce rate-limit collisions on same provider
  const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
  const settled = await Promise.allSettled([
    runSingleReviewWithRetry(reviewPrompt, rubricSection, dimNames, cwd, reviewModel, onProgress, judgeReasoning, skipExploration),
    delay(1000).then(() => runSingleReviewWithRetry(reviewPrompt, rubricSection, dimNames, cwd, reviewModel, onProgress, judgeReasoning, skipExploration)),
    delay(2000).then(() => runSingleReviewWithRetry(reviewPrompt, rubricSection, dimNames, cwd, reviewModel, onProgress, judgeReasoning, skipExploration)),
  ]);

  const successfulReviews: ReviewPayload[] = [];
  const failures: string[] = [];
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    if (result.status === "fulfilled" && result.value) {
      successfulReviews.push(result.value);
    } else {
      const reason = result.status === "rejected"
        ? (result.reason instanceof Error ? result.reason.message : String(result.reason))
        : "Reviewer returned null \u2014 scoring failed";
      failures.push(reason);
      onProgress?.(`Reviewer ${i + 1}/3 failed: ${reason}`);
    }
  }

  if (successfulReviews.length >= 2) {
    onProgress?.(`Computing consensus from ${successfulReviews.length} reviewers...`);
    const consensus = computeMedianScores(successfulReviews, dimensions);
    return buildCheckResult(consensus, dimensions, threshold, successfulReviews);
  }

  if (successfulReviews.length === 1) {
    onProgress?.("Only 1 reviewer succeeded, using single review...");
    return buildCheckResult(successfulReviews[0], dimensions, threshold, successfulReviews);
  }

  const failureDetail = failures.length > 0
    ? `\n\nFailure reasons:\n${failures.map((f, i) => `  Reviewer ${i + 1}: ${f}`).join("\n")}`
    : "";
  const modelInfo = reviewModel ? ` (judge model: ${reviewModel})` : " (no explicit judge model \u2014 using default)";

  return {
    type: "llm_review",
    passed: false,
    message: `Review failed \u2014 all evaluators failed to produce structured scores${modelInfo}`,
    details: `All 3 reviewers failed after structured output + fallback strategies.${modelInfo}\n\nThis usually means: (1) the judge model doesn't support structured output well, (2) API auth/rate-limit errors, or (3) the model can't produce valid JSON.\n\nTry: set POLPO_JUDGE_MODEL to a capable model (e.g. anthropic:claude-sonnet-4.5, openai:gpt-4o), check API keys, or reduce concurrent tasks.${failureDetail}`,
  };
}
