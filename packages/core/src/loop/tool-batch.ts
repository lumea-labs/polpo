import { inferToolSideEffect } from "../guardrails/tool-middleware.js";
import { ToolReceiptSettlementError } from "../tool-execution-receipts.js";
import { normalizeToolOutputText } from "../tool-result.js";
import type { RuntimeToolSideEffect } from "../guardrails/types.js";

export const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 4;

export interface ToolBatchCall {
  name: string;
}

export interface ExecuteToolBatchOptions<TCall extends ToolBatchCall, TResult> {
  calls: readonly TCall[];
  execute: (call: TCall, index: number) => TResult | Promise<TResult>;
  onError: (
    error: unknown,
    call: TCall,
    index: number,
  ) => TResult | Promise<TResult>;
  parallel?: boolean;
  maxConcurrency?: number;
  signal?: AbortSignal;
  sideEffect?: (call: TCall) => RuntimeToolSideEffect;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Tool batch aborted");
}

async function executeOne<TCall extends ToolBatchCall, TResult>(
  options: ExecuteToolBatchOptions<TCall, TResult>,
  call: TCall,
  index: number,
): Promise<TResult> {
  if (options.signal?.aborted) {
    return options.onError(abortReason(options.signal), call, index);
  }
  try {
    return await options.execute(call, index);
  } catch (error) {
    // The side effect may have happened. Let the run owner record its safe,
    // typed failure; asking the model to retry could execute the effect twice.
    if (error instanceof ToolReceiptSettlementError) throw error;
    return options.onError(error, call, index);
  }
}

/**
 * Execute one model turn's local tool calls without exposing provider SDK
 * types. Parallel work is deliberately conservative: the caller must opt in
 * and every call must be classified read-only. Returned values always retain
 * the model's original call order.
 */
export async function executeToolBatch<TCall extends ToolBatchCall, TResult>(
  options: ExecuteToolBatchOptions<TCall, TResult>,
): Promise<TResult[]> {
  const maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_PARALLEL_TOOL_CALLS;
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new TypeError("maxConcurrency must be a positive safe integer");
  }
  if (options.calls.length === 0) return [];

  const sideEffect = options.sideEffect ?? ((call: TCall) => inferToolSideEffect(call.name));
  const canRunConcurrently = options.parallel === true
    && options.calls.length > 1
    && options.calls.every((call) => sideEffect(call) === "read");

  if (!canRunConcurrently) {
    const results: TResult[] = [];
    for (const [index, call] of options.calls.entries()) {
      results.push(await executeOne(options, call, index));
    }
    return results;
  }

  const results = new Array<TResult>(options.calls.length);
  let cursor = 0;
  let failed = false;
  const workerCount = Math.min(maxConcurrency, options.calls.length);
  const worker = async (): Promise<void> => {
    while (!failed && cursor < options.calls.length) {
      const index = cursor;
      cursor += 1;
      const call = options.calls[index]!;
      try {
        results[index] = await executeOne(options, call, index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };

  // Drain work already in flight before the owner releases sandbox/leases.
  const workers = await Promise.allSettled(Array.from({ length: workerCount }, () => worker()));
  const rejected = workers.find(worker => worker.status === "rejected");
  if (rejected?.status === "rejected") throw rejected.reason;
  return results;
}

export function normalizeToolExecutionError(error: unknown): string {
  const message = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "Tool execution failed";
  return normalizeToolOutputText(message.startsWith("Error:") ? message : `Error: ${message}`);
}
