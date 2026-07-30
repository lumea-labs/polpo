import type {
  Schedule,
  ScheduleAgentInvocation,
  ScheduleChannelInvocation,
  ScheduleInvocation,
  ScheduleLegacyMissionInvocation,
  ScheduleMetadata,
  ScheduleRun,
  ScheduleRunError,
  ScheduleRunReferences,
  ScheduleTaskInvocation,
  ScheduleWebhookInvocation,
} from "./types.js";
import {
  normalizeScheduleInvocation,
  normalizeScheduleMetadata,
} from "./validation.js";

export type ScheduleDispatchErrorCode =
  | "ABORTED"
  | "HANDLER_UNAVAILABLE"
  | "INVALID_CONTEXT"
  | "INVALID_INVOCATION"
  | "INVALID_RESULT";

export class ScheduleDispatchError extends Error {
  constructor(
    readonly code: ScheduleDispatchErrorCode,
    message: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ScheduleDispatchError";
  }
}

export interface ScheduleDispatchOptions {
  signal?: AbortSignal;
}

export interface ScheduleDispatchResult {
  status: "succeeded" | "failed" | "skipped" | "cancelled";
  references: ScheduleRunReferences;
  result?: ScheduleMetadata;
  error?: ScheduleRunError;
}

export interface ScheduleDispatchContext<
  TInvocation extends ScheduleInvocation = ScheduleInvocation,
> {
  schedule: Schedule;
  run: ScheduleRun;
  invocation: TInvocation;
  signal: AbortSignal;
}

export type ScheduleSurfaceHandler<TInvocation extends ScheduleInvocation> = (
  context: ScheduleDispatchContext<TInvocation>,
) => Promise<ScheduleDispatchResult>;

export interface ScheduleSurfaceHandlers {
  agent?: ScheduleSurfaceHandler<ScheduleAgentInvocation>;
  task?: ScheduleSurfaceHandler<ScheduleTaskInvocation>;
  channel?: ScheduleSurfaceHandler<ScheduleChannelInvocation>;
  webhook?: ScheduleSurfaceHandler<ScheduleWebhookInvocation>;
  legacyMission?: ScheduleSurfaceHandler<ScheduleLegacyMissionInvocation>;
}

export interface ScheduleDispatcher {
  dispatch(
    run: ScheduleRun,
    schedule: Schedule,
    options?: ScheduleDispatchOptions,
  ): Promise<ScheduleDispatchResult>;
}

/**
 * Validates and routes schedule invocations to host-provided surface handlers.
 *
 * This class deliberately does not implement agent, task, channel, webhook, or
 * mission behavior. Hosts inject their existing direct-invocation paths.
 */
export class InjectedScheduleDispatcher implements ScheduleDispatcher {
  constructor(private readonly handlers: ScheduleSurfaceHandlers) {
    if (!handlers || typeof handlers !== "object" || Array.isArray(handlers)) {
      throw new ScheduleDispatchError(
        "INVALID_CONTEXT",
        "Schedule dispatcher requires a handler map",
        false,
      );
    }
  }

  async dispatch(
    run: ScheduleRun,
    schedule: Schedule,
    options: ScheduleDispatchOptions = {},
  ): Promise<ScheduleDispatchResult> {
    validateContext(run, schedule);
    const signal = options.signal ?? new AbortController().signal;
    assertNotAborted(signal);

    let invocation: ScheduleInvocation;
    try {
      invocation = normalizeScheduleInvocation(schedule.invocation);
    } catch (cause) {
      throw new ScheduleDispatchError(
        "INVALID_INVOCATION",
        `Schedule "${schedule.id}" has an invalid invocation: ${errorMessage(cause)}`,
        false,
        { cause },
      );
    }

    const context = { schedule, run, invocation, signal };
    let rawResult: ScheduleDispatchResult;
    switch (invocation.surface) {
      case "agent":
        rawResult = await requireHandler(
          this.handlers.agent,
          invocation.surface,
        )({ ...context, invocation });
        break;
      case "task":
        rawResult = await requireHandler(
          this.handlers.task,
          invocation.surface,
        )({ ...context, invocation });
        break;
      case "channel":
        rawResult = await requireHandler(
          this.handlers.channel,
          invocation.surface,
        )({ ...context, invocation });
        break;
      case "webhook":
        rawResult = await requireHandler(
          this.handlers.webhook,
          invocation.surface,
        )({ ...context, invocation });
        break;
      case "legacy_mission":
        rawResult = await requireHandler(
          this.handlers.legacyMission,
          invocation.surface,
        )({ ...context, invocation });
        break;
    }

    assertNotAborted(signal);
    try {
      return normalizeDispatchResult(rawResult, invocation.surface);
    } catch (cause) {
      if (cause instanceof ScheduleDispatchError) throw cause;
      throw new ScheduleDispatchError(
        "INVALID_RESULT",
        `Schedule "${schedule.id}" handler returned an invalid result: ${errorMessage(cause)}`,
        false,
        { cause },
      );
    }
  }
}

