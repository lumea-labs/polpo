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

export async function executeCompletionToolCall(options: {
  call: CompletionToolBatchCall;
  executor: CompletionToolExecutor;
  signal?: AbortSignal;
  onCalling?: (call: CompletionToolBatchCall) => void | Promise<void>;
}): Promise<CompletionToolBatchResult> {
  const [result] = await executeCompletionToolBatch({
    calls: [options.call],
    executor: options.executor,
    signal: options.signal,
    onCalling: options.onCalling,
  });
  return result!;
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
      return {
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        input: call.input,
        result,
        isError: result.startsWith("Error:"),
      };
    },
    onError: (error, call) => {
      const result = normalizeToolExecutionError(error);
      return {
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        input: call.input,
        result,
        isError: true,
      };
    },
  });
}
