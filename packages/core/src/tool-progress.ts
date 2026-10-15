import type { PolpoToolAnnotations } from "./tool-types.js";

export const DEFAULT_TOOL_MAX_IDENTICAL_OBSERVATIONS = 4;

export interface ToolProgressCall {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly annotations?: PolpoToolAnnotations;
}

export interface ToolProgressRecord extends ToolProgressCall {
  readonly result: string;
  readonly isError: boolean;
}

export type ToolProgressDecision =
  | { readonly action: "execute" }
  | {
      readonly action: "reuse";
      readonly result: string;
      readonly isError: boolean;
      readonly fingerprint: string;
      readonly observation: number;
    }
  | {
      readonly action: "stall";
      readonly code: "tool_loop_stalled";
      readonly fingerprint: string;
      readonly observation: number;
      readonly message: string;
    };

export class ToolProgressStallError extends Error {
  readonly code = "tool_loop_stalled" as const;

  constructor(
    readonly toolName: string,
    readonly fingerprint: string,
    readonly observation: number,
  ) {
    super(
      `Tool ${JSON.stringify(toolName)} repeated the same stable read ${observation} times without progress`,
    );
    this.name = "ToolProgressStallError";
  }
}

interface StableResult {
  readonly result: string;
  readonly isError: boolean;
  observations: number;
}

function canonicalJson(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Tool arguments must contain finite numbers");
    return Object.is(value, -0) ? "-0" : String(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("Tool arguments must not be cyclic");
    seen.add(value);
    try {
      return `[${value.map((item) => canonicalJson(item, seen)).join(",")}]`;
    } finally {
      seen.delete(value);
    }
  }
  if (!value || typeof value !== "object") {
    throw new TypeError(`Tool arguments contain unsupported ${typeof value}`);
  }
  if (seen.has(value)) throw new TypeError("Tool arguments must not be cyclic");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Tool arguments must contain only plain objects");
  }
  seen.add(value);
  try {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, "en-US"));
    return `{${entries.map(([key, nested]) =>
      `${JSON.stringify(key)}:${canonicalJson(nested, seen)}`).join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

function reusable(annotations: PolpoToolAnnotations | undefined): boolean {
  return annotations?.readOnlyHint === true
    && annotations.idempotentHint === true
    && annotations.resultStability === "stable";
}

export function toolProgressFingerprint(call: ToolProgressCall): string | undefined {
  if (!reusable(call.annotations)) return undefined;
  try {
    return `${call.name}:${canonicalJson(call.args)}`;
  } catch {
    return undefined;
  }
}

/**
 * Run-local detector for repeated stable reads. It never caches a write,
 * volatile read, or unannotated tool.
 */
export class ToolProgressTracker {
  readonly maxIdenticalObservations: number;
  readonly #stableResults = new Map<string, StableResult>();

  constructor(options: { maxIdenticalObservations?: number } = {}) {
    const limit = options.maxIdenticalObservations
      ?? DEFAULT_TOOL_MAX_IDENTICAL_OBSERVATIONS;
    if (!Number.isSafeInteger(limit) || limit < 2) {
      throw new TypeError("maxIdenticalObservations must be a safe integer of at least 2");
    }
    this.maxIdenticalObservations = limit;
  }

  inspect(call: ToolProgressCall): ToolProgressDecision {
    const fingerprint = toolProgressFingerprint(call);
    if (!fingerprint) return { action: "execute" };
    const previous = this.#stableResults.get(fingerprint);
    if (!previous) return { action: "execute" };

    previous.observations += 1;
    if (previous.observations >= this.maxIdenticalObservations) {
      const error = new ToolProgressStallError(
        call.name,
        fingerprint,
        previous.observations,
      );
      return {
        action: "stall",
        code: error.code,
        fingerprint,
        observation: previous.observations,
        message: error.message,
      };
    }
    return {
      action: "reuse",
      result: previous.result,
      isError: previous.isError,
      fingerprint,
      observation: previous.observations,
    };
  }

  record(record: ToolProgressRecord): void {
    const fingerprint = toolProgressFingerprint(record);
    if (!fingerprint || this.#stableResults.has(fingerprint)) return;
    this.#stableResults.set(fingerprint, {
      result: record.result,
      isError: record.isError,
      observations: 1,
    });
  }
}
