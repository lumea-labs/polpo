import {
  InMemoryToolExecutionReceiptStore,
  normalizeToolOutputText,
  admitCanonicalToolContract,
  inferToolSideEffect,
  settleToolExecutionReceiptWithRetry,
  toolArgumentsFingerprint,
  ToolProgressTracker,
  type ToolExecutionReceiptStore,
  type ToolProgressDecision,
  type RunToolMiddleware,
  type RuntimeGuardrailContext,
} from "@polpo-ai/core";
import { validateToolInput } from "@polpo-ai/llm";

export interface CompletionToolExecutionOptions {
  readonly callId?: string;
  readonly signal?: AbortSignal;
}

export type CompletionToolExecutor = (
  name: string,
  args: Record<string, unknown>,
  options?: CompletionToolExecutionOptions,
) => Promise<string>;

export interface CompletionToolProgressStall {
  readonly code: "tool_loop_stalled";
  readonly toolName: string;
  readonly fingerprint: string;
  readonly observation: number;
  readonly message: string;
}

/** Mutable request/run-local signal shared with the owning surface controller. */
export interface CompletionToolProgressState {
  stalled?: CompletionToolProgressStall;
}

function toolContractMap(tools: readonly any[]) {
  return new Map(
    tools
      .filter((tool) => tool && typeof tool.name === "string")
      .map((tool) => [tool.name, admitCanonicalToolContract(tool)]),
  );
}

function invalidToolArguments(error: Error): string {
  return `Error: Invalid tool arguments: ${error.message}`;
}

/**
 * Adapts the shared host-neutral middleware to the completion route's legacy
 * executor contract. Canonical schema validation is unconditional and runs
 * again after a middleware rewrite, immediately before the real executor.
 */
export function createGuardedCompletionToolExecutor(options: {
  readonly executor: CompletionToolExecutor;
  readonly tools: readonly any[];
  readonly middleware?: RunToolMiddleware;
  readonly context: RuntimeGuardrailContext;
  /** Durable hosts may inject a store shared across resume/retry boundaries. */
  readonly receiptStore?: ToolExecutionReceiptStore;
  readonly onProgress?: (input: {
    name: string;
    args: Readonly<Record<string, unknown>>;
    decision: ToolProgressDecision;
  }) => void;
}): CompletionToolExecutor {
  const contracts = toolContractMap(options.tools);
  const annotations = new Map(
    [...contracts].map(([name, contract]) => [name, contract.annotations]),
  );
  const progressTracker = new ToolProgressTracker();
  const receiptStore = options.receiptStore ?? new InMemoryToolExecutionReceiptStore();

  return async (name, args, execution) => {
    if (!contracts.has(name)) {
      return `Error: Tool ${JSON.stringify(name)} is not available for execution.`;
    }
    const schema = contracts.get(name)!.inputSchema;
    const initialValidation = await validateToolInput(schema, args);
    if (!initialValidation.success) {
      return invalidToolArguments(initialValidation.error);
    }

    const executeValidated = async (
      request: {
        name: string;
        args: unknown;
        callId?: string;
        signal?: AbortSignal;
      },
    ): Promise<string> => {
      if (!contracts.has(request.name)) {
        return `Error: Tool ${JSON.stringify(request.name)} is not available for execution.`;
      }
      const rewrittenValidation = await validateToolInput(
        contracts.get(request.name)!.inputSchema,
        request.args,
      );
      if (!rewrittenValidation.success) {
        return invalidToolArguments(rewrittenValidation.error);
      }
      const validatedArgs = rewrittenValidation.value as Record<string, unknown>;
      const progressCall = {
        name: request.name,
        args: validatedArgs,
        annotations: annotations.get(request.name),
      };
      const decision = progressTracker.inspect(progressCall);
      options.onProgress?.({ name: request.name, args: validatedArgs, decision });
      if (decision.action === "reuse") return decision.result;
      if (decision.action === "stall") return `Error: ${decision.message}`;

      if (request.callId) {
        const claim = await receiptStore.claim({
          callId: request.callId,
          toolName: request.name,
          contractFingerprint: contracts.get(request.name)!.definitionFingerprint,
          argumentsFingerprint: toolArgumentsFingerprint(request.name, validatedArgs),
        });
        if (claim.action === "replay") return claim.result;
        if (claim.action === "reject") {
          return `Error [${claim.code}]: ${claim.message}`;
        }
      }

      let result: string;
      try {
        result = normalizeToolOutputText(await options.executor(
          request.name,
          validatedArgs,
          {
            callId: request.callId,
            signal: request.signal,
          },
        ));
      } catch (error) {
        if (request.callId) {
          try {
            await settleToolExecutionReceiptWithRetry(
              receiptStore,
              {
                callId: request.callId,
                state: "outcome-unknown",
              },
              { signal: request.signal },
            );
          } catch {
            // The executor failure is authoritative. A receipt write failure
            // must not replace it with a secondary persistence error.
          }
        }
        throw error;
      }
      if (request.callId) {
        await settleToolExecutionReceiptWithRetry(
          receiptStore,
          {
            callId: request.callId,
            state: result.startsWith("Error:") ? "failed" : "completed",
            result,
          },
          { signal: request.signal },
        );
      }
      progressTracker.record({
        ...progressCall,
        result,
        isError: result.startsWith("Error:"),
      });
      return result;
    };

    if (!options.middleware) {
      return executeValidated({
        name,
        args: initialValidation.value as Record<string, unknown>,
        callId: execution?.callId,
        signal: execution?.signal,
      });
    }

    const result = await options.middleware!.execute(
      {
        name,
        args: initialValidation.value as Record<string, unknown>,
        callId: execution?.callId,
        signal: execution?.signal,
        schema,
        sideEffect: inferToolSideEffect(name),
        context: options.context,
      },
      executeValidated,
    );
    return result.output;
  };
}
