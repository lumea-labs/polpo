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

/**
 * Serializable, host-neutral settings that may cross a process boundary in a
 * RunnerConfig. The absent setting is deliberately the disabled state.
 */
export interface RuntimeGuardrailSettings {
  readonly toolPolicyPack: "default";
  readonly maxToolOutputCharacters?: number;
  readonly readOnlyPolicyFailure?: "audit" | "block";
}

/**
 * Process-local adapters. These callbacks are never persisted in settings or
 * RunnerConfig and therefore remain the responsibility of the active host.
 */
export interface RuntimeGuardrailHostAdapters {
  readonly approval?: RuntimeGuardrailApprovalHandler;
  readonly onDecision?: RuntimeGuardrailEngineOptions["onDecision"];
}
