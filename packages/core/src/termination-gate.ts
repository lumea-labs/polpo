import type { RuntimeHookDecision, RuntimeHookJson } from "./runtime-hooks.js";

/** Explicit, cumulative limits for one agent invocation, including its repairs. */
export interface TerminationGatePolicy {
  maxCycles: number;
  maxDurationMs: number;
  maxTokens: number;
}

export interface TerminationGateState {
  version: 1;
  cycles: number;
  attempts: number;
  startedAt: number;
  tokens: number;
  policy?: TerminationGatePolicy;
  pending?: boolean;
  accepted?: boolean;
}

export class TerminationGateError extends Error {
  override readonly name = "TerminationGateError";
  constructor(readonly code: string, message: string) { super(message); }
}

export function validateTerminationGatePolicy(value: unknown): TerminationGatePolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("terminationGate requires explicit limits");
  const p = value as Record<string, unknown>;
  for (const [key, ceiling] of [["maxCycles", 20], ["maxDurationMs", 3_600_000], ["maxTokens", 10_000_000]] as const) {
    if (!Number.isSafeInteger(p[key]) || Number(p[key]) < 1 || Number(p[key]) > ceiling) {
      throw new Error(`terminationGate.${key} must be an integer between 1 and ${ceiling}`);
    }
  }
  return { maxCycles: p.maxCycles as number, maxDurationMs: p.maxDurationMs as number, maxTokens: p.maxTokens as number };
}

export function intersectTerminationGatePolicies(policies: readonly TerminationGatePolicy[]): TerminationGatePolicy | undefined {
  if (!policies.length) return undefined;
  return {
    maxCycles: Math.min(...policies.map(p => p.maxCycles)),
    maxDurationMs: Math.min(...policies.map(p => p.maxDurationMs)),
    maxTokens: Math.min(...policies.map(p => p.maxTokens)),
  };
}

/** Provider-neutral gate state. Hosts persist it together with conversation history. */
export class TerminationGate {
  readonly policy: TerminationGatePolicy;
  private state: TerminationGateState;
  constructor(policy: TerminationGatePolicy, state?: TerminationGateState, private readonly now: () => number = Date.now) {
    this.policy = validateTerminationGatePolicy(policy);
    if (state) {
      if (state.version !== 1 || ![state.cycles, state.attempts, state.startedAt, state.tokens].every(n => Number.isSafeInteger(n) && n >= 0)
        || state.attempts < state.cycles
        || (state.pending && state.accepted) || (state.pending && state.attempts <= state.cycles)
        || (state.accepted && state.attempts <= state.cycles)
        || !state.policy || state.startedAt > now() || (state.pending !== undefined && typeof state.pending !== "boolean")
        || (state.accepted !== undefined && typeof state.accepted !== "boolean")) {
        throw new TerminationGateError("termination_gate_checkpoint_invalid", "Invalid termination gate checkpoint");
      }
      if (state.policy) this.policy = intersectTerminationGatePolicies([this.policy, validateTerminationGatePolicy(state.policy)])!;
    }
    this.state = { version: 1, cycles: 0, attempts: 0, startedAt: now(), tokens: 0, ...state, policy: this.policy };
  }
  resumeWork(): void { this.state.accepted = false; this.state.pending = false; }
  snapshot(): TerminationGateState { return structuredClone(this.state); }
  get remainingMs(): number { return Math.max(0, this.policy.maxDurationMs - (this.now() - this.state.startedAt)); }
  get remainingTokens(): number { return Math.max(0, this.policy.maxTokens - this.state.tokens); }
  assertAvailable(): void {
    if (this.remainingMs <= 0) throw new TerminationGateError("termination_gate_time_exhausted", "Termination gate time limit exhausted");
    if (this.remainingTokens <= 0) throw new TerminationGateError("termination_gate_tokens_exhausted", "Termination gate tokens limit exhausted");
  }
  recordUsage(usage: { totalTokens?: number; inputTokens?: number; outputTokens?: number }): void {
    const count = usage.totalTokens ?? (usage.inputTokens !== undefined && usage.outputTokens !== undefined ? usage.inputTokens + usage.outputTokens : undefined);
    if (count === undefined || !Number.isSafeInteger(count) || count < 0) throw new TerminationGateError("termination_gate_usage_unknown", "Cannot enforce termination gate token budget without usage");
    this.state.tokens += count;
  }
  beginAttempt(): number {
    this.assertAvailable();
    if (!this.state.pending) this.state.attempts += 1;
    this.state.pending = true;
    this.state.accepted = false;
    return this.state.attempts;
  }
  decide(decision: RuntimeHookDecision, remainingTurns: number): string | undefined {
    this.assertAvailable();
    if (!this.state.pending) throw new TerminationGateError("termination_gate_checkpoint_invalid", "No pending termination attempt");
    const feedback = decision.action === "continue" ? decision.feedback
      : decision.action === "stop" && decision.feedback?.trim() ? decision.feedback : undefined;
    if (feedback !== undefined) {
      if (this.state.cycles >= this.policy.maxCycles) throw new TerminationGateError("termination_gate_cycles_exhausted", "Termination gate cycles limit exhausted");
      if (remainingTurns <= 0) throw new TerminationGateError("termination_gate_turns_exhausted", "Termination gate cannot continue: agent turns exhausted");
      this.state.cycles += 1;
      this.state.pending = false;
      this.state.accepted = false;
      return renderTerminationGateFeedback(feedback);
    }
    if (decision.action !== "allow") {
      throw new TerminationGateError("termination_gate_rejected", `Termination gate rejected completion: ${"reason" in decision ? decision.reason ?? decision.action : decision.action}`);
    }
    this.state.pending = false;
    this.state.accepted = true;
    return undefined;
  }
}

export function renderTerminationGateFeedback(feedback: RuntimeHookJson): string {
  return `A trusted termination validator rejected this completion. Correct the reported problems in this same conversation using your authorized tools. Preserve completed work and do not repeat already committed side effects. Attempt completion again only after correction.\n\nValidation diagnostics:\n${typeof feedback === "string" ? feedback : JSON.stringify(feedback)}`;
}
