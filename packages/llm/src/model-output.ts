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

/**
 * Per-turn gate for streaming a structured answer's raw JSON text.
 *
 * Holds back leading whitespace and decides on the first meaningful character:
 * a turn whose text opens with `{` or `[` is streamed delta by delta, anything
 * else (prose before a tool call, fenced output) is never streamed and is left
 * to the final validated serialization.
 */
export class StructuredOutputDeltaGate {
  private pending = "";
  private state: "undecided" | "json" | "other" = "undecided";

  /** Returns the text to forward for this delta, if any. */
  push(text: string): string | undefined {
    if (this.state === "json") return text;
    if (this.state === "other") return undefined;
    this.pending += text;
    const trimmed = this.pending.trimStart();
    if (!trimmed) return undefined;
    this.pending = "";
    this.state = trimmed[0] === "{" || trimmed[0] === "[" ? "json" : "other";
    return this.state === "json" ? trimmed : undefined;
  }

  /** True once any text of this turn has been forwarded. */
  get streamed(): boolean {
    return this.state === "json";
  }
}
