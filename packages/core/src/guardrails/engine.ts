import type {
  RuntimeGuardrailAction,
  RuntimeGuardrailDecision,
  RuntimeGuardrailRisk,
} from "../runtime-plan/types.js";
import { GuardrailAbortedError } from "./errors.js";
import type {
  RuntimeGuardrailEngineOptions,
  RuntimeGuardrailEvaluation,
  RuntimeGuardrailEvaluationInput,
  RuntimeGuardrailPolicy,
  RuntimeGuardrailPolicyResult,
} from "./types.js";

const VALID_ACTIONS = new Set<RuntimeGuardrailAction>([
  "allow",
  "audit",
  "taint",
  "redact",
  "rewrite",
  "block",
  "approval",
]);

const VALID_RISKS = new Set<RuntimeGuardrailRisk>([
  "none",
  "low",
  "medium",
  "high",
  "critical",
]);

function cloneValue<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (value === null || typeof value !== "object") return value;
  const existing = seen.get(value as object);
  if (existing !== undefined) return existing as T;
  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    seen.set(value, clone);
    for (const item of value) clone.push(cloneValue(item, seen));
    return clone as T;
  }
  if (value instanceof Date) return new Date(value.getTime()) as T;
  const clone: Record<string, unknown> = {};
  seen.set(value as object, clone);
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    clone[key] = cloneValue(entry, seen);
  }
  return clone as T;
}

function freezeValue<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value as object)) return value;
  seen.add(value as object);
  for (const entry of Object.values(value as Record<string, unknown>)) freezeValue(entry, seen);
  return Object.freeze(value);
}

function freezeEvaluation<T>(
  value: T,
  decisions: RuntimeGuardrailDecision[],
  terminalAction?: "block" | "approval",
): RuntimeGuardrailEvaluation<T> {
  const frozenDecisions = Object.freeze(decisions.map((decision) => Object.freeze(decision)));
  return Object.freeze({
    value: freezeValue(value),
    decisions: frozenDecisions,
    ...(terminalAction ? { terminalAction } : {}),
  });
}

function assertPolicyResult<T>(
  policy: RuntimeGuardrailPolicy<T>,
  result: RuntimeGuardrailPolicyResult<T>,
): void {
  if (!VALID_ACTIONS.has(result.action)) {
    throw new Error(`Policy "${policy.id}" returned an invalid action`);
  }
  if (!VALID_RISKS.has(result.risk)) {
    throw new Error(`Policy "${policy.id}" returned an invalid risk`);
  }
  if (typeof result.reason !== "string" || result.reason.trim().length === 0) {
    throw new Error(`Policy "${policy.id}" returned an empty reason`);
  }
  if (
    (result.action === "redact" || result.action === "rewrite") &&
    !Object.prototype.hasOwnProperty.call(result, "value")
  ) {
    throw new Error(`Policy "${policy.id}" must return a value for ${result.action}`);
  }
}

function defaultPolicyFailure(
  input: RuntimeGuardrailEvaluationInput,
  options: RuntimeGuardrailEngineOptions,
): Pick<RuntimeGuardrailDecision, "action" | "risk"> {
  if (input.tool?.sideEffect === "read" && options.readOnlyPolicyFailure !== "block") {
    return { action: "audit", risk: "medium" };
  }
  return { action: "block", risk: "high" };
}

export class RuntimeGuardrailEngine {
  private readonly policies: RuntimeGuardrailPolicy[];
  private readonly options: RuntimeGuardrailEngineOptions;
  private sequence = 0;

  constructor(
    policies: readonly RuntimeGuardrailPolicy[],
    options: RuntimeGuardrailEngineOptions = {},
  ) {
    this.policies = policies
      .map((policy, index) => ({ policy, index }))
      .sort((a, b) => (a.policy.priority ?? 100) - (b.policy.priority ?? 100) || a.index - b.index)
      .map(({ policy }) => policy);
    this.options = options;
  }

  async evaluate<T>(
    input: RuntimeGuardrailEvaluationInput<T>,
  ): Promise<RuntimeGuardrailEvaluation<T>> {
    this.throwIfAborted(input.signal);
    let value = freezeValue(cloneValue(input.value));
    const decisions: RuntimeGuardrailDecision[] = [];

    for (const policy of this.policies) {
      if (!policy.phases.includes(input.phase)) continue;
      this.throwIfAborted(input.signal, decisions);
      const startedAt = (this.options.now ?? Date.now)();
      let result: RuntimeGuardrailPolicyResult<T> | null;
      let failure: unknown;

      try {
        result = await policy.evaluate(Object.freeze({
          ...input,
          value,
        })) as RuntimeGuardrailPolicyResult<T> | null;
        this.throwIfAborted(input.signal, decisions);
        if (result) assertPolicyResult(policy, result);
      } catch (error) {
        if (error instanceof GuardrailAbortedError) throw error;
        failure = error;
        result = null;
      }

      const latencyMs = Math.max(0, (this.options.now ?? Date.now)() - startedAt);
      let decision: RuntimeGuardrailDecision | undefined;
      if (failure) {
        const fallback = defaultPolicyFailure(input, this.options);
        decision = {
          id: this.createId(),
          policyId: policy.id,
          ...(policy.version ? { policyVersion: policy.version } : {}),
          phase: input.phase,
          action: fallback.action,
          risk: fallback.risk,
          reason: "Policy evaluation failed",
          latencyMs,
          fallbackUsed: true,
        };
      } else if (result) {
        decision = {
          id: this.createId(),
          policyId: policy.id,
          ...(policy.version ? { policyVersion: policy.version } : {}),
          phase: input.phase,
          action: result.action,
          risk: result.risk,
          reason: result.reason.trim(),
          latencyMs,
          fallbackUsed: result.fallbackUsed ?? false,
        };
        if (result.action === "redact" || result.action === "rewrite") {
          value = freezeValue(cloneValue(result.value as T));
        }
      }

      if (!decision) continue;
      const frozenDecision = Object.freeze(decision);
      decisions.push(frozenDecision);
      await this.emitDecision(frozenDecision, input);
      this.throwIfAborted(input.signal, decisions);
      if (decision.action === "block" || decision.action === "approval") {
        return freezeEvaluation(value, decisions, decision.action);
      }
    }

    return freezeEvaluation(value, decisions);
  }

  private createId(): string {
    return this.options.createId?.() ?? `guardrail-${++this.sequence}`;
  }

  private throwIfAborted(
    signal?: AbortSignal,
    decisions: readonly RuntimeGuardrailDecision[] = [],
  ): void {
    if (signal?.aborted) throw new GuardrailAbortedError(undefined, decisions);
  }

  private async emitDecision(
    decision: RuntimeGuardrailDecision,
    input: RuntimeGuardrailEvaluationInput,
  ): Promise<void> {
    try {
      await this.options.onDecision?.(Object.freeze({
        decision,
        context: input.context,
        ...(input.tool
          ? {
              tool: Object.freeze({
                name: input.tool.name,
                callId: input.tool.callId,
                sideEffect: input.tool.sideEffect,
              }),
            }
          : {}),
        ...(input.outputTruncated !== undefined
          ? { outputTruncated: input.outputTruncated }
          : {}),
      }));
    } catch {
      // Audit sinks are observational and cannot change enforcement.
    }
  }
}
