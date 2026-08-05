/**
 * SSE chunk formatting, error envelopes, and the non-streaming response
 * shape for the chat completions endpoint.
 */

import {
  GuardrailApprovalRequiredError,
  GuardrailBlockedError,
  LoopApprovalRequiredError,
  LoopPermissionApprovalRequiredError,
  LoopPermissionDeniedError,
  LoopPolicyDeniedError,
  LoopContextBindingError,
} from "@polpo-ai/core";
import { classifyGatewayError, extractGatewayModelNotFoundDetails } from "@polpo-ai/llm";
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

function errorObjects(err: unknown): Record<string, any>[] {
  const queue: unknown[] = [err];
  const seen = new Set<unknown>();
  const objects: Record<string, any>[] = [];

  while (queue.length > 0 && objects.length < 16) {
    const current = queue.shift();
    if (!current || (typeof current !== "object" && typeof current !== "function") || seen.has(current)) continue;
    seen.add(current);
    const record = current as Record<string, any>;
    objects.push(record);
    for (const key of ["error", "cause", "data", "param", "sourceError"]) {
      if (record[key] !== undefined) queue.push(record[key]);
    }
  }

  return objects;
}

function responseBodyMessage(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value) as any;
    const message = parsed?.error?.message ?? parsed?.message;
    return typeof message === "string" && message.trim() ? message.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Extract a stable, user-visible provider error without exposing request internals. */
export function visibleModelError(err: unknown): string {
  for (const candidate of errorObjects(err)) {
    for (const value of [candidate.message, candidate.error_description]) {
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    const fromBody = responseBodyMessage(candidate.responseBody);
    if (fromBody) return fromBody;
  }
  return "The model provider rejected the request before generating a response.";
}

export function modelErrorEnvelope(err: unknown): {
  message: string;
  type: "model_error";
  code: "model_request_failed";
} {
  return {
    message: visibleModelError(err),
    type: "model_error",
    code: "model_request_failed",
  };
}

export function modelNotFoundEnvelope(
  err: unknown,
  fallbackModelId: string | undefined,
  agent: string | undefined,
): { message: string; type: "model_not_found"; param: { modelId: string; agent?: string } } | null {
  const normalized = classifyGatewayError(err);
  if (normalized.class !== "model-not-found") return null;
  const details = extractGatewayModelNotFoundDetails(err);
  const modelId = details?.modelId ?? fallbackModelId ?? "unknown";
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
): { message: string; type: "loop_runtime_error"; code: "loop_policy_blocked" | "loop_permission_blocked" | "loop_approval_required" | "loop_hook_failed" | "loop_binding_invalid" | "loop_binding_missing" | "loop_context_readonly" | "loop_tool_input_invalid"; approvalRequestId?: string; loopRunId?: string } | null {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof LoopContextBindingError) {
    return {
      message,
      type: "loop_runtime_error",
      code: err.code,
      loopRunId: (err as any).loopRunId,
    };
  }
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

export function guardrailErrorEnvelope(
  err: unknown,
): {
  message: string;
  type: "guardrail_error";
  code: "guardrail_blocked" | "guardrail_approval_required";
} | null {
  if (err instanceof GuardrailApprovalRequiredError) {
    return {
      message: err.message,
      type: "guardrail_error",
      code: "guardrail_approval_required",
    };
  }
  if (err instanceof GuardrailBlockedError) {
    return {
      message: err.message,
      type: "guardrail_error",
      code: "guardrail_blocked",
    };
  }
  if (err && typeof err === "object") {
    const raw = err as Record<string, unknown>;
    const nested = raw.error && typeof raw.error === "object"
      ? raw.error as Record<string, unknown>
      : undefined;
    const code = raw.code ?? nested?.code;
    const message = raw.message ?? nested?.message;
    if (
      (code === "guardrail_blocked" || code === "guardrail_approval_required") &&
      typeof message === "string"
    ) {
      return {
        message,
        type: "guardrail_error",
        code,
      };
    }
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
