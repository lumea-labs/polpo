import {
  registerSchema,
  setShouldValidateFormat,
  unregisterSchema,
  validate as compileSchema,
  type OutputUnit,
  type SchemaObject,
  type Validator as CompiledSchemaValidator,
} from "@hyperjump/json-schema/draft-2020-12";
import "@hyperjump/json-schema/draft-2019-09";
import "@hyperjump/json-schema/draft-07";
import "@hyperjump/json-schema/draft-06";
import "@hyperjump/json-schema/draft-04";
import "@hyperjump/json-schema/formats";
import { jsonSchema } from "ai";

type JsonObject = Record<string, unknown>;
export type ToolInputValidationResult =
  | { success: true; value: unknown }
  | { success: false; error: Error };
type ToolInputValidator = (
  value: unknown,
) => ToolInputValidationResult | PromiseLike<ToolInputValidationResult>;

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const toolInputValidatorCache = new WeakMap<object, ToolInputValidator>();
const structuralValidatorCache = new Map<string, ToolInputValidator>();
const toolSchemaSources = new WeakMap<object, JsonObject>();
const schemaAdmissionCache = new WeakMap<object, Promise<void>>();
const structuralAdmissionCache = new Map<string, Promise<void>>();
const MAX_STRUCTURAL_VALIDATORS = 256;
export const MAX_TOOL_SCHEMA_BYTES = 256 * 1024;
export const MAX_TOOL_SCHEMA_DEPTH = 64;
export const MAX_TOOL_SCHEMA_NODES = 20_000;
export const MAX_TOOL_INPUT_BYTES = 1024 * 1024;
export const MAX_TOOL_INPUT_DEPTH = 128;
export const MAX_TOOL_INPUT_NODES = 100_000;
const DANGEROUS_INPUT_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const validatorNamespace =
  typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
let validatorSequence = 0;

setShouldValidateFormat(true);

function cacheStructuralValidator(
  key: string,
  validator: ToolInputValidator,
): void {
  structuralValidatorCache.delete(key);
  structuralValidatorCache.set(key, validator);
  if (structuralValidatorCache.size > MAX_STRUCTURAL_VALIDATORS) {
    const oldest = structuralValidatorCache.keys().next().value;
    if (oldest !== undefined) structuralValidatorCache.delete(oldest);
  }
}

const SCHEMA_MAP_KEYWORDS = new Set([
  "$defs",
  "definitions",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);
const SCHEMA_ARRAY_KEYWORDS = new Set([
  "allOf",
  "anyOf",
  "oneOf",
  "prefixItems",
]);
const SCHEMA_VALUE_KEYWORDS = new Set([
  "additionalItems",
  "additionalProperties",
  "contains",
  "contentSchema",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);

function cloneJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneJsonValue);
  if (!isJsonObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, cloneJsonValue(child)]),
  );
}

function structuralSchemaKey(schema: JsonObject): string {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: schema, depth: 0 }];
  const visited = new WeakSet<object>();
  let nodes = 0;

  while (pending.length > 0) {
    const { value, depth } = pending.pop()!;
    nodes += 1;
    if (nodes > MAX_TOOL_SCHEMA_NODES) {
      throw new Error(`JSON Schema exceeds ${MAX_TOOL_SCHEMA_NODES} nodes.`);
    }
    if (depth > MAX_TOOL_SCHEMA_DEPTH) {
      throw new Error(`JSON Schema exceeds depth ${MAX_TOOL_SCHEMA_DEPTH}.`);
    }
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    ) {
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new Error("JSON Schema numbers must be finite.");
      }
      continue;
    }
    if (typeof value !== "object") {
      throw new Error(
        `JSON Schema contains a non-JSON ${typeof value} value.`,
      );
    }
    if (visited.has(value)) continue;
    visited.add(value);

    if (!Array.isArray(value)) {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error("JSON Schema must contain only plain JSON objects.");
      }
      for (const descriptor of Object.values(
        Object.getOwnPropertyDescriptors(value),
      )) {
        if ("get" in descriptor || "set" in descriptor) {
          throw new Error("JSON Schema must not contain accessors.");
        }
      }
    }

    pending.push(...Object.values(value).map((nested) => ({
      value: nested,
      depth: depth + 1,
    })));
  }

  const serialized = JSON.stringify(schema);
  if (new TextEncoder().encode(serialized).byteLength > MAX_TOOL_SCHEMA_BYTES) {
    throw new Error(`JSON Schema exceeds ${MAX_TOOL_SCHEMA_BYTES} bytes.`);
  }
  return serialized;
}

