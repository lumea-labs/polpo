import type { ToolSet } from "ai";
import type {
  ModelSelection,
  NormalizedModelPolicy,
} from "@polpo-ai/core";
import { normalizeModelPolicy } from "@polpo-ai/core";

import type {
  ModelTurnEvent,
  ModelTurnResult,
  StreamModelTurnInput,
} from "./stream-turn.js";
import { streamModelTurn } from "./stream-turn.js";
import type { NormalizedModelError } from "./model-runtime.js";
import { classifyRuntimeError } from "./runtime-normalization.js";

export interface ModelPolicyAttempt {
  index: number;
  model: string;
  isFallback: boolean;
  totalCandidates: number;
}

export interface ModelPolicyAttemptResolution<TOOLS extends ToolSet = ToolSet> {
  model: StreamModelTurnInput<TOOLS>["model"];
  maxOutputTokens?: number;
  providerOptions?: StreamModelTurnInput<TOOLS>["providerOptions"];
  metadata?: Record<string, unknown>;
}

export interface ModelPolicyAttemptFailure {
  attempt: ModelPolicyAttempt;
  error: unknown;
  classification: NormalizedModelError;
  committed: boolean;
}

export type ModelPolicyEvent =
  | { type: "model-attempt-started"; attempt: ModelPolicyAttempt }
  | { type: "model-attempt-failed"; failure: ModelPolicyAttemptFailure }
  | { type: "model-fallback-selected"; from: ModelPolicyAttempt; to: ModelPolicyAttempt; reason: NormalizedModelError }
  | { type: "model-attempt-succeeded"; attempt: ModelPolicyAttempt }
  | { type: "model-turn-failed"; failures: ModelPolicyAttemptFailure[] };

export type ModelPolicyAttemptRunner<TOOLS extends ToolSet = ToolSet> = (
  input: StreamModelTurnInput<TOOLS>,
  onEvent?: (event: ModelTurnEvent<TOOLS>) => void | Promise<void>,
) => Promise<ModelTurnResult<TOOLS>>;

export interface RunModelPolicyTurnInput<TOOLS extends ToolSet = ToolSet>
  extends Omit<StreamModelTurnInput<TOOLS>, "model" | "maxOutputTokens" | "providerOptions"> {
  selection: ModelSelection;
  resolveAttempt: (attempt: ModelPolicyAttempt, policy: NormalizedModelPolicy) =>
    | ModelPolicyAttemptResolution<TOOLS>
    | Promise<ModelPolicyAttemptResolution<TOOLS>>;
  runAttempt?: ModelPolicyAttemptRunner<TOOLS>;
  classifyError?: (error: unknown, attempt: ModelPolicyAttempt) => NormalizedModelError;
  onPolicyEvent?: (event: ModelPolicyEvent) => void | Promise<void>;
  preserveSingleAttemptError?: boolean;
}

export type ModelPolicyTurnResult<TOOLS extends ToolSet = ToolSet> = ModelTurnResult<TOOLS> & {
  policy: NormalizedModelPolicy;
  selectedAttempt: ModelPolicyAttempt;
  failedAttempts: ModelPolicyAttemptFailure[];
};

export class ModelPolicyTurnError extends Error {
  readonly failures: ModelPolicyAttemptFailure[];

  constructor(message: string, failures: ModelPolicyAttemptFailure[]) {
    super(message);
    this.name = "ModelPolicyTurnError";
    this.failures = failures;
  }
}

