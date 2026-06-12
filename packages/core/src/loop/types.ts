/**
 * Configurable agentic loops — config model (declarative surface).
 *
 * An agent has a collection of named loops (one active at a time) and an
 * optional pipeline: a tree of heterogeneous steps with deterministic
 * conditions over a shared, read-only context bag. Step kinds: loop (LLM),
 * switch (deterministic branch), parallel (fork-join), human (structured human
 * decision). See the loop-architecture design.
 */

export interface Condition {
  /** Expression over the context bag, evaluated by SafeExpressionEvaluator. */
  expression: string;
}

export type ContextBag = Record<string, unknown>;

export interface LoopConfig {
  /** Optional — the loops-map key is the canonical name. */
  name?: string;
  systemPrompt?: string;
  /** Tool subset active in this loop (restriction = determinism/safety). */
  tools?: string[];
  model?: string;
  reasoning?: string;
  temperature?: number;
  maxTurns?: number;
  /** Deterministic stop condition over the context bag. */
  stopWhen?: Condition;
  /** Structured output contract — the loop's typed deliverable. */
  output?: { schema?: unknown };
}

export interface SwitchCase {
  when: string;
  steps: Step[];
}

export type Step =
  | { loop: string; when?: string }
  | { parallel: Step[]; join?: "all" | "any" | number; when?: string }
  | { switch: { cases: SwitchCase[]; default?: { steps: Step[] } }; when?: string }
  | { human: string; output?: { schema?: unknown }; notify?: string[]; when?: string };

export interface Pipeline {
  mode?: "sequential" | "parallel";
  context?: "shared";
  steps: Step[];
}

export interface AgentLoopConfig {
  name?: string;
  model?: string;
  /** Out-of-scope runtime/environment ref (default polpo-runner; custom image later). */
  runtime?: string;
  loops: Record<string, LoopConfig>;
  pipeline?: Pipeline;
}

// ─── Step type guards ────────────────────────────────────
export const isLoopStep = (s: Step): s is { loop: string; when?: string } => "loop" in s;
export const isParallelStep = (s: Step): s is { parallel: Step[]; join?: "all" | "any" | number; when?: string } =>
  "parallel" in s;
export const isSwitchStep = (
  s: Step,
): s is { switch: { cases: SwitchCase[]; default?: { steps: Step[] } }; when?: string } => "switch" in s;
export const isHumanStep = (
  s: Step,
): s is { human: string; output?: { schema?: unknown }; notify?: string[]; when?: string } => "human" in s;
