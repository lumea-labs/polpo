import type { RuntimeGuardrailDecision } from "../runtime-plan/types.js";

export class GuardrailError extends Error {
  readonly decisions: readonly RuntimeGuardrailDecision[];

  constructor(message: string, decisions: readonly RuntimeGuardrailDecision[] = []) {
    super(message);
    this.name = new.target.name;
    this.decisions = Object.freeze([...decisions]);
  }
}

export class GuardrailBlockedError extends GuardrailError {
  readonly code = "guardrail_blocked";
}

export class GuardrailApprovalRequiredError extends GuardrailError {
  readonly code = "guardrail_approval_required";
}

export class GuardrailAbortedError extends GuardrailError {
  readonly code = "guardrail_aborted";
  readonly outcomeUncertain: boolean;

  constructor(
    message = "Guardrail evaluation was aborted",
    decisions: readonly RuntimeGuardrailDecision[] = [],
    outcomeUncertain = false,
  ) {
    super(message, decisions);
    this.outcomeUncertain = outcomeUncertain;
  }
}