function assertSafeToolInputValue(value: unknown): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const visited = new WeakSet<object>();
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > MAX_TOOL_INPUT_NODES) {
      throw new Error(`Tool input exceeds ${MAX_TOOL_INPUT_NODES} nodes.`);
    }
    if (current.depth > MAX_TOOL_INPUT_DEPTH) {
      throw new Error(`Tool input exceeds depth ${MAX_TOOL_INPUT_DEPTH}.`);
    }
    const nested = current.value;
    if (nested === null || typeof nested === "string" || typeof nested === "boolean") continue;
    if (typeof nested === "number") {
      if (!Number.isFinite(nested)) throw new Error("Tool input numbers must be finite.");
      continue;
    }
    if (!nested || typeof nested !== "object") {
      throw new Error(`Tool input contains a non-JSON ${typeof nested} value.`);
    }
    if (visited.has(nested)) throw new Error("Tool input must not be cyclic.");
    visited.add(nested);
    if (!Array.isArray(nested)) {
      const prototype = Object.getPrototypeOf(nested);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error("Tool input must contain only plain JSON objects.");
      }
      const descriptors = Object.getOwnPropertyDescriptors(nested);
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (DANGEROUS_INPUT_KEYS.has(key)) {
          throw new Error(`Tool input key ${JSON.stringify(key)} is not allowed.`);
        }
        if ("get" in descriptor || "set" in descriptor) {
          throw new Error("Tool input must not contain accessors.");
        }
      }
    }
    pending.push(...Object.values(nested).map((entry) => ({
      value: entry,
      depth: current.depth + 1,
    })));
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("Tool input must be JSON serializable.");
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_TOOL_INPUT_BYTES) {
    throw new Error(`Tool input exceeds ${MAX_TOOL_INPUT_BYTES} bytes.`);
  }
}

function portableSchemaValue(value: unknown): unknown {
  return isJsonObject(value) ? toPortableToolInputSchema(value) : value;
}

function portableSchemaMap(value: unknown): unknown {
  if (!isJsonObject(value)) return cloneJsonValue(value);
  return Object.fromEntries(
    Object.entries(value).map(([key, schema]) => [
      key,
      portableSchemaValue(schema),
    ]),
  );
}

function portableSchemaArray(value: unknown): unknown {
  if (!Array.isArray(value)) return cloneJsonValue(value);
  return value.map(portableSchemaValue);
}

function portableDependencies(value: unknown): unknown {
  if (!isJsonObject(value)) return cloneJsonValue(value);
  return Object.fromEntries(
    Object.entries(value).map(([key, dependency]) => [
      key,
      isJsonObject(dependency)
        ? toPortableToolInputSchema(dependency)
        : cloneJsonValue(dependency),
    ]),
  );
}

function visitSchemaReferences(
  schema: unknown,
  visit: (keyword: string, reference: unknown) => void,
): void {
  if (!isJsonObject(schema)) return;

  for (const keyword of ["$ref", "$dynamicRef", "$recursiveRef"]) {
    if (keyword in schema) visit(keyword, schema[keyword]);
  }

  for (const keyword of SCHEMA_MAP_KEYWORDS) {
    const map = schema[keyword];
    if (!isJsonObject(map)) continue;
    for (const child of Object.values(map)) visitSchemaReferences(child, visit);
  }
  for (const keyword of SCHEMA_ARRAY_KEYWORDS) {
    const children = schema[keyword];
    if (!Array.isArray(children)) continue;
    for (const child of children) visitSchemaReferences(child, visit);
  }
  for (const keyword of SCHEMA_VALUE_KEYWORDS) {
    const child = schema[keyword];
    if (keyword === "items" && Array.isArray(child)) {
      for (const item of child) visitSchemaReferences(item, visit);
      continue;
    }
    visitSchemaReferences(child, visit);
  }

  const dependencies = schema.dependencies;
  if (isJsonObject(dependencies)) {
    for (const dependency of Object.values(dependencies)) {
      if (isJsonObject(dependency) || typeof dependency === "boolean") {
        visitSchemaReferences(dependency, visit);
      }
    }
  }
}

