import { Output, jsonSchema } from "ai";
import { validateJsonSchema } from "@polpo-ai/llm";
import type { CompletionResponseFormat } from "./schemas.js";

export class CompletionStructuredOutputError extends Error {
  readonly code = "invalid_response_format_output";
  readonly param = "response_format";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CompletionStructuredOutputError";
  }
}

export function isStructuredResponseFormat(
  format: CompletionResponseFormat | undefined,
): boolean {
  return format?.type === "json_object" || format?.type === "json_schema";
}

function schemaValidator(schema: Record<string, unknown>) {
  return async (value: unknown) => {
    const result = await validateJsonSchema(schema, value);
    return result.success
      ? result
      : {
          success: false as const,
          error: new CompletionStructuredOutputError(
            `Model output does not match response_format: ${result.error.message}`,
            { cause: result.error },
          ),
        };
  };
}

/** Translate the OpenAI wire format into the provider-neutral AI SDK output contract. */
export function modelOutputForResponseFormat(
  format: CompletionResponseFormat | undefined,
): Output.Output<unknown, unknown, never> | undefined {
  if (!format || format.type === "text") return undefined;

  if (format.type === "json_object") {
    return Output.json();
  }

  return Output.object({
    schema: jsonSchema(format.json_schema.schema, {
      validate: schemaValidator(format.json_schema.schema),
    }),
    name: format.json_schema.name,
    description: format.json_schema.description,
  });
}

/**
 * Canonicalize and revalidate the final assistant text after output policies.
 * OpenAI chat completions expose structured output as a JSON string in
 * `message.content`, not as a second proprietary response field.
 */
export async function finalizeResponseFormatText(
  format: CompletionResponseFormat | undefined,
  text: string,
): Promise<string> {
  if (!isStructuredResponseFormat(format)) return text;

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new CompletionStructuredOutputError(
      "Model output is not valid JSON for response_format.",
      { cause: error },
    );
  }

  if (format?.type === "json_object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new CompletionStructuredOutputError(
        "Model output must be a JSON object for response_format type json_object.",
      );
    }
  } else if (format?.type === "json_schema") {
    const validation = await validateJsonSchema(format.json_schema.schema, value);
    if (!validation.success) {
      throw new CompletionStructuredOutputError(
        `Model output does not match response_format: ${validation.error.message}`,
        { cause: validation.error },
      );
    }
    value = validation.value;
  }

  try {
    return JSON.stringify(value);
  } catch (error) {
    throw new CompletionStructuredOutputError(
      "Model output could not be serialized as JSON.",
      { cause: error },
    );
  }
}

export async function serializeModelOutput(
  format: CompletionResponseFormat | undefined,
  output: unknown,
  rawText: string,
): Promise<string> {
  if (!isStructuredResponseFormat(format)) return rawText;
  if (output === undefined) {
    throw new CompletionStructuredOutputError(
      "The model completed without producing the requested structured output.",
    );
  }
  return await finalizeResponseFormatText(format, JSON.stringify(output));
}
