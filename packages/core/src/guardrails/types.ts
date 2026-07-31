import type {
  RuntimeGuardrailAction,
  RuntimeGuardrailDecision,
  RuntimeGuardrailPhase,
  RuntimeGuardrailRisk,
  RuntimeInvocationSource,
  RuntimeSurface,
} from "../runtime-plan/types.js";

export type RuntimeToolSideEffect = "read" | "write" | "unknown";

export interface RuntimeGuardrailScope {
  readonly expected?: Readonly<Record<string, string | undefined>>;
  readonly actual?: Readonly<Record<string, string | undefined>>;
}

/**
 * Host-neutral guardrail context. Hosts may attach identifiers used for
 * auditing and scope comparison, but must never place credentials here.
 */
export interface RuntimeGuardrailContext {
  readonly planId?: string;
  readonly surface?: RuntimeSurface;
  readonly source?: RuntimeInvocationSource;
  readonly agent?: string;
  readonly runId?: string;
  readonly sessionId?: string;
  readonly scope?: RuntimeGuardrailScope;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface RuntimeGuardrailToolContext {
  readonly name: string;
  readonly callId?: string;
  readonly sideEffect: RuntimeToolSideEffect;
  readonly schema?: unknown;
}

export interface RuntimeGuardrailEvaluationInput<T = unknown> {
  readonly phase: RuntimeGuardrailPhase;
  readonly value: T;
  readonly context: RuntimeGuardrailContext;
  readonly tool?: RuntimeGuardrailToolContext;
  readonly signal?: AbortSignal;
  readonly outputTruncated?: boolean;
}

export interface RuntimeGuardrailPolicyResult<T = unknown> {
  readonly action: RuntimeGuardrailAction;
  readonly risk: RuntimeGuardrailRisk;
  readonly reason: string;
  /**
   * Required for redact/rewrite. The engine passes this value to subsequent
   * policies and, eventually, the guarded operation.
   */
  readonly value?: T;
  readonly fallbackUsed?: boolean;
}

export interface RuntimeGuardrailPolicy<T = unknown> {
  readonly id: string;
  readonly version?: string;
  readonly priority?: number;
  readonly phases: readonly RuntimeGuardrailPhase[];
  evaluate(
    input: RuntimeGuardrailEvaluationInput<T>,
  ): RuntimeGuardrailPolicyResult<T> | null | Promise<RuntimeGuardrailPolicyResult<T> | null>;
}

export interface RuntimeGuardrailEvaluation<T = unknown> {
  readonly value: T;
  readonly decisions: readonly RuntimeGuardrailDecision[];
  readonly terminalAction?: Extract<RuntimeGuardrailAction, "block" | "approval">;
}

export interface RuntimeGuardrailAuditEvent {
  readonly decision: RuntimeGuardrailDecision;
  readonly context: RuntimeGuardrailContext;
  readonly tool?: Readonly<{
    name: string;
    callId?: string;
    sideEffect: RuntimeToolSideEffect;
  }>;
  readonly outputTruncated?: boolean;
}

export interface RuntimeGuardrailEngineOptions {
  readonly createId?: () => string;
  readonly now?: () => number;
  /**
   * Secret-free decision sink. The evaluated value and tool schema are
   * intentionally excluded from the event.
   */
  readonly onDecision?: (event: RuntimeGuardrailAuditEvent) => void | Promise<void>;
  readonly readOnlyPolicyFailure?: "audit" | "block";
}

export interface RunToolRequest {
  readonly callId?: string;
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly schema?: unknown;
  readonly sideEffect?: RuntimeToolSideEffect;
  readonly context: RuntimeGuardrailContext;
  readonly signal?: AbortSignal;
}

export type RunToolNext = (request: RunToolRequest) => Promise<string>;

export interface RunToolExecutionResult {
  readonly output: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly decisions: readonly RuntimeGuardrailDecision[];
  readonly outputTruncated: boolean;
}

export type RuntimeGuardrailApprovalResult = "approved" | "denied";

export type RuntimeGuardrailApprovalHandler = (
  request: RunToolRequest,
  decision: RuntimeGuardrailDecision,
) => RuntimeGuardrailApprovalResult | Promise<RuntimeGuardrailApprovalResult>;

export interface RunToolMiddleware {
  execute(request: RunToolRequest, next: RunToolNext): Promise<RunToolExecutionResult>;
}

export interface RunToolMiddlewareOptions {
  readonly approval?: RuntimeGuardrailApprovalHandler;
  /** Maximum tool-result content characters evaluated and returned to the model. */
  readonly maxOutputCharacters?: number;
}

export type RuntimeOutputEnforcementMode = "enforce" | "audit";
export type RuntimeStreamingOutputMode = "audit" | "buffer";

export interface RunOutputPolicyRequest {
  readonly output: string;
  readonly mode: RuntimeOutputEnforcementMode;
  readonly context: RuntimeGuardrailContext;
  readonly signal?: AbortSignal;
}

export interface RunOutputPolicyResult {
  readonly output: string;
  readonly decisions: readonly RuntimeGuardrailDecision[];
  /** False means the output was already delivered and decisions are observational. */
  readonly enforced: boolean;
}

export type RuntimeGuardrailOutputApprovalHandler = (
  request: RunOutputPolicyRequest,
  decision: RuntimeGuardrailDecision,
) => RuntimeGuardrailApprovalResult | Promise<RuntimeGuardrailApprovalResult>;

export interface RunOutputPolicy {
  readonly streamingMode: RuntimeStreamingOutputMode;
  evaluate(request: RunOutputPolicyRequest): Promise<RunOutputPolicyResult>;
}

export interface RunOutputPolicyOptions {
  readonly approval?: RuntimeGuardrailOutputApprovalHandler;
  readonly streamingMode?: RuntimeStreamingOutputMode;
}

export type RuntimeGuardrailPreflightPhase =
  | "input"
  | "context"
  | "model.preflight";

export interface RunPreflightPolicyRequest<T = unknown> {
  readonly phase: RuntimeGuardrailPreflightPhase;
  readonly value: T;
  readonly mode: RuntimeOutputEnforcementMode;
  readonly context: RuntimeGuardrailContext;
  readonly signal?: AbortSignal;
}

export interface RunPreflightPolicyResult<T = unknown> {
  readonly value: T;
  readonly decisions: readonly RuntimeGuardrailDecision[];
  readonly enforced: boolean;
}

export interface RunPreflightPolicy {
  evaluate<T = unknown>(
    request: RunPreflightPolicyRequest<T>,
  ): Promise<RunPreflightPolicyResult<T>>;
}

export type RuntimeGuardrailPolicyPack = "standard" | "strict" | "custom";
export type RuntimeGuardrailContentAction = "audit" | "redact" | "block";

/**
 * A caller may only request the strict built-in pack. The runtime combines it
 * with an already-authorized project policy and rejects any request that would
 * enable guardrails from nothing or replace a custom policy ambiguously.
 */
export interface RuntimeGuardrailRequestPolicy {
  readonly policyPack: "strict";
}

/**
 * Serializable deterministic content rule. Matching deliberately uses bounded
 * literal terms rather than user-authored regular expressions.
 */
export interface RuntimeGuardrailContentRule {
  readonly id: string;
  readonly phases: readonly (
    | RuntimeGuardrailPreflightPhase
    | "output"
  )[];
  readonly action: RuntimeGuardrailContentAction;
  readonly risk: Exclude<RuntimeGuardrailRisk, "none">;
  readonly containsAny: readonly string[];
  readonly caseSensitive?: boolean;
  readonly replacement?: string;
}

/**
 * Serializable, host-neutral settings that may cross a process boundary in a
 * RunnerConfig. The absent setting is deliberately the disabled state.
 */
export interface RuntimeGuardrailSettings {
  /**
   * Product-level pack. New configurations should use this field. The legacy
   * split pack fields below remain supported for existing deployments.
   */
  readonly policyPack?: RuntimeGuardrailPolicyPack;
  readonly contentRules?: readonly RuntimeGuardrailContentRule[];
  readonly maxInputCharacters?: number;
  readonly maxContextCharacters?: number;
  readonly maxModelInputCharacters?: number;
  /** @deprecated Use policyPack. */
  readonly toolPolicyPack?: "default";
  /** @deprecated Use policyPack. */
  readonly outputPolicyPack?: "default";
  readonly maxToolOutputCharacters?: number;
  readonly maxFinalOutputCharacters?: number;
  readonly readOnlyPolicyFailure?: "audit" | "block";
  readonly streamingOutputMode?: RuntimeStreamingOutputMode;
}

/**
 * Process-local adapters. These callbacks are never persisted in settings or
 * RunnerConfig and therefore remain the responsibility of the active host.
 */
export interface RuntimeGuardrailHostAdapters {
  readonly approval?: RuntimeGuardrailApprovalHandler;
  readonly outputApproval?: RuntimeGuardrailOutputApprovalHandler;
  readonly onDecision?: RuntimeGuardrailEngineOptions["onDecision"];
  /**
   * Process-local policies such as bounded model classifiers. Implementations
   * and private prompts never enter serialized runtime settings.
   */
  readonly policies?: readonly RuntimeGuardrailPolicy[];
}