/**
 * Build a model-facing schema that survives dynamic provider routing.
 *
 * Vercel AI Gateway can route xAI models through Vertex, whose function
 * declaration converter rejects realistic numeric `minimum` values. Keep the
 * constraint in the description for the model and enforce the untouched
 * schema locally before execution.
 */
export function toPortableToolInputSchema(input: unknown): JsonObject {
  if (!isJsonObject(input)) return { type: "object", properties: {} };

  const output: JsonObject = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "minimum" || key === "$async") continue;
    if (SCHEMA_MAP_KEYWORDS.has(key)) {
      output[key] = portableSchemaMap(value);
      continue;
    }
    if (SCHEMA_ARRAY_KEYWORDS.has(key)) {
      output[key] = portableSchemaArray(value);
      continue;
    }
    if (key === "items" && Array.isArray(value)) {
      output[key] = portableSchemaArray(value);
      continue;
    }
    if (SCHEMA_VALUE_KEYWORDS.has(key)) {
      output[key] = portableSchemaValue(value);
      continue;
    }
    if (key === "dependencies") {
      output[key] = portableDependencies(value);
      continue;
    }
    output[key] = cloneJsonValue(value);
  }

  if (input.minimum !== undefined) {
    const constraint = `Minimum: ${String(input.minimum)}.`;
    const description =
      typeof output.description === "string" ? output.description.trim() : "";
    output.description = description
      ? `${description}${/[.!?]$/.test(description) ? "" : "."} ${constraint}`
      : constraint;
  }
  return output;
}

const SUPPORTED_DIALECTS = new Map<string, string>([
  [
    "http://json-schema.org/draft-04/schema",
    "http://json-schema.org/draft-04/schema",
  ],
  [
    "https://json-schema.org/draft-04/schema",
    "http://json-schema.org/draft-04/schema",
  ],
  [
    "http://json-schema.org/draft-06/schema",
    "http://json-schema.org/draft-06/schema",
  ],
  [
    "https://json-schema.org/draft-06/schema",
    "http://json-schema.org/draft-06/schema",
  ],
  [
    "http://json-schema.org/draft-07/schema",
    "http://json-schema.org/draft-07/schema",
  ],
  [
    "https://json-schema.org/draft-07/schema",
    "http://json-schema.org/draft-07/schema",
  ],
  [
    "https://json-schema.org/draft/2019-09/schema",
    "https://json-schema.org/draft/2019-09/schema",
  ],
  [
    "https://json-schema.org/draft/2020-12/schema",
    "https://json-schema.org/draft/2020-12/schema",
  ],
]);
const DEFAULT_SCHEMA_DIALECT = "http://json-schema.org/draft-07/schema";

function schemaDialect(schema: JsonObject): string {
  if (schema.$schema === undefined) return DEFAULT_SCHEMA_DIALECT;
  if (typeof schema.$schema !== "string") {
    throw new Error("JSON Schema $schema must be a string.");
  }

  const declared = schema.$schema.endsWith("#")
    ? schema.$schema.slice(0, -1)
    : schema.$schema;
  const supported = SUPPORTED_DIALECTS.get(declared);
  if (!supported) {
    throw new Error(`Unsupported JSON Schema dialect: ${schema.$schema}`);
  }
  return supported;
}

function assertSelfContainedSchema(schema: JsonObject): void {
  visitSchemaReferences(schema, (keyword, reference) => {
    if (typeof reference !== "string") return;
    if (reference === "" || reference.startsWith("#")) return;
    throw new Error(
      `External tool schema references are not supported (${keyword}: ${reference}).`,
    );
  });
}

