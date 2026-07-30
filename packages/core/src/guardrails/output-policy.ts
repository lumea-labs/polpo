import type { RuntimeGuardrailDecision } from "../runtime-plan/types.js";
import {
  GuardrailAbortedError,
  GuardrailApprovalRequiredError,
  GuardrailBlockedError,
} from "./errors.js";
import { RuntimeGuardrailEngine } from "./engine.js";
import type {
  RunOutputPolicy,
  RunOutputPolicyOptions,
  RunOutputPolicyRequest,
  RunOutputPolicyResult,
} from "./types.js";

function terminalDecision(
  decisions: readonly RuntimeGuardrailDecision[],
): RuntimeGuardrailDecision {
  return decisions[decisions.length - 1]!;
}

export function createRunOutputPolicy(
  engine: RuntimeGuardrailEngine,
  options: RunOutputPolicyOptions = {},
): RunOutputPolicy {
  const streamingMode = options.streamingMode ?? "audit";
  if (streamingMode !== "audit" && streamingMode !== "buffer") {
    throw new TypeError('streamingMode must be "audit" or "buffer"');
  }

  return Object.freeze({
    streamingMode,
    async evaluate(
      request: RunOutputPolicyRequest,
    ): Promise<RunOutputPolicyResult> {
      if (typeof request.output !== "string") {
        throw new TypeError("Guardrail output must be a string");
      }
      if (request.mode !== "enforce" && request.mode !== "audit") {
        throw new TypeError('Guardrail output mode must be "enforce" or "audit"');
      }

      const evaluation = await engine.evaluate({
        phase: "output",
        value: request.output,
        context: request.context,
        signal: request.signal,
      });

      if (request.mode === "audit") {
        return Object.freeze({
          output: request.output,
          decisions: evaluation.decisions,
          enforced: false,
        });
      }

      if (evaluation.terminalAction === "block") {
        throw new GuardrailBlockedError(
          terminalDecision(evaluation.decisions).reason,
          evaluation.decisions,
        );
      }
      if (evaluation.terminalAction === "approval") {
        const decision = terminalDecision(evaluation.decisions);
        if (!options.approval) {
          throw new GuardrailApprovalRequiredError(
            decision.reason,
            evaluation.decisions,
          );
        }
        const approval = await options.approval(
          Object.freeze({
            ...request,
            output: typeof evaluation.value === "string"
              ? evaluation.value
              : request.output,
          }),
          decision,
        );
        if (request.signal?.aborted) {
          throw new GuardrailAbortedError(
            "Guardrail output approval was interrupted",
            evaluation.decisions,
          );
        }
        if (approval !== "approved") {
          throw new GuardrailBlockedError(
            "Guardrail output approval was denied",
            evaluation.decisions,
          );
        }
      }
      if (typeof evaluation.value !== "string") {
        throw new GuardrailBlockedError(
          "Guardrail rewrote output to a non-string value",
          evaluation.decisions,
        );
      }

      return Object.freeze({
        output: evaluation.value,
        decisions: evaluation.decisions,
        enforced: true,
      });
    },
  });
}
