import { BrainContractError, type BrainContractErrorCode } from "./errors.js";
import type {
  BrainFailure,
  BrainMetadata,
  BrainMetadataValue,
} from "./types.js";

const MAX_METADATA_DEPTH = 16;
const MAX_METADATA_NODES = 10_000;
const MAX_METADATA_KEY_CHARACTERS = 256;
const MAX_METADATA_STRING_CHARACTERS = 64_000;
const FORBIDDEN_METADATA_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function requiredText(
  value: unknown,
  path: string,
  max: number,
  code: BrainContractErrorCode,
): string {
  if (typeof value !== "string") {
    throw new BrainContractError(
      `${path} must be a non-empty string`,
      code,
      path,
    );
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > max) {
    throw new BrainContractError(
      `${path} must contain between 1 and ${max} characters`,
      code,
      path,
    );
  }
  return normalized;
}

export function optionalText(
  value: unknown,
  path: string,
  max: number,
  code: BrainContractErrorCode,
): string | undefined {
  if (value === undefined) return undefined;
  return requiredText(value, path, max, code);
}

export function isoTimestamp(
  value: unknown,
  path: string,
  code: BrainContractErrorCode,
): string {
  if (!(typeof value === "string" || value instanceof Date)) {
    throw new BrainContractError(`${path} must be a valid timestamp`, code, path);
  }
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new BrainContractError(`${path} must be a valid timestamp`, code, path);
  }
  return date.toISOString();
}

export function optionalTimestamp(
  value: unknown,
  path: string,
  code: BrainContractErrorCode,
): string | undefined {
  return value === undefined ? undefined : isoTimestamp(value, path, code);
}

export function nonNegativeInteger(
  value: unknown,
  path: string,
  code: BrainContractErrorCode,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 0
    || value > max
  ) {
    throw new BrainContractError(
      `${path} must be a non-negative integer no greater than ${max}`,
      code,
      path,
    );
  }
  return value;
}

export function positiveInteger(
  value: unknown,
  path: string,
  code: BrainContractErrorCode,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const normalized = nonNegativeInteger(value, path, code, max);
  if (normalized === 0) {
    throw new BrainContractError(`${path} must be greater than zero`, code, path);
  }
  return normalized;
}

export function finiteNumber(
  value: unknown,
  path: string,
  code: BrainContractErrorCode,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new BrainContractError(`${path} must be a finite number`, code, path);
  }
  return value;
}

function cloneMetadataValue(
  value: unknown,
  path: string,
  depth: number,
  state: { nodes: number; seen: WeakSet<object> },
): BrainMetadataValue {
  state.nodes += 1;
  if (state.nodes > MAX_METADATA_NODES) {
    throw new BrainContractError(
      `Brain metadata exceeds ${MAX_METADATA_NODES} values`,
      "invalid_metadata",
      path,
    );
  }
  if (depth > MAX_METADATA_DEPTH) {
    throw new BrainContractError(
      `Brain metadata exceeds ${MAX_METADATA_DEPTH} levels`,
      "invalid_metadata",
      path,
    );
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new BrainContractError(
        `${path} must contain finite JSON numbers`,
        "invalid_metadata",
        path,
      );
    }
    return value;
  }
  if (typeof value === "string") {
    if (value.length > MAX_METADATA_STRING_CHARACTERS) {
      throw new BrainContractError(
        `${path} exceeds ${MAX_METADATA_STRING_CHARACTERS} characters`,
        "invalid_metadata",
        path,
      );
    }
    return value;
  }
  if (typeof value !== "object" || value === null) {
    throw new BrainContractError(
      `${path} must contain JSON-safe values`,
      "invalid_metadata",
      path,
    );
  }
  if (state.seen.has(value)) {
    throw new BrainContractError(
      `${path} must not contain cyclic values`,
      "invalid_metadata",
      path,
    );
  }
  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      return Object.freeze(value.map((entry, index) =>
        cloneMetadataValue(entry, `${path}[${index}]`, depth + 1, state)
      ));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new BrainContractError(
        `${path} must contain plain JSON objects`,
        "invalid_metadata",
        path,
      );
    }
    const output: Record<string, BrainMetadataValue> = Object.create(null);
    for (const [key, entry] of Object.entries(value)) {
      if (
        key.length === 0
        || key.length > MAX_METADATA_KEY_CHARACTERS
        || FORBIDDEN_METADATA_KEYS.has(key)
      ) {
        throw new BrainContractError(
          `${path} contains an invalid key`,
          "invalid_metadata",
          `${path}.${key}`,
        );
      }
      output[key] = cloneMetadataValue(
        entry,
        `${path}.${key}`,
        depth + 1,
        state,
      );
    }
    return Object.freeze(output);
  } finally {
    state.seen.delete(value);
  }
}

export function normalizeBrainMetadata(
  value: unknown = {},
  path = "metadata",
): BrainMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BrainContractError(
      `${path} must be a JSON object`,
      "invalid_metadata",
      path,
    );
  }
  return cloneMetadataValue(
    value,
    path,
    0,
    { nodes: 0, seen: new WeakSet() },
  ) as BrainMetadata;
}

export function normalizeBrainFailure(
  value: unknown,
  path: string,
  code: Extract<
    BrainContractErrorCode,
    "invalid_source" | "invalid_version" | "invalid_ingestion_job"
  > = "invalid_ingestion_job",
): BrainFailure {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BrainContractError(
      `${path} must be an object`,
      code,
      path,
    );
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.retryable !== "boolean") {
    throw new BrainContractError(
      `${path}.retryable must be a boolean`,
      code,
      `${path}.retryable`,
    );
  }
  return Object.freeze({
    code: requiredText(
      candidate.code,
      `${path}.code`,
      128,
      code,
    ),
    message: requiredText(
      candidate.message,
      `${path}.message`,
      4_000,
      code,
    ),
    retryable: candidate.retryable,
  });
}
