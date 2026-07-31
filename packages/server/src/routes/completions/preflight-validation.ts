import {
  GuardrailBlockedError,
  type RuntimeContextResolution,
  type RuntimeGuardrailDecision,
} from "@polpo-ai/core";

function invalidRewrite(
  target: string,
  decisions: readonly RuntimeGuardrailDecision[],
): never {
  throw new GuardrailBlockedError(
    `Guardrail rewrote ${target} to an invalid value`,
    decisions,
  );
}

export function assertCompletionMessageContent(
  value: unknown,
  decisions: readonly RuntimeGuardrailDecision[],
): asserts value is string | readonly unknown[] {
  if (typeof value === "string") return;
  if (!Array.isArray(value)) invalidRewrite("message content", decisions);
  for (const part of value) {
    if (!part || typeof part !== "object" || Array.isArray(part)) {
      invalidRewrite("message content", decisions);
    }
    const record = part as Record<string, unknown>;
    if (
      (record.type === "text" && typeof record.text === "string")
      || (
        record.type === "image_url"
        && record.image_url !== null
        && typeof record.image_url === "object"
        && typeof (record.image_url as Record<string, unknown>).url === "string"
      )
      || (record.type === "file" && typeof record.file_id === "string")
    ) {
      continue;
    }
    invalidRewrite("message content", decisions);
  }
}

export function assertRuntimeContextResolution(
  value: unknown,
  decisions: readonly RuntimeGuardrailDecision[],
): asserts value is RuntimeContextResolution {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || !Array.isArray((value as Record<string, unknown>).segments)
    || !(value as Record<string, unknown>).audit
    || typeof (value as Record<string, unknown>).audit !== "object"
    || Array.isArray((value as Record<string, unknown>).audit)
  ) {
    invalidRewrite("runtime context", decisions);
  }
}

export function assertModelPreflightValue(
  value: unknown,
  decisions: readonly RuntimeGuardrailDecision[],
): asserts value is {
  systemPrompt: string;
  messages: any[];
  runtimeContext?: RuntimeContextResolution;
} {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || typeof (value as Record<string, unknown>).systemPrompt !== "string"
    || !Array.isArray((value as Record<string, unknown>).messages)
  ) {
    invalidRewrite("model input", decisions);
  }
  const runtimeContext = (value as Record<string, unknown>).runtimeContext;
  if (runtimeContext !== undefined) {
    assertRuntimeContextResolution(runtimeContext, decisions);
  }
}
