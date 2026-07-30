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
type ToolInputValidationResult =
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
const MAX_STRUCTURAL_VALIDATORS = 256;
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
  const pending: unknown[] = [schema];
  const visited = new WeakSet<object>();

  while (pending.length > 0) {
    const value = pending.pop();
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

    pending.push(...Object.values(value));
  }

  return JSON.stringify(schema);
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
    return { type: "object", properties: {}, additionalProperties: false };
  }

  try {
    schemaDialect(input);
    assertSelfContainedSchema(input);
    structuralSchemaKey(input);
    return toPortableToolInputSchema(input);
  } catch {
    return { type: "object", properties: {}, additionalProperties: false };
  }
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
  return jsonSchema(modelFacingToolInputSchema(input), {
    validate: toolInputValidator(input),
  });
}
