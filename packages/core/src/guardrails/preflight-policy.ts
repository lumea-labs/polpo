import {
  GuardrailApprovalRequiredError,
  GuardrailBlockedError,
} from "./errors.js";
import { RuntimeGuardrailEngine } from "./engine.js";
import type {
  RunPreflightPolicy,
  RunPreflightPolicyRequest,
  RunPreflightPolicyResult,
} from "./types.js";

function terminalReason(
  decisions: RunPreflightPolicyResult["decisions"],
): string {
  return decisions[decisions.length - 1]?.reason ?? "Guardrail rejected preflight input";
}

export function createRunPreflightPolicy(
  engine: RuntimeGuardrailEngine,
): RunPreflightPolicy {
  return Object.freeze({
    async evaluate<T>(
      request: RunPreflightPolicyRequest<T>,
    ): Promise<RunPreflightPolicyResult<T>> {
      if (
        request.phase !== "input"
        && request.phase !== "context"
        && request.phase !== "model.preflight"
      ) {
        throw new TypeError(
          'Preflight guardrail phase must be "input", "context", or "model.preflight"',
        );
      }
      if (request.mode !== "enforce" && request.mode !== "audit") {
        throw new TypeError('Guardrail preflight mode must be "enforce" or "audit"');
      }

      const evaluation = await engine.evaluate({
        phase: request.phase,
        value: request.value,
        context: request.context,
        signal: request.signal,
      });

      if (request.mode === "audit") {
        return Object.freeze({
          value: request.value,
          decisions: evaluation.decisions,
          enforced: false,
        });
      }
      if (evaluation.terminalAction === "block") {
        throw new GuardrailBlockedError(
          terminalReason(evaluation.decisions),
          evaluation.decisions,
        );
      }
      if (evaluation.terminalAction === "approval") {
        throw new GuardrailApprovalRequiredError(
          terminalReason(evaluation.decisions),
          evaluation.decisions,
        );
      }

      return Object.freeze({
        value: evaluation.value as T,
        decisions: evaluation.decisions,
        enforced: true,
      });
    },
  });
}
