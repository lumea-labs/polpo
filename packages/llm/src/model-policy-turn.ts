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
  durationMs: number;
}

export type ModelPolicyEvent =
  | { type: "model-attempt-started"; attempt: ModelPolicyAttempt }
  | { type: "model-attempt-first-event"; attempt: ModelPolicyAttempt; latencyMs: number }
  | { type: "model-attempt-failed"; failure: ModelPolicyAttemptFailure }
  | {
      type: "model-retry-scheduled";
      from: ModelPolicyAttempt;
      to: ModelPolicyAttempt;
      delayMs: number;
      reason: NormalizedModelError;
    }
  | { type: "model-fallback-selected"; from: ModelPolicyAttempt; to: ModelPolicyAttempt; reason: NormalizedModelError }
  | { type: "model-attempt-succeeded"; attempt: ModelPolicyAttempt; durationMs: number }
  | { type: "model-turn-failed"; failures: ModelPolicyAttemptFailure[] };

export interface ModelRetryBackoff {
  initialDelayMs?: number;
  maxDelayMs?: number;
  jitter?: "full" | "none";
}

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
  maxPreCommitRetries?: number;
  /** @deprecated Use maxPreCommitRetries. Preserved for compatibility. */
  maxRecoverableStreamRetries?: number;
  retryBackoff?: ModelRetryBackoff;
  /** Wall-clock budget shared by retries and fallback candidates. Default 10 minutes. */
  modelTurnTimeoutMs?: number;
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
  const turnStartedAt = Date.now();
  const modelTurnTimeoutMs = normalizeNonNegativeInteger(input.modelTurnTimeoutMs, 600_000);
  const maxPreCommitRetries = normalizeRetryCount(
    input.maxPreCommitRetries ?? input.maxRecoverableStreamRetries,
  );
  const runAttempt: ModelPolicyAttemptRunner<TOOLS> =
    input.runAttempt ?? ((attemptInput, attemptEventHandler) =>
      streamModelTurn<TOOLS>(attemptInput, attemptEventHandler));
  const failures: ModelPolicyAttemptFailure[] = [];

  for (let candidateIndex = 0; candidateIndex < policy.candidates.length; candidateIndex += 1) {
    const model = policy.candidates[candidateIndex];

    for (let retryIndex = 0; retryIndex <= maxPreCommitRetries; retryIndex += 1) {
      const remainingMs = remainingTurnMs(turnStartedAt, modelTurnTimeoutMs);
      if (remainingMs === 0) {
        await emitPolicyEvent(input.onPolicyEvent, { type: "model-turn-failed", failures });
        const timeout = Object.assign(new Error(
          `Model turn exceeded its ${modelTurnTimeoutMs}ms total timeout`,
        ), { code: "model_turn_timeout" });
        throw new ModelPolicyTurnError(timeout.message, failures, timeout);
      }
      const attempt = createAttempt(candidateIndex, retryIndex, model, policy.candidates.length);
      const attemptStartedAt = Date.now();
      await emitPolicyEvent(input.onPolicyEvent, { type: "model-attempt-started", attempt });

      const resolution = await input.resolveAttempt(attempt, policy);
      const attemptBudgetMs = remainingTurnMs(turnStartedAt, modelTurnTimeoutMs);
      if (attemptBudgetMs === 0) {
        await emitPolicyEvent(input.onPolicyEvent, { type: "model-turn-failed", failures });
        const timeout = Object.assign(new Error(
          `Model turn exceeded its ${modelTurnTimeoutMs}ms total timeout`,
        ), { code: "model_turn_timeout" });
        throw new ModelPolicyTurnError(timeout.message, failures, timeout);
      }
      const attemptInput = buildAttemptInput(
        input,
        resolution,
        attemptBudgetMs,
      );
      const bufferedEvents: ModelTurnEvent<TOOLS>[] = [];
      const openToolInputs = new Map<string, string>();
      let committed = false;
      let firstEventSeen = false;

      const forwardEvent = async (event: ModelTurnEvent<TOOLS>) => {
        if (!firstEventSeen) {
          firstEventSeen = true;
          await emitPolicyEvent(input.onPolicyEvent, {
            type: "model-attempt-first-event",
            attempt,
            latencyMs: Math.max(0, Date.now() - attemptStartedAt),
          });
        }
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
        await emitPolicyEvent(input.onPolicyEvent, {
          type: "model-attempt-succeeded",
          attempt,
          durationMs: Math.max(0, Date.now() - attemptStartedAt),
        });
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
        const failure: ModelPolicyAttemptFailure = {
          attempt,
          error,
          classification,
          committed,
          durationMs: Math.max(0, Date.now() - attemptStartedAt),
        };
        failures.push(failure);
        await emitPolicyEvent(input.onPolicyEvent, { type: "model-attempt-failed", failure });

        for (const [id, name] of openToolInputs) {
          const { raw: _raw, ...publicError } = classification;
          await onEvent?.({ type: "tool-input-aborted", id, name, error: publicError });
        }

        const canRetryBeforeCommit = !committed
          && classification.retryable
          && retryIndex < maxPreCommitRetries;
        if (canRetryBeforeCommit) {
          const next = createAttempt(
            candidateIndex,
            retryIndex + 1,
            model,
            policy.candidates.length,
          );
          const delayMs = Math.min(
            retryDelayMs(input.retryBackoff, retryIndex),
            remainingTurnMs(turnStartedAt, modelTurnTimeoutMs) || 0,
          );
          await emitPolicyEvent(input.onPolicyEvent, {
            type: "model-retry-scheduled",
            from: attempt,
            to: next,
            delayMs,
            reason: classification,
          });
          await waitForRetry(delayMs, input.abortSignal);
          continue;
        }

        const nextModel = policy.candidates[candidateIndex + 1];
        if (!committed && classification.retryable && nextModel) {
          const next = createAttempt(candidateIndex + 1, 0, nextModel, policy.candidates.length);
          await emitPolicyEvent(input.onPolicyEvent, {
            type: "model-fallback-selected",
            from: attempt,
            to: next,
            reason: classification,
          });
          break;
        }

        await emitPolicyEvent(input.onPolicyEvent, { type: "model-turn-failed", failures });
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

  await emitPolicyEvent(input.onPolicyEvent, { type: "model-turn-failed", failures });
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

function retryDelayMs(
  input: ModelRetryBackoff | undefined,
  retryIndex: number,
): number {
  const initial = normalizeNonNegativeInteger(input?.initialDelayMs, 500);
  const maximum = normalizeNonNegativeInteger(input?.maxDelayMs, 5_000);
  const capped = Math.min(maximum, initial * (2 ** Math.max(0, retryIndex)));
  if (capped === 0 || input?.jitter === "none") return capped;
  return Math.floor(Math.random() * (capped + 1));
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function remainingTurnMs(startedAt: number, timeoutMs: number): number {
  if (timeoutMs === 0) return Number.POSITIVE_INFINITY;
  return Math.max(0, timeoutMs - (Date.now() - startedAt));
}

async function waitForRetry(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? new Error("Model retry cancelled");
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason ?? new Error("Model retry cancelled"));
    };
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function emitPolicyEvent(
  sink: RunModelPolicyTurnInput["onPolicyEvent"],
  event: ModelPolicyEvent,
): Promise<void> {
  if (!sink) return;
  try {
    await sink(event);
  } catch {
    // Model reliability telemetry must never change completion semantics.
  }
}

function buildAttemptInput<TOOLS extends ToolSet>(
  input: RunModelPolicyTurnInput<TOOLS>,
  resolution: ModelPolicyAttemptResolution<TOOLS>,
  remainingMs: number,
): StreamModelTurnInput<TOOLS> {
  const configuredAttemptTotal = input.streamTimeouts?.totalMs;
  const attemptTotalMs = Number.isFinite(remainingMs)
    ? Math.min(
        remainingMs,
        configuredAttemptTotal !== undefined && configuredAttemptTotal > 0
          ? configuredAttemptTotal
          : remainingMs,
      )
    : configuredAttemptTotal;
  return {
    ...(input.system ? { system: input.system } : {}),
    messages: input.messages,
    ...(input.tools ? { tools: input.tools } : {}),
    ...(input.activeTools ? { activeTools: input.activeTools } : {}),
    ...(input.toolChoice ? { toolChoice: input.toolChoice } : {}),
    ...(input.parallelToolCalls !== undefined ? { parallelToolCalls: input.parallelToolCalls } : {}),
    // The policy supervisor is the only retry owner. AI SDK retries here would
    // multiply with same-model replays and provider fallback attempts.
    maxRetries: 0,
    ...(input.timeout !== undefined ? { timeout: input.timeout } : {}),
    ...(
      input.streamTimeouts !== undefined || attemptTotalMs !== undefined
        ? {
            streamTimeouts: {
              ...(input.streamTimeouts ?? {}),
              ...(attemptTotalMs !== undefined ? { totalMs: attemptTotalMs } : {}),
            },
          }
        : {}
    ),
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    ...(input.output ? { output: input.output } : {}),
    model: resolution.model,
    ...(resolution.maxOutputTokens !== undefined ? { maxOutputTokens: resolution.maxOutputTokens } : {}),
    ...(resolution.providerOptions ? { providerOptions: resolution.providerOptions } : {}),
  };
}
