/**
 * Re-export shim: AssessmentOrchestrator from @polpo-ai/core.
 * Source of truth is packages/core/src/assessment-orchestrator.ts.
 *
 * This shim extends the pure-core class to inject Node.js-specific ports
 * (node:fs, node:path, LLM answer generator) so the root orchestrator
 * can keep calling `new AssessmentOrchestrator(ctx)` unchanged.
 */

import { join, basename } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { AssessmentOrchestrator as CoreAssessmentOrchestrator, type AssessmentPorts } from "@polpo-ai/core/assessment-orchestrator";
import type { OrchestratorContext } from "@polpo-ai/core/orchestrator-context";
import { classifyAsQuestion } from "./question-detector.js";
import type { Task, ModelConfig } from "@polpo-ai/core/types";
import { queryText, resolveModelSpec } from "@polpo-ai/llm";
import { withRetry } from "../llm/retry.js";

/** Inline query helper (replaces deleted query.ts) */
async function queryLLM(prompt: string, model?: string | ModelConfig) {
  const spec = resolveModelSpec(model);
  return withRetry(async () => {
    const result = await queryText(prompt, spec);
    return { text: result.text, usage: result.usage, model: result.model };
  }, { maxRetries: 2 });
}

/** Build Node.js-specific ports for the core AssessmentOrchestrator. */
function buildNodePorts(ctx: OrchestratorContext): AssessmentPorts {
  return {
    fileExists: (path: string) => existsSync(path),
    readDir: (dir: string) => {
      const entries = readdirSync(dir, { withFileTypes: true });
      return entries.map(e => ({
        name: e.name,
        isFile: e.isFile(),
        isDirectory: e.isDirectory(),
      }));
    },
    joinPath: (...parts: string[]) => join(...parts),
    baseName: (path: string) => basename(path),
    generateAnswer: async (task: Task, question: string, model?: string | ModelConfig) => {
      const memory = (await ctx.memoryStore?.get()) ?? "";
      const state = await ctx.registry.getState();
      const siblings = task.group
        ? state.tasks.filter(t => t.group === task.group && t.id !== task.id)
        : [];

      const parts = [
        `You are Polpo, an AI agent orchestration framework. An agent working on a task has asked a question instead of completing the work.`,
        `Your job is to answer the question concisely so the agent can proceed autonomously.`,
        ``,
        `## Task`,
        `Title: ${task.title}`,
        `Description: ${task.originalDescription || task.description}`,
      ];
      if (memory) {
        parts.push(``, `## Shared Memory`, memory);
      }
      if (siblings.length > 0) {
        parts.push(``, `## Related tasks in the same plan`);
        for (const s of siblings) {
          parts.push(`- [${s.status}] ${s.title}`);
          if (s.result?.stdout && s.status === "done") {
            parts.push(`  Result: ${s.result.stdout.slice(0, 200)}`);
          }
        }
      }
      parts.push(
        ``,
        `## Agent's Question`,
        question,
        ``,
        `Answer the question directly and concisely. Provide specific, actionable information.`,
        `If you're unsure, give your best guidance based on available context.`,
        `Do NOT ask follow-up questions. Just answer.`,
      );
      return (await queryLLM(parts.join("\n"), model)).text;
    },
    classifyAsQuestion: (stdout: string, model?: string | ModelConfig) =>
      classifyAsQuestion(stdout, model),
  };
}

/**
 * Ensure ctx.queryLLM is populated for the core class.
 * The real orchestrator always sets this, but tests may not.
 * In that case, use inline queryLLM as fallback.
 */
function ensureQueryLLM(ctx: OrchestratorContext): OrchestratorContext {
  if (ctx.queryLLM) return ctx;
  return Object.create(ctx, {
    queryLLM: {
      value: async (prompt: string, model?: string | ModelConfig) => queryLLM(prompt, model),
      enumerable: true,
    },
  }) as OrchestratorContext;
}

/**
 * Node.js shell wrapper — automatically injects Node.js ports.
 * API-compatible with the old root AssessmentOrchestrator.
 */
export class AssessmentOrchestrator extends CoreAssessmentOrchestrator {
  constructor(ctx: OrchestratorContext) {
    super(ensureQueryLLM(ctx), buildNodePorts(ctx));
  }
}
