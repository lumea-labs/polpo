import type {
  RuntimeHookDecision,
  RuntimeHookDispatcher,
  RuntimeHookEventName,
  RuntimeHookIdentity,
  RuntimeHookJson,
  RuntimeHookSurface,
} from "@polpo-ai/core/runtime-hooks";
import { runtimeHookFileChangeForTool } from "@polpo-ai/core/runtime-hooks";
import { normalizeToolOutputText } from "@polpo-ai/core";
import type { ModelPolicyEvent } from "@polpo-ai/llm";
import type { CompletionToolExecutor } from "./tool-guardrails.js";

export interface CompletionRuntimeHookContext {
  dispatcher?: RuntimeHookDispatcher;
  surface: RuntimeHookSurface;
  identity: RuntimeHookIdentity;
  signal?: AbortSignal;
}

export async function dispatchCompletionRuntimeHook(
  context: CompletionRuntimeHookContext | undefined,
  event: RuntimeHookEventName,
  data: Record<string, unknown> = {},
): Promise<RuntimeHookDecision> {
  if (!context?.dispatcher) return { action: "allow" };
  const result = await context.dispatcher.dispatch({
    event,
    surface: context.surface,
    identity: context.identity,
    signal: context.signal,
    data,
  });
  return result.decision;
}

export function createRuntimeHookedToolExecutor(options: {
  executor: CompletionToolExecutor;
  hooks?: CompletionRuntimeHookContext;
}): CompletionToolExecutor {
  if (!options.hooks?.dispatcher) return options.executor;
  return async (name, originalArgs, execution) => {
    const identity = {
      ...options.hooks!.identity,
      ...(execution?.callId ? { toolCallId: execution.callId } : {}),
    };
    const hookContext = { ...options.hooks!, identity };
    const before = await dispatchCompletionRuntimeHook(hookContext, "tool:before", {
      tool: name,
      input: originalArgs,
    });
    const blocked = blockedToolResult(before);
    if (blocked) return blocked;
    const args = modifiedObject(before, "input") ?? originalArgs;
    try {
      const result = await options.executor(name, args, execution);
      const event = result.startsWith("Error:") ? "tool:error" : "tool:after";
      const after = await dispatchCompletionRuntimeHook(hookContext, event, {
        tool: name,
        input: args,
        result,
      });
      const afterBlocked = blockedToolResult(after);
      if (afterBlocked) return afterBlocked;
      const modifiedResult = modifiedString(after, "result");
      const visibleResult = modifiedResult === undefined ? result : normalizeToolOutputText(modifiedResult);
      const fileChange = runtimeHookFileChangeForTool(name, args, visibleResult);
      if (fileChange) {
        await dispatchCompletionRuntimeHook(hookContext, "sandbox:file_changed", fileChange);
      }
      return visibleResult;
    } catch (error) {
      await dispatchCompletionRuntimeHook(hookContext, "tool:error", {
        tool: name,
        input: args,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
}

/** Maps provider fallback selection onto the public Runtime Hooks lifecycle. */
export async function dispatchCompletionModelPolicyHook(
  context: CompletionRuntimeHookContext | undefined,
  event: ModelPolicyEvent,
): Promise<void> {
  if (event.type !== "model-fallback-selected") return;
  const { raw: _raw, ...reason } = event.reason;
  const data = {
    from: event.from.model,
    to: event.to.model,
    fromIndex: event.from.index,
    toIndex: event.to.index,
    reason,
  };
  const before = await dispatchCompletionRuntimeHook(context, "model:switch:before", data);
  const beforeError = runtimeHookDecisionError(before);
  if (beforeError) throw beforeError;
  const after = await dispatchCompletionRuntimeHook(context, "model:switch:after", data);
  const afterError = runtimeHookDecisionError(after);
  if (afterError) throw afterError;
}

export function runtimeHookDecisionError(decision: RuntimeHookDecision): Error | undefined {
  if (decision.action === "allow" || decision.action === "modify") return undefined;
  const message = decision.action === "deny"
    ? decision.reason
    : decision.action === "ask" || decision.action === "defer"
      ? decision.reason
      : "reason" in decision ? decision.reason ?? "Runtime hook stopped execution" : "Continuation requires an active termination gate";
  return new Error(`Runtime hook ${decision.action}: ${message}`);
}

export function runtimeHookStopFeedback(decision: RuntimeHookDecision): string | undefined {
  if (decision.action !== "stop") return undefined;
  const feedback = decision.feedback?.trim();
  return feedback ? feedback : undefined;
}

export function runtimeHookModifiedString(decision: RuntimeHookDecision, key: string): string | undefined {
  return modifiedString(decision, key);
}

export async function runCompletionRuntimeHookOperation<T>(options: {
  hooks?: CompletionRuntimeHookContext;
  before: RuntimeHookEventName;
  after: RuntimeHookEventName;
  error: RuntimeHookEventName;
  data?: Record<string, unknown>;
  operation: () => Promise<T>;
  resultData?: (result: T) => Record<string, unknown>;
}): Promise<T> {
  const before = await dispatchCompletionRuntimeHook(options.hooks, options.before, options.data);
  const blocked = runtimeHookDecisionError(before);
  if (blocked) throw blocked;
  try {
    const result = await options.operation();
    const after = await dispatchCompletionRuntimeHook(options.hooks, options.after, {
      ...options.data,
      ...(options.resultData?.(result) ?? {}),
    });
    const afterBlocked = runtimeHookDecisionError(after);
    if (afterBlocked) throw afterBlocked;
    return result;
  } catch (error) {
    await dispatchCompletionRuntimeHook(options.hooks, options.error, {
      ...options.data,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function blockedToolResult(decision: RuntimeHookDecision): string | undefined {
  const error = runtimeHookDecisionError(decision);
  return error ? `Error: ${error.message}` : undefined;
}

function modifiedObject(
  decision: RuntimeHookDecision,
  key: string,
): Record<string, unknown> | undefined {
  if (decision.action !== "modify") return undefined;
  const value = decision.data[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function modifiedString(decision: RuntimeHookDecision, key: string): string | undefined {
  if (decision.action !== "modify") return undefined;
  const value: RuntimeHookJson | undefined = decision.data[key];
  return typeof value === "string" ? value : undefined;
}