function validationFailure(message: string): ToolInputValidator {
  return () => ({
    success: false,
    error: new Error(message),
  });
}

function collectValidationErrors(errors: OutputUnit[] | undefined): string[] {
  const details: string[] = [];
  for (const error of errors ?? []) {
    const nested = collectValidationErrors(error.errors);
    if (nested.length > 0) {
      details.push(...nested);
      continue;
    }
    const keyword =
      error.keyword.split("/").filter(Boolean).at(-1) ?? "schema";
    details.push(`${error.instanceLocation || "#"} failed ${keyword}`);
  }
  return details;
}

function validationError(
  errors: OutputUnit[] | undefined,
): ToolInputValidationResult {
  const details = collectValidationErrors(errors).join("; ");
  return {
    success: false,
    error: new Error(details || "Tool input does not match its schema."),
  };
}

function modelFacingToolInputSchema(input: unknown): JsonObject {
  if (!isJsonObject(input)) {
    throw new Error("Tool input schema must be a JSON object.");
  }

  schemaDialect(input);
  assertSelfContainedSchema(input);
  structuralSchemaKey(input);
  return toPortableToolInputSchema(input);
}

async function compileToolInputSchema(
  schema: JsonObject,
): Promise<CompiledSchemaValidator> {
  const dialect = schemaDialect(schema);
  assertSelfContainedSchema(schema);

  const retrievalUri =
    `urn:polpo:tool-schema:${validatorNamespace}:${validatorSequence++}`;
  const registeredSchema = cloneJsonValue(schema) as JsonObject;
  if (registeredSchema.$schema !== undefined) {
    registeredSchema.$schema = dialect;
  }

  registerSchema(registeredSchema as SchemaObject, retrievalUri, dialect);
  try {
    return await compileSchema(retrievalUri);
  } finally {
    unregisterSchema(retrievalUri);
  }
}

function toolInputValidator(schema: unknown): ToolInputValidator {
  if (!isJsonObject(schema)) {
    return validationFailure("Tool input schema must be a JSON object.");
  }

  const cached = toolInputValidatorCache.get(schema);
  if (cached) return cached;

  let structuralKey: string;
  try {
    structuralKey = structuralSchemaKey(schema);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failure = validationFailure(`Invalid tool input schema: ${message}`);
    toolInputValidatorCache.set(schema, failure);
    return failure;
  }
  const structural = structuralValidatorCache.get(structuralKey);
  if (structural) {
    structuralValidatorCache.delete(structuralKey);
    structuralValidatorCache.set(structuralKey, structural);
    toolInputValidatorCache.set(schema, structural);
    return structural;
  }

  if (schema.$async === true) {
    const failure = validationFailure(
      "Invalid tool input schema: $async is not supported by edge-safe runtime validation.",
    );
    toolInputValidatorCache.set(schema, failure);
    cacheStructuralValidator(structuralKey, failure);
    return failure;
  }

  try {
    schemaDialect(schema);
    assertSelfContainedSchema(schema);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failure = validationFailure(message);
    toolInputValidatorCache.set(schema, failure);
    cacheStructuralValidator(structuralKey, failure);
    return failure;
  }

  let compiledSchema: Promise<CompiledSchemaValidator> | undefined;
  const validator: ToolInputValidator = async (value) => {
    try {
      assertSafeToolInputValue(value);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
    compiledSchema ??= compileToolInputSchema(schema);

    let schemaValidator: CompiledSchemaValidator;
    try {
      schemaValidator = await compiledSchema;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: new Error(`Invalid tool input schema: ${message}`),
      };
    }

    try {
      const result = schemaValidator(value as never, "BASIC");
      return result.valid
        ? { success: true, value }
        : validationError(result.errors);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: new Error(`Invalid tool input schema: ${message}`),
      };
    }
  };

  /*
   * Compilation stays lazy: most declared tools are never called, and schema
   * validation exists to guard execution rather than add latency to every
   * model request.
   */
  toolInputValidatorCache.set(schema, validator);
  cacheStructuralValidator(structuralKey, validator);
  return validator;
}

