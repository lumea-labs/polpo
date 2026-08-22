import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import {
  cloneLoopJsonValue,
  resolveLoopInputBindings,
  type LoopContextBindingResolution,
} from "./bindings.js";
import type { ContextBag } from "./types.js";

export const LOOP_AGENT_INPUT_MAX_BYTES = 256 * 1024;

export type LoopAgentInputErrorCode =
  | "loop_agent_input_invalid"
  | "loop_agent_input_too_large";

export class LoopAgentInputError extends Error {
  constructor(
    public readonly code: LoopAgentInputErrorCode,
    message: string,
    public readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "LoopAgentInputError";
  }
}

export interface LoopAgentInputDiagnostics {
  readonly bytes: number;
  readonly hash: string;
  readonly schemaValidated: boolean;
  readonly bindingCount: number;
  readonly bindingPaths: readonly LoopContextBindingResolution[];
}

export interface PreparedLoopAgentInput {
  readonly value: unknown;
  readonly serialized: string;
  readonly diagnostics: LoopAgentInputDiagnostics;
}

const schemaAjv = new Ajv({
  allErrors: true,
  allowUnionTypes: true,
  strict: false,
  validateFormats: false,
});

const validatorCache = new WeakMap<object, ValidateFunction>();

function isSchema(value: unknown): value is boolean | Record<string, unknown> {
  if (typeof value === "boolean") return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compileSchema(schema: boolean | Record<string, unknown>): ValidateFunction {
  if (typeof schema === "object") {
    const cached = validatorCache.get(schema);
    if (cached) return cached;
  }
  try {
    const safeSchema = typeof schema === "boolean"
      ? schema
      : cloneLoopJsonValue(schema, "$inputSchema") as Record<string, unknown>;
    const validator = schemaAjv.compile(safeSchema);
    if ((validator as ValidateFunction & { $async?: boolean }).$async) {
      throw new Error("asynchronous JSON Schemas are not supported");
    }
    if (typeof schema === "object") validatorCache.set(schema, validator);
    return validator;
  } catch (error) {
    if (error instanceof LoopAgentInputError) throw error;
    throw new LoopAgentInputError(
      "loop_agent_input_invalid",
      `Agent step inputSchema is invalid: ${error instanceof Error ? error.message : String(error)}`,
      { phase: "schema_compile" },
    );
  }
}

/** Compile-only validation used by config loaders for early author feedback. */
export function assertLoopAgentInputSchema(inputSchema: unknown): void {
  if (!isSchema(inputSchema)) {
    throw new LoopAgentInputError(
      "loop_agent_input_invalid",
      "Agent step inputSchema must be a JSON Schema object or boolean",
      { phase: "schema_compile" },
    );
  }
  compileSchema(inputSchema);
}

function validationMessage(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? []).slice(0, 8).map((error) => {
    const path = error.instancePath || "$";
    return `${path} ${error.message ?? "does not match the schema"}`;
  }).join("; ") || "input does not match inputSchema";
}

function deepFreezeJson(value: unknown): unknown {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreezeJson(child);
  return Object.freeze(value);
}

function fnv1a64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  const bytes = new TextEncoder().encode(value);
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}

/**
 * Resolve and validate model-visible input for one Project Loop agent step.
 * The returned JSON graph is detached from shared context and deeply frozen.
 */
export function prepareLoopAgentInput(
  authoredInput: unknown,
  inputSchema: unknown,
  context: Readonly<ContextBag>,
): PreparedLoopAgentInput {
  const bindingPaths: LoopContextBindingResolution[] = [];
  const resolved = resolveLoopInputBindings(
    authoredInput,
    context,
    (binding) => bindingPaths.push(binding),
  );
  const detached = cloneLoopJsonValue(resolved);

  if (inputSchema !== undefined) {
    assertLoopAgentInputSchema(inputSchema);
    const validator = compileSchema(inputSchema as boolean | Record<string, unknown>);
    if (!validator(detached)) {
      throw new LoopAgentInputError(
        "loop_agent_input_invalid",
        `Agent step input is invalid: ${validationMessage(validator.errors)}`,
        {
          phase: "schema_validation",
          errors: (validator.errors ?? []).slice(0, 8).map((error) => ({
            keyword: error.keyword,
            path: error.instancePath || "$",
            message: error.message,
          })),
        },
      );
    }
  }

  const serialized = JSON.stringify(detached);
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes > LOOP_AGENT_INPUT_MAX_BYTES) {
    throw new LoopAgentInputError(
      "loop_agent_input_too_large",
      `Agent step input is ${bytes} bytes; maximum is ${LOOP_AGENT_INPUT_MAX_BYTES} bytes`,
      { bytes, maxBytes: LOOP_AGENT_INPUT_MAX_BYTES },
    );
  }

  return Object.freeze({
    value: deepFreezeJson(detached),
    serialized,
    diagnostics: Object.freeze({
      bytes,
      hash: fnv1a64(serialized),
      schemaValidated: inputSchema !== undefined,
      bindingCount: bindingPaths.length,
      bindingPaths: Object.freeze(bindingPaths.map((binding) => Object.freeze({ ...binding }))),
    }),
  });
}

export function loopAgentInputPrompt(stepName: string, input: PreparedLoopAgentInput): string {
  return [
    `Execute Project Loop agent step ${JSON.stringify(stepName)} using only the validated input below.`,
    "Do not infer omitted creative requirements or reconstruct earlier conversation context.",
    "<polpo_loop_step_input>",
    input.serialized,
    "</polpo_loop_step_input>",
  ].join("\n");
}
