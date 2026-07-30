import {
  inferToolSideEffect,
  type RunToolMiddleware,
  type RuntimeGuardrailContext,
} from "@polpo-ai/core";

export interface CompletionToolExecutionOptions {
  readonly callId?: string;
  readonly signal?: AbortSignal;
}

export type CompletionToolExecutor = (
  name: string,
  args: Record<string, unknown>,
  options?: CompletionToolExecutionOptions,
) => Promise<string>;

function toolSchemaMap(tools: readonly any[]): ReadonlyMap<string, unknown> {
  return new Map(
    tools
      .filter((tool) => tool && typeof tool.name === "string")
      .map((tool) => [tool.name, tool.parameters ?? tool.inputSchema]),
  );
}

/**
 * Adapts the shared host-neutral middleware to the completion route's legacy
 * executor contract. An absent middleware returns the original function by
 * reference, preserving the disabled path exactly.
 */
export function createGuardedCompletionToolExecutor(options: {
  readonly executor: CompletionToolExecutor;
  readonly tools: readonly any[];
  readonly middleware?: RunToolMiddleware;
  readonly context: RuntimeGuardrailContext;
}): CompletionToolExecutor {
  if (!options.middleware) return options.executor;
  const schemas = toolSchemaMap(options.tools);

  return async (name, args, execution) => {
    const result = await options.middleware!.execute(
      {
        name,
        args,
        callId: execution?.callId,
        signal: execution?.signal,
        schema: schemas.get(name),
        sideEffect: inferToolSideEffect(name),
        context: options.context,
      },
      (request) => options.executor(
        request.name,
        request.args as Record<string, unknown>,
        {
          callId: request.callId,
          signal: request.signal,
        },
      ),
    );
    return result.output;
  };
}
