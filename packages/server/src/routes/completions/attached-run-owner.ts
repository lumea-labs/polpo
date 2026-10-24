import { RunEventJournal } from "@polpo-ai/core/run-delivery-follower";
import {
  executeOwnedRun,
  type OwnedRunExecutionResult,
} from "@polpo-ai/core/run-delivery-owner";
import type { CompletionRouteDeps } from "../completions.js";

/**
 * Raised when an attached Loop execution was refused admission because its
 * run id was already admitted (live owner, terminal history, or an earlier
 * attempt that started and was then interrupted). The producer never ran.
 */
export class AttachedRunAdmissionError extends Error {
  readonly code = "run_admission_refused";
  constructor(
    readonly runId: string,
    readonly result: OwnedRunExecutionResult,
  ) {
    super(`Run "${runId}" was already admitted and is never executed twice`);
    this.name = "AttachedRunAdmissionError";
  }

  get envelope() {
    return {
      message: this.message,
      type: "invalid_request_error",
      code: this.code,
    };
  }
}

/**
 * Execute a request-bound (attached) Project Loop run under the same owner
 * fence as durable runs: a renewable lease on `runId`, `run.started` before
 * any Loop side effect, and one terminal lifecycle event. If the process dies
 * at any point the lease expires and run-delivery reconciliation converges
 * the journal (and, through host projection, the Loop record) to a retryable
 * interrupted failure instead of leaving it `running` forever.
 *
 * Hosts without durable run-delivery stores or a Loop run store keep the
 * previous unfenced behavior: there is no record that could be orphaned.
 *
 * `execute` receives the owner signal (request disconnect, lost lease or
 * explicit cancellation) and the delivery run id the Loop record must carry
 * when it is fenced.
 */
export async function runAttachedLoopExecution<T>(input: {
  deps: CompletionRouteDeps;
  runId: string;
  sessionId?: string | null;
  agent?: string;
  signal?: AbortSignal;
  execute: (
    signal: AbortSignal | undefined,
    deliveryRunId: string | undefined,
  ) => Promise<T>;
}): Promise<T> {
  const { deps } = input;
  if (!deps.createRunDeliveryScope || !deps.getLoopRunStore?.()) {
    return input.execute(input.signal, undefined);
  }
  const scope = await deps.createRunDeliveryScope({
    runId: input.runId,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.agent ? { agent: input.agent } : {}),
    onDisconnect: "cancel",
  });
  let admitted = false;
  let value: T | undefined;
  let failed = false;
  let failure: unknown;
  const execution = executeOwnedRun({
    runId: input.runId,
    owner: scope.owner,
    token: scope.token,
    journal: new RunEventJournal(scope.eventStore, scope.notifier),
    leaseStore: scope.leaseStore,
    cancellationStore: scope.cancellationStore,
    producer: async ({ signal }) => {
      admitted = true;
      const combined = input.signal ? AbortSignal.any([input.signal, signal]) : signal;
      try {
        value = await input.execute(combined, input.runId);
      } catch (error) {
        failed = true;
        failure = error;
        throw error;
      }
    },
  });
  scope.trackExecution?.(input.runId, execution);
  let result: OwnedRunExecutionResult;
  try {
    result = await execution;
  } catch (error) {
    if (!admitted) throw error;
    // The producer already finished and its response is ready. A lifecycle
    // store failure after that point must not replace it; the unrenewed lease
    // expires and reconciliation finalizes the journal.
    result = { status: "failed", error: "Run lifecycle finalization failed" };
  }
  if (failed) throw failure;
  if (!admitted) throw new AttachedRunAdmissionError(input.runId, result);
  return value as T;
}
