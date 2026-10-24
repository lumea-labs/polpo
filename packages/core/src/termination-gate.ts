/** Outcome of the Stop hooks for one terminal candidate. */
export type TerminationDecision =
  | { action: "allow" }
  | { action: "continue"; feedback: string };

/**
 * Optional cumulative limits for one agent invocation, including its Stop-hook
 * continuations. An omitted limit is not enforced: Stop hooks are then bounded
 * by the consecutive-continuation cap, max turns and cancellation, as in the
 * reference contract.
 */
export interface TerminationGatePolicy {
  maxCycles?: number;
  maxDurationMs?: number;
  maxTokens?: number;
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

const POLICY_CEILINGS = [["maxCycles", 1_000], ["maxDurationMs", 24 * 3_600_000], ["maxTokens", 1_000_000_000]] as const;

export function validateTerminationGatePolicy(value: unknown): TerminationGatePolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Termination policy must be an object");
  const p = value as Record<string, unknown>;
  const policy: TerminationGatePolicy = {};
  for (const [key, ceiling] of POLICY_CEILINGS) {
    if (p[key] === undefined) continue;
    if (!Number.isSafeInteger(p[key]) || Number(p[key]) < 1 || Number(p[key]) > ceiling) {
      throw new Error(`Termination policy ${key} must be an integer between 1 and ${ceiling}`);
    }
    policy[key] = p[key] as number;
  }
  return policy;
}

export function intersectTerminationGatePolicies(policies: readonly TerminationGatePolicy[]): TerminationGatePolicy | undefined {
  if (!policies.length) return undefined;
  const min = (key: keyof TerminationGatePolicy) => {
    const values = policies.map((policy) => policy[key]).filter((value): value is number => value !== undefined);
    return values.length ? Math.min(...values) : undefined;
  };
  const policy: TerminationGatePolicy = {};
  for (const [key] of POLICY_CEILINGS) {
    const value = min(key);
    if (value !== undefined) policy[key] = value;
  }
  return policy;
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
  /** Infinity when the policy sets no time limit. */
  get remainingMs(): number {
    return this.policy.maxDurationMs === undefined ? Infinity : Math.max(0, this.policy.maxDurationMs - (this.now() - this.state.startedAt));
  }
  /** Infinity when the policy sets no token limit. */
  get remainingTokens(): number {
    return this.policy.maxTokens === undefined ? Infinity : Math.max(0, this.policy.maxTokens - this.state.tokens);
  }
  assertAvailable(): void {
    if (this.remainingMs <= 0) throw new TerminationGateError("termination_gate_time_exhausted", "Termination gate time limit exhausted");
    if (this.remainingTokens <= 0) throw new TerminationGateError("termination_gate_tokens_exhausted", "Termination gate tokens limit exhausted");
  }
  recordUsage(usage: { totalTokens?: number; inputTokens?: number; outputTokens?: number }): void {
    const count = usage.totalTokens ?? (usage.inputTokens !== undefined && usage.outputTokens !== undefined ? usage.inputTokens + usage.outputTokens : undefined);
    if (count === undefined || !Number.isSafeInteger(count) || count < 0) {
      if (this.policy.maxTokens === undefined) return;
      throw new TerminationGateError("termination_gate_usage_unknown", "Cannot enforce termination gate token budget without usage");
    }
    this.state.tokens += count;
  }
  beginAttempt(): number {
    this.assertAvailable();
    if (!this.state.pending) this.state.attempts += 1;
    this.state.pending = true;
    this.state.accepted = false;
    return this.state.attempts;
  }
  decide(decision: TerminationDecision, remainingTurns: number): string | undefined {
    this.assertAvailable();
    if (!this.state.pending) throw new TerminationGateError("termination_gate_checkpoint_invalid", "No pending termination attempt");
    if (decision.action === "continue") {
      if (this.policy.maxCycles !== undefined && this.state.cycles >= this.policy.maxCycles) throw new TerminationGateError("termination_gate_cycles_exhausted", "Termination gate cycles limit exhausted");
      if (remainingTurns <= 0) throw new TerminationGateError("termination_gate_turns_exhausted", "Stop hook feedback cannot continue: agent turns exhausted");
      this.state.cycles += 1;
      this.state.pending = false;
      this.state.accepted = false;
      return renderTerminationGateFeedback(decision.feedback);
    }
    this.state.pending = false;
    this.state.accepted = true;
    return undefined;
  }
}

/** Stop-hook feedback delivered to the same agent as its next instruction. */
export function renderTerminationGateFeedback(feedback: string): string {
  return `Stop hook feedback:\n${feedback}`;
}
