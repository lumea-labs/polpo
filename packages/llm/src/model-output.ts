import {
  JSONParseError,
  NoOutputGeneratedError,
  Output,
  TypeValidationError,
} from "ai";
import { toValidatedToolInputSchema } from "./tool-schema.js";

function outputName(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 64);
  return normalized || "loop_step_output";
}

/** Provider-neutral structured output contract backed by local JSON Schema validation. */
export function modelOutputForJsonSchema(
  schema: unknown,
  name = "loop_step_output",
): Output.Output<unknown, unknown, never> {
  return Output.object({
    schema: toValidatedToolInputSchema(schema),
    name: outputName(name),
  });
}

/** True only for parsing/schema failures produced while resolving an AI SDK Output. */
export function isStructuredModelOutputError(error: unknown): boolean {
  let current = error;
  const visited = new Set<unknown>();
  for (let depth = 0; depth < 8 && current && !visited.has(current); depth++) {
    visited.add(current);
    if (
      NoOutputGeneratedError.isInstance(current)
      || TypeValidationError.isInstance(current)
      || JSONParseError.isInstance(current)
    ) {
      return true;
    }
    current = typeof current === "object" && "cause" in current
      ? (current as { cause?: unknown }).cause
      : undefined;
  }
  return false;
}
