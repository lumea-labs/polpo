import { describe, expect, it } from "vitest";
import {
  CompletionStructuredOutputError,
  finalizeResponseFormatText,
  modelOutputForResponseFormat,
} from "./structured-output.js";

const profileFormat = {
  type: "json_schema" as const,
  json_schema: {
    name: "user_profile",
    strict: true,
    schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        plan: { type: "string", enum: ["free", "pro"] },
      },
      required: ["name", "plan"],
      additionalProperties: false,
    },
  },
};

describe("OpenAI response_format translation", () => {
  it("keeps text generation on the legacy path", () => {
    expect(modelOutputForResponseFormat(undefined)).toBeUndefined();
    expect(modelOutputForResponseFormat({ type: "text" })).toBeUndefined();
  });

  it("builds a named provider-neutral JSON Schema output", async () => {
    const output = modelOutputForResponseFormat(profileFormat);
    expect(await output?.responseFormat).toEqual({
      type: "json",
      schema: profileFormat.json_schema.schema,
      name: "user_profile",
      description: undefined,
    });
  });

  it("uses provider-native JSON mode for json_object", async () => {
    const output = modelOutputForResponseFormat({ type: "json_object" });
    expect(await output?.responseFormat).toEqual({ type: "json" });
  });

  it("canonicalizes a valid schema output", async () => {
    await expect(finalizeResponseFormatText(
      profileFormat,
      '{ "name": "Ada", "plan": "pro" }',
    )).resolves.toBe('{"name":"Ada","plan":"pro"}');
  });

  it.each([
    '{"name":"Ada"}',
    '{"name":"Ada","plan":"enterprise"}',
    '{"name":"Ada","plan":"pro","extra":true}',
    "not-json",
  ])("rejects output that violates json_schema: %s", async (text) => {
    await expect(finalizeResponseFormatText(profileFormat, text))
      .rejects.toBeInstanceOf(CompletionStructuredOutputError);
  });

  it("requires json_object to have an object root", async () => {
    await expect(finalizeResponseFormatText({ type: "json_object" }, "[]"))
      .rejects.toMatchObject({ code: "invalid_response_format_output" });
  });
});
