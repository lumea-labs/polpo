import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { cloneLoopJsonValue } from "./bindings.js";

export const LOOP_AGENT_OUTPUT_MAX_BYTES = 256 * 1024;

export type LoopAgentOutputErrorCode =
  | "loop_agent_output_invalid"
  | "loop_agent_output_too_large";

export class LoopAgentOutputError extends Error {
  constructor(
    public readonly code: LoopAgentOutputErrorCode,
    public readonly stepName: string,
    message: string,
    public readonly details?: Readonly<Record<string, unknown>>,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "LoopAgentOutputError";
  }
}

const schemaAjv = new Ajv({
  allErrors: true,
  allowUnionTypes: true,
  strict: false,
  validateFormats: false,
});

const validatorCache = new WeakMap<object, ValidateFunction>();

function isSchema(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compileSchema(
  schema: Record<string, unknown>,
  stepName: string,
): ValidateFunction {
  const cached = validatorCache.get(schema);
  if (cached) return cached;
  try {
    const safeSchema = cloneLoopJsonValue(
      schema,
      "$output.schema",
    ) as Record<string, unknown>;
    const validator = schemaAjv.compile(safeSchema);
    if ((validator as ValidateFunction & { $async?: boolean }).$async) {
      throw new Error("asynchronous JSON Schemas are not supported");
    }
    validatorCache.set(schema, validator);
    return validator;
  } catch (error) {
    if (error instanceof LoopAgentOutputError) throw error;
    throw new LoopAgentOutputError(
      "loop_agent_output_invalid",
      stepName,
      `Agent step ${JSON.stringify(stepName)} output.schema is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { phase: "schema_compile" },
      { cause: error },
    );
  }
}

/** Compile-only validation used by config loaders for early author feedback. */
export function assertLoopAgentOutputSchema(outputSchema: unknown): void {
  if (!isSchema(outputSchema)) {
    throw new LoopAgentOutputError(
      "loop_agent_output_invalid",
      "<config>",
      "Agent step output.schema must be a JSON Schema object",
      { phase: "schema_compile" },
    );
  }
  compileSchema(outputSchema, "<config>");
}

function validationDetails(errors: ErrorObject[] | null | undefined) {
  return (errors ?? []).slice(0, 8).map((error) => ({
    keyword: error.keyword,
    path: error.instancePath || "$",
    message: error.message,
  }));
}

function validationMessage(errors: ErrorObject[] | null | undefined): string {
  return validationDetails(errors).map((error) =>
    `${error.path} ${error.message ?? "does not match the schema"}`,
  ).join("; ") || "output does not match output.schema";
}

export interface PreparedLoopAgentOutput {
  readonly value: unknown;
  readonly serialized: string;
  readonly bytes: number;
}

/** Validate and detach an Agent step result before it enters shared loop context. */
export function prepareLoopAgentOutput(
  stepName: string,
  output: unknown,
  outputSchema: unknown,
): PreparedLoopAgentOutput {
  assertLoopAgentOutputSchema(outputSchema);
  const detached = cloneLoopJsonValue(output, `$${stepName}`);
  const validator = compileSchema(
    outputSchema as Record<string, unknown>,
    stepName,
  );
  if (!validator(detached)) {
    throw new LoopAgentOutputError(
      "loop_agent_output_invalid",
      stepName,
      `Agent step ${JSON.stringify(stepName)} output is invalid: ${validationMessage(validator.errors)}`,
      {
        phase: "schema_validation",
        errors: validationDetails(validator.errors),
      },
    );
  }

  const serialized = JSON.stringify(detached);
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes > LOOP_AGENT_OUTPUT_MAX_BYTES) {
    throw new LoopAgentOutputError(
      "loop_agent_output_too_large",
      stepName,
      `Agent step ${JSON.stringify(stepName)} output is ${bytes} bytes; maximum is ${LOOP_AGENT_OUTPUT_MAX_BYTES} bytes`,
      { bytes, maxBytes: LOOP_AGENT_OUTPUT_MAX_BYTES },
    );
  }

  return Object.freeze({ value: detached, serialized, bytes });
}
