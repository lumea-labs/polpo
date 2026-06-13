/**
 * Configurable agentic loops — config model (declarative surface).
 *
 * ProjectLoopConfig is the canonical project-level graph assigned to agents by
 * name. AgentLoopConfig is the normalized legacy executor shape: a collection
 * of named loops plus a pipeline tree over a shared context bag.
 */

export interface Condition {
  /** Expression over the context bag, evaluated by SafeExpressionEvaluator. */
  expression: string;
}

export type ContextBag = Record<string, unknown>;

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

export type LoopLifecycleHook = typeof LOOP_LIFECYCLE_HOOKS[number];
export type ProjectLoopVersion = "1";
export type ProjectLoopKind = "graph";

export interface LoopHookAction {
  /** Built-in or custom tool invoked by the hook. */
  tool: string;
  /** Static JSON input. Host runtimes may add templating later. */
  input?: unknown;
  /** Context path where the hook output should be stored. */
  saveAs?: string;
  /** Optional expression over the context bag. */
  when?: string;
  /** Whether a hook tool failure should fail the loop or be observed only. */
  onError?: "fail" | "continue";
}

export type ProjectLoopHooks = Partial<Record<LoopLifecycleHook, LoopHookAction[]>>;

export type LoopPolicyEffect = "allow" | "deny" | "approval";

export interface ProjectLoopPolicy {
  id?: string;
  description?: string;
  /** Lifecycle point where this policy is evaluated. Defaults to tool:before. */
  hook?: LoopLifecycleHook;
  effect: LoopPolicyEffect;
  /** Expression evaluated against the hook payload/context. */
  when: string;
  message?: string;
}

export type LoopTraceEventType =
  | "loop.start"
  | "loop.end"
  | "loop.error"
  | "step.start"
  | "step.end"
  | "step.skip"
  | "tool.call"
  | "tool.result"
  | "human.request"
  | "human.result"
  | "transition";

export interface LoopTraceEvent {
  id: string;
  type: LoopTraceEventType;
  ts: string;
  loop?: string;
  step?: string;
  tool?: string;
  human?: string;
  from?: string;
  to?: string;
  status?: "started" | "completed" | "skipped" | "failed";
  when?: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  data?: Record<string, unknown>;
}

export type LoopNext =
  | string
  | Array<{
      when?: string;
      to: string;
    }>;

export type LoopToolChoice =
  | "auto"
  | "none"
  | "required"
  | {
      mode: "auto" | "none" | "required";
      /** Optional specific tool to force when mode is required. */
      tool?: string;
    };

export interface LoopConfig {
  /** Optional — the loops-map key is the canonical name. */
  name?: string;
  systemPrompt?: string;
  /** Tool subset active in this loop (restriction = determinism/safety). */
  tools?: string[];
  /** Skill subset active in this loop. Defaults to the agent-level skills. */
  skills?: string[];
  /** Optional model tool-choice policy for this agent step. */
  toolChoice?: LoopToolChoice;
  model?: string;
  reasoning?: string;
  temperature?: number;
  maxTurns?: number;
  /** Deterministic stop condition over the context bag. */
  stopWhen?: Condition;
  /** Structured output contract — the loop's typed deliverable. */
  output?: { schema?: unknown };
}

export interface AgentLoopStep extends LoopConfig {
  type?: "agent";
  /** Optional guard evaluated before this step is entered. */
  when?: string;
  /** Next step id, conditional transitions, or "end". */
  next?: LoopNext;
}

export interface HumanLoopStep {
  type: "human";
  when?: string;
  output?: { schema?: unknown };
  notify?: string[];
  next?: LoopNext;
}

export interface ParallelLoopStep {
  type: "parallel";
  when?: string;
  branches: string[];
  join?: "all" | "any" | number;
  next?: LoopNext;
}

export interface ToolLoopStep {
  type: "tool";
  when?: string;
  /** Built-in or custom tool name to execute directly, without an LLM turn. */
  tool: string;
  /** Static JSON input or host-templated input resolved by the runtime. */
  input?: unknown;
  /** Context path where the tool output should be stored. Defaults to the tool name. */
  saveAs?: string;
  next?: LoopNext;
}

export type LoopStepConfig = AgentLoopStep | HumanLoopStep | ParallelLoopStep | ToolLoopStep;

/** Project-level reusable loop graph. Agents assign these by name/id. */
export interface ProjectLoopConfig {
  version?: ProjectLoopVersion;
  kind?: ProjectLoopKind;
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
  context?: "shared";
  hooks?: ProjectLoopHooks;
  policies?: ProjectLoopPolicy[];
  start: string;
  steps: Record<string, LoopStepConfig>;
}

export interface SwitchCase {
  when: string;
  steps: Step[];
}

export type Step =
  | { loop: string; when?: string }
  | { tool: string; input?: unknown; saveAs?: string; when?: string }
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
export const isToolStep = (s: Step): s is { tool: string; input?: unknown; saveAs?: string; when?: string } =>
  "tool" in s;
export const isParallelStep = (s: Step): s is { parallel: Step[]; join?: "all" | "any" | number; when?: string } =>
  "parallel" in s;
export const isSwitchStep = (
  s: Step,
): s is { switch: { cases: SwitchCase[]; default?: { steps: Step[] } }; when?: string } => "switch" in s;
export const isHumanStep = (
  s: Step,
): s is { human: string; output?: { schema?: unknown }; notify?: string[]; when?: string } => "human" in s;
