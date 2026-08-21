import {
  executeToolBatch,
  normalizeToolExecutionError,
} from "@polpo-ai/core";
import type { CompletionToolExecutor } from "./tool-guardrails.js";

export interface CompletionToolBatchCall {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface CompletionToolBatchResult extends CompletionToolBatchCall {
  result: string;
  isError: boolean;
}

export async function executeCompletionToolBatch(options: {
  calls: readonly CompletionToolBatchCall[];
  executor: CompletionToolExecutor;
  signal?: AbortSignal;
  onCalling?: (call: CompletionToolBatchCall) => void | Promise<void>;
}): Promise<CompletionToolBatchResult[]> {
  return executeToolBatch({
    calls: options.calls.map((call) => ({ ...call, name: call.toolName })),
    parallel: true,
    signal: options.signal,
    execute: async (call) => {
      await options.onCalling?.(call);
      const result = await options.executor(call.toolName, call.input, {
        callId: call.toolCallId,
        signal: options.signal,
      });
      return { ...call, result, isError: result.startsWith("Error:") };
    },
    onError: (error, call) => {
      const result = normalizeToolExecutionError(error);
      return { ...call, result, isError: true };
    },
  });
}
