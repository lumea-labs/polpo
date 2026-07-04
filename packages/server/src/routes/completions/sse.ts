/**
 * SSE chunk formatting, error envelopes, and the non-streaming response
 * shape for the chat completions endpoint.
 */

import {
  LoopApprovalRequiredError,
  LoopPermissionApprovalRequiredError,
  LoopPermissionDeniedError,
  LoopPolicyDeniedError,
} from "@polpo-ai/core";
import type { LanguageModelUsage } from "ai";

export function sseChunk(
  id: string,
  delta: { content?: string; role?: string },
  finishReason: string | null = null,
  extra?: Record<string, unknown>,
): string {
  return JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "polpo",
    choices: [{
      index: 0,
      delta,
      finish_reason: finishReason,
      ...extra,
    }],
  });
}

/**
 * Detect Vercel AI Gateway "model not found" errors so callers see a
 * clean 400 (with the offending model id + agent name) instead of a
 * generic 500 surfaced by Hono's default error handler.
 *
 * Triggers on:
 *   - `GatewayModelNotFoundError` constructor name from `@ai-sdk/gateway`
 *   - any 404 response whose body mentions `model_not_found` (covers
 *     custom gateways that don't ship the typed error class)
 *
 * Returns the error envelope to send back, or null if the error isn't a
 * model-not-found and should propagate untouched.
 */
export function modelNotFoundEnvelope(
  err: unknown,
  fallbackModelId: string | undefined,
  agent: string | undefined,
): { message: string; type: "model_not_found"; param: { modelId: string; agent?: string } } | null {
  if (!err || typeof err !== "object") return null;
  const e = err as any;
  const isGatewayNotFound =
    e.name === "GatewayModelNotFoundError" ||
    e.constructor?.name === "GatewayModelNotFoundError" ||
    (e.statusCode === 404 &&
      typeof e.responseBody === "string" &&
      e.responseBody.includes("model_not_found"));
  if (!isGatewayNotFound) return null;
  const modelId: string = e.modelId ?? fallbackModelId ?? "unknown";
  return {
    message:
      `Model "${modelId}" is not available on the gateway. ` +
      `It may have been renamed or deprecated — update the agent config (or the orchestrator default).`,
    type: "model_not_found",
    param: { modelId, ...(agent ? { agent } : {}) },
  };
}

export function loopRuntimeErrorEnvelope(
  err: unknown,
): { message: string; type: "loop_runtime_error"; code: "loop_policy_blocked" | "loop_permission_blocked" | "loop_approval_required" | "loop_hook_failed"; approvalRequestId?: string; loopRunId?: string } | null {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof LoopApprovalRequiredError || err instanceof LoopPermissionApprovalRequiredError) {
    return {
      message,
      type: "loop_runtime_error",
      code: "loop_approval_required",
      approvalRequestId: (err as any).approvalRequestId,
      loopRunId: (err as any).loopRunId,
    };
  }
  if (err instanceof LoopPermissionDeniedError) {
    return { message, type: "loop_runtime_error", code: "loop_permission_blocked", loopRunId: (err as any).loopRunId };
  }
  if (err instanceof LoopPolicyDeniedError) {
    return { message, type: "loop_runtime_error", code: "loop_policy_blocked", loopRunId: (err as any).loopRunId };
  }
  if (message.startsWith("Loop policy ")) {
    return { message, type: "loop_runtime_error", code: "loop_policy_blocked" };
  }
  if (message.startsWith("Loop hook ")) {
    return { message, type: "loop_runtime_error", code: "loop_hook_failed" };
  }
  return null;
}

export function completionResponse(id: string, content: string, usage: LanguageModelUsage, extra?: Record<string, unknown>) {
  return {
    id,
    object: "chat.completion" as const,
    created: Math.floor(Date.now() / 1000),
    model: "polpo" as const,
    choices: [{
      index: 0,
      message: { role: "assistant" as const, content },
      finish_reason: "stop" as const,
    }],
    usage: {
      prompt_tokens: usage.inputTokens ?? 0,
      completion_tokens: usage.outputTokens ?? 0,
      total_tokens: usage.totalTokens ?? 0,
    },
    ...extra,
  };
}