function validateContext(run: ScheduleRun, schedule: Schedule): void {
  if (!run || !schedule || run.scheduleId !== schedule.id) {
    throw new ScheduleDispatchError(
      "INVALID_CONTEXT",
      "Schedule run and schedule do not refer to the same schedule",
      false,
    );
  }
  if (run.status !== "running") {
    throw new ScheduleDispatchError(
      "INVALID_CONTEXT",
      `Schedule run "${run.id}" must be running before dispatch`,
      false,
    );
  }
  if (schedule.status !== "active") {
    throw new ScheduleDispatchError(
      "INVALID_CONTEXT",
      `Schedule "${schedule.id}" must be active before dispatch`,
      false,
    );
  }
}

function requireHandler<TInvocation extends ScheduleInvocation>(
  handler: ScheduleSurfaceHandler<TInvocation> | undefined,
  surface: ScheduleInvocation["surface"],
): ScheduleSurfaceHandler<TInvocation> {
  if (typeof handler !== "function") {
    throw new ScheduleDispatchError(
      "HANDLER_UNAVAILABLE",
      `No schedule handler is configured for surface "${surface}"`,
      false,
    );
  }
  return handler;
}

function assertNotAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw new ScheduleDispatchError(
    "ABORTED",
    "Schedule dispatch was aborted",
    true,
    signal.reason === undefined ? undefined : { cause: signal.reason },
  );
}

function normalizeDispatchResult(
  value: unknown,
  surface: ScheduleInvocation["surface"],
): ScheduleDispatchResult {
  const result = record(value, "Schedule dispatch result");
  assertKnownKeys(
    result,
    ["status", "references", "result", "error"],
    "Schedule dispatch result",
  );
  if (
    result.status !== "succeeded"
    && result.status !== "failed"
    && result.status !== "skipped"
    && result.status !== "cancelled"
  ) {
    throw new Error(
      "Schedule dispatch result status must be succeeded, failed, skipped, or cancelled",
    );
  }

  const references = normalizeReferences(result.references);
  if (result.status === "succeeded") {
    assertSuccessfulReferences(surface, references);
    if (result.error !== undefined) {
      throw new Error("A successful schedule dispatch result cannot include an error");
    }
  }
  if (result.status === "failed" && result.error === undefined) {
    throw new Error("A failed schedule dispatch result requires an error");
  }

  return {
    status: result.status,
    references,
    ...(result.result === undefined
      ? {}
      : {
          result: normalizeScheduleMetadata(
            result.result,
            "Schedule dispatch result metadata",
          ),
        }),
    ...(result.error === undefined
      ? {}
      : { error: normalizeDispatchError(result.error) }),
  };
}

function normalizeReferences(value: unknown): ScheduleRunReferences {
  const references = record(value, "Schedule dispatch references");
  const keys = [
    "runtimeId",
    "taskId",
    "loopRunId",
    "sessionId",
    "channelEventId",
    "providerDeliveryId",
  ] as const satisfies readonly (keyof ScheduleRunReferences)[];
  assertKnownKeys(references, keys, "Schedule dispatch references");

  const normalized: ScheduleRunReferences = {};
  for (const key of keys) {
    if (references[key] !== undefined) {
      normalized[key] = nonEmptyString(
        references[key],
        `Schedule dispatch reference ${key}`,
      );
    }
  }
  return normalized;
}

function assertSuccessfulReferences(
  surface: ScheduleInvocation["surface"],
  references: ScheduleRunReferences,
): void {
  const valid = (() => {
    switch (surface) {
      case "agent":
        return Boolean(references.runtimeId || references.loopRunId);
      case "task":
        return Boolean(references.taskId);
      case "channel":
        return Boolean(
          references.channelEventId || references.providerDeliveryId,
        );
      case "webhook":
        return Boolean(references.providerDeliveryId);
      case "legacy_mission":
        return true;
    }
  })();
  if (!valid) {
    throw new Error(
      `A successful "${surface}" dispatch result is missing its durable reference`,
    );
  }
}

function normalizeDispatchError(value: unknown): ScheduleRunError {
  const error = record(value, "Schedule dispatch error");
  assertKnownKeys(
    error,
    ["code", "message", "retryable", "metadata"],
    "Schedule dispatch error",
  );
  if (typeof error.retryable !== "boolean") {
    throw new Error("Schedule dispatch error retryable must be a boolean");
  }
  return {
    code: nonEmptyString(error.code, "Schedule dispatch error code"),
    message: nonEmptyString(error.message, "Schedule dispatch error message"),
    retryable: error.retryable,
    ...(error.metadata === undefined
      ? {}
      : {
          metadata: normalizeScheduleMetadata(
            error.metadata,
            "Schedule dispatch error metadata",
          ),
        }),
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const known = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    throw new Error(`${label} contains unknown field "${unknown[0]}"`);
  }
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
