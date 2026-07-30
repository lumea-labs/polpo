import type {
  RunOutputPolicy,
  RuntimeOutputEnforcementMode,
} from "@polpo-ai/core/guardrails";
import type { RuntimePlan } from "@polpo-ai/core";

export interface CompletionOutputPolicyInput {
  readonly outputPolicy?: RunOutputPolicy;
  readonly text: string;
  readonly mode: RuntimeOutputEnforcementMode;
  readonly runtimePlan?: RuntimePlan;
  readonly agent?: string;
  readonly runId?: string;
  readonly sessionId?: string | null;
  readonly signal?: AbortSignal;
}

export async function applyCompletionOutputPolicy(
  input: CompletionOutputPolicyInput,
): Promise<string> {
  if (!input.outputPolicy) return input.text;
  const result = await input.outputPolicy.evaluate({
    output: input.text,
    mode: input.mode,
    context: {
      planId: input.runtimePlan?.id,
      surface: input.runtimePlan?.surface,
      source: input.runtimePlan?.source,
      agent: input.agent,
      runId: input.runId,
      sessionId: input.sessionId ?? undefined,
    },
    signal: input.signal,
  });
  return result.output;
}

export function streamingOutputPolicyMode(
  outputPolicy: RunOutputPolicy | undefined,
): "passthrough" | "audit" | "buffer" {
  return outputPolicy?.streamingMode ?? "passthrough";
}
