/**
 * Re-export shim: question-detector from @polpo-ai/core.
 * Source of truth is packages/core/src/question-detector.ts.
 *
 * The core version's classifyAsQuestion takes queryLLM as a parameter.
 * This shim preserves the old signature for backward compatibility
 * with root-level code and tests.
 */

import { queryText, resolveModelSpec } from "../llm/pi-client.js";
import { withRetry } from "../llm/retry.js";
import type { TaskResult, AgentActivity, ModelConfig } from "@polpo-ai/core/types";

// Re-export looksLikeQuestion unchanged (same signature in core)
export { looksLikeQuestion } from "@polpo-ai/core/question-detector";

/** Inline query helper (replaces deleted query.ts) */
async function queryLLM(prompt: string, model?: string | ModelConfig) {
  const spec = resolveModelSpec(model);
  return withRetry(async () => {
    const result = await queryText(prompt, spec);
    return { text: result.text, usage: result.usage, model: result.model };
  }, { maxRetries: 2 });
}

/**
 * Async LLM classifier: confirms whether the output is truly a question.
 * Only called after heuristic pre-filter passes.
 */
export async function classifyAsQuestion(
  stdout: string,
  model?: string | ModelConfig,
): Promise<{ isQuestion: boolean; question: string }> {
  const { classifyAsQuestion: coreClassify } = await import("@polpo-ai/core/question-detector");
  return coreClassify(stdout, (prompt, m) => queryLLM(prompt, m), model);
}
