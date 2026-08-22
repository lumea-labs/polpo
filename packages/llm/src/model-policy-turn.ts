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
  retryIndex: number;
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
  /** One replay is safe only before text/reasoning or a validated tool call was emitted. */
  maxRecoverableStreamRetries?: number;
}

export type ModelPolicyTurnResult<TOOLS extends ToolSet = ToolSet> = ModelTurnResult<TOOLS> & {
  policy: NormalizedModelPolicy;
  selectedAttempt: ModelPolicyAttempt;
  failedAttempts: ModelPolicyAttemptFailure[];
};

export class ModelPolicyTurnError extends Error {
  readonly failures: ModelPolicyAttemptFailure[];

  constructor(message: string, failures: ModelPolicyAttemptFailure[], cause?: unknown) {
    super(message);
    this.name = "ModelPolicyTurnError";
    this.failures = failures;
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

export async function runModelPolicyTurn<TOOLS extends ToolSet = ToolSet>(
  input: RunModelPolicyTurnInput<TOOLS>,
  onEvent?: (event: ModelTurnEvent<TOOLS>) => void | Promise<void>,
): Promise<ModelPolicyTurnResult<TOOLS>> {
  const policy = normalizeModelPolicy(input.selection);
  const maxRecoverableStreamRetries = normalizeRetryCount(
    input.maxRecoverableStreamRetries,
  );
  const runAttempt: ModelPolicyAttemptRunner<TOOLS> =
    input.runAttempt ?? ((attemptInput, attemptEventHandler) =>
      streamModelTurn<TOOLS>(attemptInput, attemptEventHandler));
  const failures: ModelPolicyAttemptFailure[] = [];

  for (let candidateIndex = 0; candidateIndex < policy.candidates.length; candidateIndex += 1) {
    const model = policy.candidates[candidateIndex];

    for (let retryIndex = 0; retryIndex <= maxRecoverableStreamRetries; retryIndex += 1) {
      const attempt = createAttempt(candidateIndex, retryIndex, model, policy.candidates.length);
      await input.onPolicyEvent?.({ type: "model-attempt-started", attempt });

      const resolution = await input.resolveAttempt(attempt, policy);
      const attemptInput = buildAttemptInput(input, resolution);
      const bufferedEvents: ModelTurnEvent<TOOLS>[] = [];
      const openToolInputs = new Map<string, string>();
      let committed = false;

      const forwardEvent = async (event: ModelTurnEvent<TOOLS>) => {
        if (event.type === "tool-input-start") openToolInputs.set(event.id, event.name);
        if (event.type === "tool-call") openToolInputs.delete(event.id);

        if (isProvisionalToolInputEvent(event)) {
          await flushEvents(bufferedEvents, onEvent);
          await onEvent?.(event);
          return;
        }

        if (!committed && isCommittingModelTurnEvent(event)) {
          committed = true;
          await flushEvents(bufferedEvents, onEvent);
        }

        if (committed) await onEvent?.(event);
        else bufferedEvents.push(event);
      };

      try {
        const result = await runAttempt(attemptInput, forwardEvent);
        await flushEvents(bufferedEvents, onEvent);
        await input.onPolicyEvent?.({ type: "model-attempt-succeeded", attempt });
        return {
          ...result,
          policy,
          selectedAttempt: attempt,
          failedAttempts: failures,
        };
      } catch (error) {
        const baseClassification = input.classifyError?.(error, attempt) ?? classifyRuntimeError(error);
        const classification: NormalizedModelError = openToolInputs.size > 0
          ? { ...baseClassification, phase: "tool-input" }
          : baseClassification;
        const failure: ModelPolicyAttemptFailure = { attempt, error, classification, committed };
        failures.push(failure);
        await input.onPolicyEvent?.({ type: "model-attempt-failed", failure });

        for (const [id, name] of openToolInputs) {
          const { raw: _raw, ...publicError } = classification;
          await onEvent?.({ type: "tool-input-aborted", id, name, error: publicError });
        }

        const canReplayPartialToolInput = !committed
          && openToolInputs.size > 0
          && classification.retryable
          && retryIndex < maxRecoverableStreamRetries;
        if (canReplayPartialToolInput) {
          continue;
        }

        const nextModel = policy.candidates[candidateIndex + 1];
        if (!committed && classification.retryable && nextModel) {
          const next = createAttempt(candidateIndex + 1, 0, nextModel, policy.candidates.length);
          await input.onPolicyEvent?.({
            type: "model-fallback-selected",
            from: attempt,
            to: next,
            reason: classification,
          });
          break;
        }

        await input.onPolicyEvent?.({ type: "model-turn-failed", failures });
        await flushEvents(bufferedEvents, onEvent);
        if (input.preserveSingleAttemptError && policy.candidates.length === 1 && error instanceof Error) {
          throw error;
        }
        throw new ModelPolicyTurnError(
          classification.message ?? "Unknown model runtime error",
          failures,
          error,
        );
      }
    }
  }

  await input.onPolicyEvent?.({ type: "model-turn-failed", failures });
  throw new ModelPolicyTurnError("All model policy attempts failed", failures);
}

export function isCommittingModelTurnEvent(event: ModelTurnEvent): boolean {
  return event.type === "reasoning-delta"
    || event.type === "text-delta"
    || event.type === "tool-call"
    || event.type === "tool-result"
    || event.type === "tool-error";
}

function isProvisionalToolInputEvent(event: ModelTurnEvent): boolean {
  return event.type === "tool-input-start"
    || event.type === "tool-input-delta"
    || event.type === "tool-input-end";
}

function createAttempt(
  index: number,
  retryIndex: number,
  model: string,
  totalCandidates: number,
): ModelPolicyAttempt {
  return {
    index,
    retryIndex,
    model,
    isFallback: index > 0,
    totalCandidates,
  };
}

async function flushEvents<TOOLS extends ToolSet>(
  events: ModelTurnEvent<TOOLS>[],
  onEvent?: (event: ModelTurnEvent<TOOLS>) => void | Promise<void>,
): Promise<void> {
  for (const event of events) await onEvent?.(event);
  events.length = 0;
}

function normalizeRetryCount(value: number | undefined): number {
  if (value === undefined) return 1;
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
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
    ...(input.parallelToolCalls !== undefined ? { parallelToolCalls: input.parallelToolCalls } : {}),
    ...(input.maxRetries !== undefined ? { maxRetries: input.maxRetries } : {}),
    ...(input.timeout !== undefined ? { timeout: input.timeout } : {}),
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    ...(input.output ? { output: input.output } : {}),
    model: resolution.model,
    ...(resolution.maxOutputTokens !== undefined ? { maxOutputTokens: resolution.maxOutputTokens } : {}),
    ...(resolution.providerOptions ? { providerOptions: resolution.providerOptions } : {}),
  };
}