export function toValidatedToolInputSchema(input: unknown) {
  const modelFacingSchema = modelFacingToolInputSchema(input);
  const schema = jsonSchema(modelFacingSchema, {
    validate: toolInputValidator(input),
  });
  toolSchemaSources.set(schema as object, input as JsonObject);
  return schema;
}

/**
 * Recompile one admitted AI SDK schema for the concrete runtime route.
 * Verified provider routes receive the untouched canonical schema. Unknown
 * compatible routes retain the conservative portable form while the same
 * canonical validator remains attached at the execution boundary.
 */
export function compileToolInputSchemaForRuntime(
  inputSchema: unknown,
  options: { preserveCanonicalConstraints: boolean },
): {
  inputSchema: unknown;
  constraintsLocalOnly: boolean;
} {
  if (!isJsonObject(inputSchema)) {
    return { inputSchema, constraintsLocalOnly: false };
  }
  // Only schemas admitted by toValidatedToolInputSchema carry the canonical
  // source needed for recompilation. Preserve third-party/custom AI SDK
  // schema wrappers byte-for-byte, including their custom validator.
  const canonical = toolSchemaSources.get(inputSchema);
  if (!canonical) return { inputSchema, constraintsLocalOnly: false };

  const providerSchema = options.preserveCanonicalConstraints
    ? cloneJsonValue(canonical) as JsonObject
    : modelFacingToolInputSchema(canonical);
  const constraintsLocalOnly = structuralSchemaKey(providerSchema)
    !== structuralSchemaKey(canonical);
  const compiled = jsonSchema(providerSchema, {
    validate: toolInputValidator(canonical),
  });
  toolSchemaSources.set(compiled as object, canonical);
  return { inputSchema: compiled, constraintsLocalOnly };
}

/**
 * Compile every model-visible function schema before provider inference.
 * This prevents malformed canonical schemas from being silently widened or
 * discovered only after a model has already spent a turn generating a call.
 */
export async function assertToolInputSchemasAdmitted(
  tools: Record<string, unknown> | undefined,
): Promise<void> {
  for (const [name, rawTool] of Object.entries(tools ?? {})) {
    if (!isJsonObject(rawTool)) continue;
    if (
      typeof rawTool.type === "string"
      && rawTool.type !== "function"
      && rawTool.type !== "dynamic"
    ) {
      continue;
    }
    const inputSchema = rawTool.inputSchema;
    if (!isJsonObject(inputSchema)) {
      throw new Error(`Invalid input schema for tool ${JSON.stringify(name)}: schema wrapper is missing.`);
    }
    const canonical = toolSchemaSources.get(inputSchema)
      ?? (isJsonObject(inputSchema.jsonSchema) ? inputSchema.jsonSchema : undefined);
    if (!canonical) continue;

    try {
      await admitJsonSchema(canonical);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Invalid input schema for tool ${JSON.stringify(name)}: ${message}`,
        { cause: error },
      );
    }
  }
}

async function admitJsonSchema(schema: JsonObject): Promise<void> {
  const cached = schemaAdmissionCache.get(schema);
  if (cached) return await cached;

  const structuralKey = structuralSchemaKey(schema);
  const structural = structuralAdmissionCache.get(structuralKey);
  if (structural) {
    schemaAdmissionCache.set(schema, structural);
    return await structural;
  }

  if (schema.$async === true) {
    throw new Error("$async is not supported by edge-safe runtime validation.");
  }
  const admission = (async () => {
    await compileToolInputSchema(schema);
  })();
  schemaAdmissionCache.set(schema, admission);
  structuralAdmissionCache.set(structuralKey, admission);
  try {
    await admission;
  } catch (error) {
    structuralAdmissionCache.delete(structuralKey);
    throw error;
  }
}

/** Validate a deterministic tool call through the same schema path as model calls. */
export async function validateToolInput(
  schema: unknown,
  value: unknown,
): Promise<ToolInputValidationResult> {
  return await validateJsonSchema(schema, value);
}

/** Validate any JSON value against a caller-provided JSON Schema. */
export async function validateJsonSchema(
  schema: unknown,
  value: unknown,
): Promise<ToolInputValidationResult> {
  return await toolInputValidator(schema)(value);
}
