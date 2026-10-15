import type {
  PolpoToolAnnotations,
  PolpoToolStrictness,
} from "./tool-types.js";

export type CanonicalToolExecution = "polpo" | "client" | "provider";

export interface CanonicalToolContract {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly inputSchemaFingerprint: string;
  readonly definitionFingerprint: string;
  readonly execution: CanonicalToolExecution;
  readonly annotations: Readonly<PolpoToolAnnotations>;
  readonly strictness: PolpoToolStrictness;
}

export interface CanonicalToolContractInput {
  readonly name: string;
  readonly description?: string;
  readonly parameters?: unknown;
  readonly inputSchema?: unknown;
  readonly execution?: CanonicalToolExecution;
  readonly annotations?: PolpoToolAnnotations;
  readonly strictness?: PolpoToolStrictness;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalJson(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical contracts require finite numbers");
    return Object.is(value, -0) ? "-0" : String(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("Canonical contracts must not be cyclic");
    seen.add(value);
    try {
      return `[${value.map((entry) => canonicalJson(entry, seen)).join(",")}]`;
    } finally {
      seen.delete(value);
    }
  }
  if (!isPlainObject(value)) {
    throw new TypeError("Canonical contracts must contain only JSON values");
  }
  if (seen.has(value)) throw new TypeError("Canonical contracts must not be cyclic");
  seen.add(value);
  try {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right, "en-US"))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested, seen)}`)
      .join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

function cloneJson<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

function hash(value: string): string {
  let current = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    current ^= BigInt(value.charCodeAt(index));
    current = BigInt.asUintN(64, current * 0x100000001b3n);
  }
  return `fnv1a64:${current.toString(16).padStart(16, "0")}`;
}

export function canonicalContractFingerprint(value: unknown): string {
  return hash(canonicalJson(value));
}

/** Admit and freeze the exact execution contract used for one Run. */
export function admitCanonicalToolContract(
  input: CanonicalToolContractInput,
): CanonicalToolContract {
  const name = input.name?.trim();
  if (!name) throw new TypeError("Canonical tool name must be a non-empty string");
  const rawSchema = input.parameters ?? input.inputSchema ?? {
    type: "object",
    properties: {},
    additionalProperties: false,
  };
  if (!isPlainObject(rawSchema)) {
    throw new TypeError(`Canonical input schema for tool ${JSON.stringify(name)} must be an object`);
  }
  const inputSchema = deepFreeze(cloneJson(rawSchema));
  const annotations = deepFreeze(cloneJson(input.annotations ?? {}));
  const inputSchemaFingerprint = canonicalContractFingerprint(inputSchema);
  const definition = {
    name,
    ...(input.description === undefined ? {} : { description: input.description }),
    inputSchemaFingerprint,
    execution: input.execution ?? "polpo",
    annotations,
    strictness: input.strictness ?? "execution",
  };
  return Object.freeze({
    ...definition,
    inputSchema,
    definitionFingerprint: canonicalContractFingerprint(definition),
  });
}
