import type { ProfiledModelSelection } from "../types/config.js";
import type {
  SandboxAcquisitionSource,
  SandboxReleaseOutcome,
  SandboxRuntimeEventType,
  SandboxRuntimeOperation,
} from "../sandbox-provider.js";

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
  /** Static JSON input or exact `{ "$context": "path.to.value" }` bindings. */
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
export type LoopPermissionEffect = "allow" | "deny" | "approval";
export type LoopPermissionResource = "loop" | "step" | "model" | "tool" | "human";

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

export interface LoopPermissionMatch {
  loop?: string | string[];
  step?: string | string[];
  tool?: string | string[];
  human?: string | string[];
  hook?: LoopLifecycleHook | LoopLifecycleHook[];
}

export interface ProjectLoopPermission {
  id?: string;
  description?: string;
  resource: LoopPermissionResource;
  /** Action is intentionally open-ended so hosts can model org-specific verbs. */
  action?: string;
  effect: LoopPermissionEffect;
  match?: LoopPermissionMatch;
  /** Optional expression evaluated against the same hook payload as policies. */
  when?: string;
  message?: string;
}

export type LoopTraceEventType =
  | "loop.start"
  | "loop.resume"
  | "loop.end"
  | "loop.error"
  | "permission.result"
  | "policy.result"
  | "approval.required"
  | "step.start"
  | "step.end"
  | "step.skip"
  | "agent.input"
  | "tool.call"
  | "tool.result"
  | "human.request"
  | "human.result"
  | "transition"
  | SandboxRuntimeEventType;

export interface LoopTraceEvent {
  id: string;
  type: LoopTraceEventType;
  ts: string;
  loop?: string;
  /** Canonical key from ProjectLoopConfig.steps. Stable even when result aliases are reused. */
  stepKey?: string;
  /** Result/context alias retained for backwards compatibility (for example saveAs ?? tool). */
  step?: string;
  tool?: string;
  human?: string;
  from?: string;
  to?: string;
  /** Canonical graph identities for transition endpoints. */
  fromStepKey?: string;
  toStepKey?: string;
  status?: "started" | "completed" | "skipped" | "failed";
  when?: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  sandboxId?: string;
  operation?: SandboxRuntimeOperation;
  source?: SandboxAcquisitionSource;
  outcome?: SandboxReleaseOutcome;
  data?: Record<string, unknown>;
}

export interface LoopTransition {
  when?: string;
  to: string;
  /** Human-readable branch label for visualizers and editors. */
  label?: string;
  /** Optional branch explanation kept separate from the executable guard. */
  description?: string;
}

export type LoopNext = string | LoopTransition[];

export interface LoopDisplayMetadata {
  /** Human-readable label for visualizers and editors. */
  label?: string;
  /** Human-readable description for visualizers, docs, and audit UI. */
  description?: string;
  /** Optional logical group id. Groups never affect execution semantics. */
  group?: string;
}

export interface LoopGroup {
  label: string;
  description?: string;
}

export type LoopToolChoice =
  | "auto"
  | "none"
  | "required"
  | {
      mode: "auto" | "none" | "required";
      /** Optional specific tool to force when mode is required. */
      tool?: string;
    };