export async function runModelPolicyTurn<TOOLS extends ToolSet = ToolSet>(
  input: RunModelPolicyTurnInput<TOOLS>,
  onEvent?: (event: ModelTurnEvent<TOOLS>) => void | Promise<void>,
): Promise<ModelPolicyTurnResult<TOOLS>> {
  const policy = normalizeModelPolicy(input.selection);
  const attempts = policy.candidates.map((model, index): ModelPolicyAttempt => ({
    index,
    model,
    isFallback: index > 0,
    totalCandidates: policy.candidates.length,
  }));
  const runAttempt: ModelPolicyAttemptRunner<TOOLS> =
    input.runAttempt ?? ((attemptInput, attemptEventHandler) =>
      streamModelTurn<TOOLS>(attemptInput, attemptEventHandler));
  const failures: ModelPolicyAttemptFailure[] = [];

  for (const attempt of attempts) {
    await input.onPolicyEvent?.({ type: "model-attempt-started", attempt });

    const resolution = await input.resolveAttempt(attempt, policy);
    const attemptInput = buildAttemptInput(input, resolution);
    const bufferedEvents: ModelTurnEvent<TOOLS>[] = [];
    let committed = false;

    const forwardEvent = async (event: ModelTurnEvent<TOOLS>) => {
      if (!committed && isCommittingModelTurnEvent(event)) {
        committed = true;
        for (const buffered of bufferedEvents) {
          await onEvent?.(buffered);
        }
        bufferedEvents.length = 0;
      }

      if (committed) {
        await onEvent?.(event);
      } else {
        bufferedEvents.push(event);
      }
    };

    try {
      const result = await runAttempt(attemptInput, forwardEvent);
      if (!committed) {
        for (const buffered of bufferedEvents) {
          await onEvent?.(buffered);
        }
      }
      await input.onPolicyEvent?.({ type: "model-attempt-succeeded", attempt });
      return {
        ...result,
        policy,
        selectedAttempt: attempt,
        failedAttempts: failures,
      };
    } catch (error) {
      const classification = input.classifyError?.(error, attempt) ?? classifyRuntimeError(error);
      const failure: ModelPolicyAttemptFailure = {
        attempt,
        error,
        classification,
        committed,
      };
      failures.push(failure);
      await input.onPolicyEvent?.({ type: "model-attempt-failed", failure });

      const next = attempts[attempt.index + 1];
      if (!committed && classification.retryable && next) {
        await input.onPolicyEvent?.({
          type: "model-fallback-selected",
          from: attempt,
          to: next,
          reason: classification,
        });
        continue;
      }

      await input.onPolicyEvent?.({ type: "model-turn-failed", failures });
      if (input.preserveSingleAttemptError && attempts.length === 1) {
        if (!committed) {
          for (const buffered of bufferedEvents) {
            await onEvent?.(buffered);
          }
        }
        throw error;
      }
      throw new ModelPolicyTurnError(classification.message ?? "Model policy turn failed", failures);
    }
  }

  await input.onPolicyEvent?.({ type: "model-turn-failed", failures });
  throw new ModelPolicyTurnError("All model policy attempts failed", failures);
}

export function isCommittingModelTurnEvent(event: ModelTurnEvent): boolean {
  return event.type === "reasoning-delta"
    || event.type === "text-delta"
    || event.type === "tool-input-start"
    || event.type === "tool-input-delta"
    || event.type === "tool-input-end"
    || event.type === "tool-call"
    || event.type === "tool-result"
    || event.type === "tool-error";
}

function buildAttemptInput<TOOLS extends ToolSet>(
  input: RunModelPolicyTurnInput<TOOLS>,
  resolution: ModelPolicyAttemptResolution<TOOLS>,
): StreamModelTurnInput<TOOLS> {
  return {
    ...(input.system ? { system: input.system } : {}),
    messages: input.messages,
    ...(input.tools ? { tools: input.tools } : {}),
    ...(input.activeTools ? { activeTools: input.activeTools } : {}),
    ...(input.toolChoice ? { toolChoice: input.toolChoice } : {}),
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    model: resolution.model,
    ...(resolution.maxOutputTokens !== undefined ? { maxOutputTokens: resolution.maxOutputTokens } : {}),
    ...(resolution.providerOptions ? { providerOptions: resolution.providerOptions } : {}),
  };
}
