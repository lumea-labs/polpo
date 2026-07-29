import type { ModelSelection } from "../model-policy.js";
import type { SandboxIsolation } from "../runtime-sandbox.js";

export type RuntimeSurface = "agent" | "task" | "channel" | "webhook";

export type RuntimeInvocationSource =
  | "request"
  | "channel"
  | "task"
  | "schedule"
  | "loop-step"
  | "internal";

export type RuntimeDecisionSource =
  | "request"
  | "agent"
  | "project"
  | "router"
  | "default";

export type RuntimeExecutionMode = "direct" | "loop";
export type RuntimeToolExposure = "direct" | "router";

export type RuntimeGuardrailPhase =
  | "input"
  | "context"
  | "model.preflight"
  | "tool.before"
  | "tool.after"
  | "output";

export type RuntimeGuardrailAction =
  | "allow"
  | "audit"
  | "taint"
  | "redact"
  | "rewrite"
  | "block"
  | "approval";

export type RuntimeGuardrailRisk = "none" | "low" | "medium" | "high" | "critical";

export interface RuntimeGuardrailDecision {
  readonly id: string;
  readonly policyId: string;
  readonly policyVersion?: string;
  readonly phase: RuntimeGuardrailPhase;
  readonly action: RuntimeGuardrailAction;
  readonly risk: RuntimeGuardrailRisk;
  readonly reason: string;
  readonly latencyMs?: number;
  readonly fallbackUsed?: boolean;
}

/** Compatibility alias while the dedicated guardrail package lands in O-R3. */
export type RuntimePlanGuardrailDecision = RuntimeGuardrailDecision;

export type RuntimePlanJsonPrimitive = string | number | boolean | null;
export type RuntimePlanJsonValue =
  | RuntimePlanJsonPrimitive
  | readonly RuntimePlanJsonValue[]
  | { readonly [key: string]: RuntimePlanJsonValue };

/**
 * Host-neutral context policy references only. Raw context, prompts, retrieved
 * documents, and messages never belong in a Runtime Plan.
 */
export type RuntimeContextPolicy = Readonly<Record<string, RuntimePlanJsonValue>>;

export interface RuntimeDecisionAudit {
  readonly resolvedAt: string;
  readonly planner: string;
  readonly reasons: readonly string[];
  readonly warnings: readonly string[];
  readonly policyIds: readonly string[];
  readonly confidence?: number;
  /** Named planning-stage latency measurements in milliseconds. */
  readonly latencyMs?: Readonly<Record<string, number>>;
  readonly fallbackUsed: boolean;
}

export interface RuntimePlan {
  readonly id: string;
  readonly surface: RuntimeSurface;
  readonly source: RuntimeInvocationSource;
  readonly execution: Readonly<{
    mode: RuntimeExecutionMode;
    loop?: string;
    source: RuntimeDecisionSource;
  }>;
  readonly model: Readonly<{
    selection: ModelSelection;
    profile?: string;
    source: RuntimeDecisionSource;
  }>;
  readonly sandbox: Readonly<{
    isolation: SandboxIsolation;
    source: Extract<RuntimeDecisionSource, "request" | "agent" | "default">;
  }>;
  readonly tools: Readonly<{
    exposure: RuntimeToolExposure;
    allowed: readonly string[];
  }>;
  readonly guardrails: readonly RuntimeGuardrailDecision[];
  readonly context: RuntimeContextPolicy;
  readonly audit: RuntimeDecisionAudit;
}

export interface CreateRuntimePlanInput {
  readonly id?: string;
  readonly surface: RuntimeSurface;
  readonly source: RuntimeInvocationSource;
  readonly execution?: Readonly<{
    mode?: RuntimeExecutionMode;
    loop?: string;
    source?: RuntimeDecisionSource;
  }>;
  readonly model: Readonly<{
    selection: ModelSelection;
    profile?: string;
    source?: RuntimeDecisionSource;
  }>;
  readonly sandbox?: Readonly<{
    isolation?: SandboxIsolation;
    source?: Extract<RuntimeDecisionSource, "request" | "agent" | "default">;
  }>;
  readonly tools?: Readonly<{
    exposure?: RuntimeToolExposure;
    allowed?: readonly string[];
  }>;
  readonly guardrails?: readonly RuntimeGuardrailDecision[];
  readonly context?: RuntimeContextPolicy;
  readonly audit?: Readonly<{
    planner?: string;
    reasons?: readonly string[];
    warnings?: readonly string[];
    policyIds?: readonly string[];
    confidence?: number;
    latencyMs?: Readonly<Record<string, number>>;
    fallbackUsed?: boolean;
  }>;
}

export interface RuntimePlanFactoryOptions {
  readonly createId?: () => string;
  readonly now?: () => Date | string;
}

export interface RuntimePlanResolvedEvent {
  readonly type: "runtime.plan.resolved";
  readonly plan: RuntimePlan;
}