export interface LoopConfig extends LoopDisplayMetadata {
  /** Optional — the loops-map key is the canonical name. */
  name?: string;
  systemPrompt?: string;
  /** Model-visible JSON projected from static values and shared context bindings. */
  input?: unknown;
  /** Optional JSON Schema validated after bindings resolve and before model invocation. */
  inputSchema?: unknown;
  /** Tool subset active in this loop (restriction = determinism/safety). */
  allowedTools?: string[];
  /** @deprecated Use allowedTools. Retained for authored-config compatibility. */
  tools?: string[];
  /** Skill subset active in this loop. Defaults to the agent-level skills. */
  skills?: string[];
  /** Optional model tool-choice policy for this agent step. */
  toolChoice?: LoopToolChoice;
  model?: ProfiledModelSelection;
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

export interface HumanLoopStep extends LoopDisplayMetadata {
  type: "human";
  when?: string;
  output?: { schema?: unknown };
  notify?: string[];
  next?: LoopNext;
}

export interface ParallelLoopStep extends LoopDisplayMetadata {
  type: "parallel";
  when?: string;
  branches: string[];
  join?: "all" | "any" | number;
  next?: LoopNext;
}

export interface WhileLoopStep extends LoopDisplayMetadata {
  type: "while";
  when?: string;
  /** Run the body while this expression evaluates true. Mutually optional with `until`. */
  condition?: string;
  /** Run the body until this expression evaluates true. Mutually optional with `condition`. */
  until?: string;
  /** First body step id, or multiple independent entry step ids executed sequentially per iteration. */
  body: string | string[];
  /** Safety guard. Defaults to 5 in the executor when omitted. */
  maxIterations?: number;
  next?: LoopNext;
}

export interface ToolLoopStep extends LoopDisplayMetadata {
  type: "tool";
  when?: string;
  /** Built-in or custom tool name to execute directly, without an LLM turn. */
  tool: string;
  /** Static JSON input or exact `{ "$context": "path.to.value" }` bindings. */
  input?: unknown;
  /** Context path where the tool output should be stored. Defaults to the tool name. */
  saveAs?: string;
  next?: LoopNext;
}

export type LoopStepConfig = AgentLoopStep | HumanLoopStep | ParallelLoopStep | WhileLoopStep | ToolLoopStep;

export type LoopPresentationAction =
  | Readonly<{
      id: string;
      label: string;
      type: "open_url";
      url: string;
    }>
  | Readonly<{
      id: string;
      label: string;
      type: "postback";
      value: string;
    }>;

export type LoopPresentation = Readonly<{
  text: string;
  actions?: readonly LoopPresentationAction[];
}>;

/** Deterministic terminal projection over the completed shared context. */
export interface ProjectLoopResultConfig {
  /** Structured run result. Static JSON and exact `$context` bindings are supported. */
  data?: unknown;
  /** User-facing result, independent from the structured data consumed by the graph. */
  presentation?: {
    text: unknown;
    actions?: unknown;
  };
}

/** Project-level reusable loop graph. Agents assign these by name/id. */
export interface ProjectLoopConfig {
  version?: ProjectLoopVersion;
  kind?: ProjectLoopKind;
  name: string;
  /** Human-readable label for UI (e.g. "Plan", "Build"). Falls back to `name`. */
  label?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  /** Logical visual groups keyed by stable author-defined id. */
  groups?: Record<string, LoopGroup>;
  /** Tool subset available to every step in this Project Loop. */
  allowedTools?: string[];
  context?: "shared";
  hooks?: ProjectLoopHooks;
  permissions?: ProjectLoopPermission[];
  policies?: ProjectLoopPolicy[];
  result?: ProjectLoopResultConfig;
  start: string;
  steps: Record<string, LoopStepConfig>;
}

export interface SwitchCase {
  when: string;
  label?: string;
  description?: string;
  steps: Step[];
}

export interface SwitchDefault {
  label?: string;
  description?: string;
  steps: Step[];
}

export interface WhileBlock {
  condition?: string;
  until?: string;
  maxIterations?: number;
  /**
   * Durable-resume marker: iterations already completed by a previous
   * process. Set only on checkpoint continuation steps emitted by the
   * PipelineExecutor (never in config files), so a resumed `while`
   * re-enters at the saved iteration and `maxIterations` stays an
   * absolute budget across crashes.
   */
  completedIterations?: number;
  steps: Step[];
}

export type Step = { key?: string } & LoopDisplayMetadata & (
  | { loop: string; when?: string }
  | { tool: string; input?: unknown; saveAs?: string; when?: string }
  | { parallel: Step[][]; join?: "all" | "any" | number; when?: string }
  | { switch: { cases: SwitchCase[]; default?: SwitchDefault }; when?: string }
  | { while: WhileBlock; when?: string }
  | { human: string; output?: { schema?: unknown }; notify?: string[]; when?: string }
);

export interface Pipeline {
  mode?: "sequential" | "parallel";
  context?: "shared";
  /** Logical visual groups keyed by stable author-defined id. */
  groups?: Record<string, LoopGroup>;
  steps: Step[];
}

export interface AgentLoopConfig {
  name?: string;
  model?: ProfiledModelSelection;
  /** Out-of-scope runtime/environment ref (default polpo-runner; custom image later). */
  runtime?: string;
  loops: Record<string, LoopConfig>;
  pipeline?: Pipeline;
}

// ─── Step type guards ────────────────────────────────────
export const isLoopStep = (s: Step): s is Extract<Step, { loop: string }> => "loop" in s;
export const isToolStep = (s: Step): s is Extract<Step, { tool: string }> =>
  "tool" in s;
export const isParallelStep = (s: Step): s is Extract<Step, { parallel: Step[][] }> =>
  "parallel" in s;
export const isSwitchStep = (
  s: Step,
): s is Extract<Step, { switch: { cases: SwitchCase[] } }> => "switch" in s;
export const isWhileStep = (s: Step): s is Extract<Step, { while: WhileBlock }> => "while" in s;
export const isHumanStep = (
  s: Step,
): s is Extract<Step, { human: string }> => "human" in s;
