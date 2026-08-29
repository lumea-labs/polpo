import { describe, expect, it, vi } from "vitest";
import { generateText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import {
  persistAssistantMessage,
  toAITools,
  toPortableToolInputSchema,
} from "./tool-mapping.js";

function fakeStore() {
  return { updateMessage: vi.fn().mockResolvedValue(true) };
}

describe("persistAssistantMessage", () => {
  it("no-ops when the session is not tracked", async () => {
    const store = fakeStore();
    await persistAssistantMessage(undefined, "s1", "m1", "hi", []);
    await persistAssistantMessage(store, null, "m1", "hi", []);
    await persistAssistantMessage(store, "s1", undefined, "hi", []);
    expect(store.updateMessage).not.toHaveBeenCalled();
  });

  it("persists trimmed final text with the tool calls", async () => {
    const store = fakeStore();
    const toolCalls = [{ id: "t1", name: "get_status", arguments: {}, state: "completed" }];
    await persistAssistantMessage(store, "s1", "m1", "  done  ", toolCalls);
    expect(store.updateMessage).toHaveBeenCalledWith("s1", "m1", "done", toolCalls);
  });

  it("falls back to empty string when the model produced no text", async () => {
    const store = fakeStore();
    await persistAssistantMessage(store, "s1", "m1", "   ", []);
    expect(store.updateMessage).toHaveBeenCalledWith("s1", "m1", "", []);
  });

  it("uses the provided emptyFallback for empty text", async () => {
    const store = fakeStore();
    await persistAssistantMessage(store, "s1", "m1", "", [], { emptyFallback: "[Response interrupted]" });
    expect(store.updateMessage).toHaveBeenCalledWith("s1", "m1", "[Response interrupted]", []);
  });

  it("keeps a valid textless tool turn empty instead of marking it interrupted", async () => {
    const store = fakeStore();
    const toolCalls = [{ id: "t1", name: "ask_user_question", arguments: {}, state: "interrupted" }];
    await persistAssistantMessage(store, "s1", "m1", "", toolCalls, { emptyFallback: "[Response interrupted]" });
    expect(store.updateMessage).toHaveBeenCalledWith("s1", "m1", "", toolCalls);
  });

  it("redacts vault credentials before persisting", async () => {
    const store = fakeStore();
    const toolCalls = [
      { id: "t1", name: "set_vault_entry", arguments: { service: "smtp", credentials: { password: "s3cret", user: "bob" } } },
    ];
    await persistAssistantMessage(store, "s1", "m1", "saved", toolCalls);
    const persisted = store.updateMessage.mock.calls[0]![3];
    expect(persisted[0].arguments.credentials).toEqual({ password: "[REDACTED]", user: "[REDACTED]" });
    // original must not be mutated
    expect(toolCalls[0]!.arguments.credentials.password).toBe("s3cret");
  });

  it("persists generated suggestions with the assistant message", async () => {
    const store = fakeStore();
    const suggestions = [{
      id: "suggestion_tests",
      label: "Add tests",
      prompt: "Add tests for this change.",
    }];

    await persistAssistantMessage(store, "s1", "m1", "done", [], { suggestions });

    expect(store.updateMessage).toHaveBeenCalledWith(
      "s1",
      "m1",
      "done",
      [],
      suggestions,
    );
  });

  it("persists a bounded reasoning summary separately from content", async () => {
    const store = fakeStore();
    await persistAssistantMessage(store, "s1", "m1", "done", [], {
      reasoning: "Checked the constraints.",
    });

    expect(store.updateMessage).toHaveBeenCalledWith(
      "s1",
      "m1",
      "done",
      [],
      undefined,
      { text: "Checked the constraints." },
    );
  });
});

describe("toPortableToolInputSchema", () => {
  it("moves minimum into descriptions without mutating the source", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["targetCalories", "missing"],
      properties: {
        targetCalories: {
          type: "number",
          minimum: 1000,
          maximum: 5000,
          multipleOf: 5,
          description: "Daily calorie target.",
        },
        label: {
          type: "string",
          minLength: 2,
          maxLength: 40,
          pattern: "^[A-Za-z ]+$",
        },
      },
    };
    const original = structuredClone(schema);

    expect(toPortableToolInputSchema(schema)).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["targetCalories", "missing"],
      properties: {
        targetCalories: {
          type: "number",
          maximum: 5000,
          multipleOf: 5,
          description:
            "Daily calorie target. Minimum: 1000.",
        },
        label: {
          type: "string",
          minLength: 2,
          maxLength: 40,
          pattern: "^[A-Za-z ]+$",
        },
      },
    });
    expect(schema).toEqual(original);
  });

  it("preserves unions, references, dictionaries, tuples, and nullability", () => {
    const schema = {
      type: "object",
      properties: {
        choice: {
          oneOf: [
            { $ref: "#/$defs/named" },
            { type: ["number", "null"], minimum: 10 },
          ],
        },
        metadata: {
          type: "object",
          additionalProperties: { type: "string" },
        },
        tuple: {
          type: "array",
          items: [{ type: "string" }, { type: "number", minimum: 2 }],
          additionalItems: { type: "number", minimum: 3 },
        },
      },
      $defs: {
        named: {
          type: "object",
          properties: {
            name: { type: "string" },
          },
          required: ["name"],
        },
      },
    };

    expect(toPortableToolInputSchema(schema)).toEqual({
      type: "object",
      properties: {
        choice: {
          oneOf: [
            { $ref: "#/$defs/named" },
            {
              type: ["number", "null"],
              description: "Minimum: 10.",
            },
          ],
        },
        metadata: {
          type: "object",
          additionalProperties: { type: "string" },
        },
        tuple: {
          type: "array",
          items: [
            { type: "string" },
            { type: "number", description: "Minimum: 2." },
          ],
          additionalItems: {
            type: "number",
            description: "Minimum: 3.",
          },
        },
      },
      $defs: {
        named: {
          type: "object",
          properties: {
            name: { type: "string" },
          },
          required: ["name"],
        },
      },
    });
  });

  it("preserves allOf branches instead of inventing merged semantics", () => {
    const schema = {
      type: "object",
      allOf: [
        {
          properties: {
            value: { type: "number", minimum: 10 },
          },
          required: ["value"],
        },
        {
          properties: {
            value: { type: "number", maximum: 5 },
          },
        },
      ],
    };

    expect(toPortableToolInputSchema(schema)).toEqual({
      type: "object",
      allOf: [
        {
          properties: {
            value: { type: "number", description: "Minimum: 10." },
          },
          required: ["value"],
        },
        {
          properties: {
            value: { type: "number", maximum: 5 },
          },
        },
      ],
    });
  });

  it("falls back only for non-object schemas", () => {
    expect(toPortableToolInputSchema(null)).toEqual({
      type: "object",
      properties: {},
    });
    expect(toPortableToolInputSchema(true)).toEqual({
      type: "object",
      properties: {},
    });
  });

  it("does not rewrite object-valued enum, const, default, or examples", () => {
    const literal = {
      minimum: 1,
      nested: { minimum: 2 },
    };
    const schema = {
      type: "object",
      properties: {
        payload: {
          enum: [literal],
          const: literal,
          default: literal,
          examples: [literal],
        },
      },
    };

    expect(toPortableToolInputSchema(schema)).toEqual(schema);
    expect(toPortableToolInputSchema(schema)).not.toBe(schema);
  });

  it("uses the portable schema for providers and the original for validation", async () => {
    const tools = toAITools([
      {
        name: "calculate",
        description: "Calculate a target.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            target: {
              type: "number",
              minimum: 1000,
              maximum: 5000,
            },
          },
          required: ["target"],
        },
      },
    ]);

    expect((tools.calculate!.inputSchema as any).jsonSchema).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {
        target: {
          type: "number",
          maximum: 5000,
          description: "Minimum: 1000.",
        },
      },
      required: ["target"],
    });

    expect(
      await (tools.calculate!.inputSchema as any).validate({ target: 999 }),
    ).toEqual(
      expect.objectContaining({
        success: false,
        error: expect.any(Error),
      }),
    );
    expect(
      await (tools.calculate!.inputSchema as any).validate({ target: 1000 }),
    ).toEqual({
      success: true,
      value: { target: 1000 },
    });
    expect(
      await (tools.calculate!.inputSchema as any).validate({
        target: 1000,
        unexpected: true,
      }),
    ).toEqual(
      expect.objectContaining({
        success: false,
        error: expect.any(Error),
      }),
    );
  });

  it.each([
    "http://json-schema.org/draft-07/schema#",
    "https://json-schema.org/draft/2019-09/schema",
    "https://json-schema.org/draft/2020-12/schema",
  ])("validates numeric constraints declared with %s", async ($schema) => {
    const tools = toAITools([
      {
        name: "draft_check",
        parameters: {
          $schema,
          type: "object",
          properties: {
            value: { type: "number", minimum: 10 },
          },
          required: ["value"],
        },
      },
    ]);
    const validate = (tools.draft_check!.inputSchema as any).validate;

    expect(await validate({ value: 9 })).toEqual(
      expect.objectContaining({
        success: false,
        error: expect.any(Error),
      }),
    );
    expect(await validate({ value: 10 })).toEqual({
      success: true,
      value: { value: 10 },
    });
  });

  it("validates registered string formats", async () => {
    const tools = toAITools([
      {
        name: "contact",
        parameters: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          additionalProperties: false,
          properties: {
            email: { type: "string", format: "email" },
          },
          required: ["email"],
        },
      },
    ]);
    const validate = (tools.contact!.inputSchema as any).validate;

    expect(await validate({ email: "not-an-email" })).toEqual(
      expect.objectContaining({
        success: false,
        error: expect.any(Error),
      }),
    );
    expect(await validate({ email: "person@example.com" })).toEqual({
      success: true,
      value: { email: "person@example.com" },
    });
  });

  it("fails closed for nonstandard async schemas in edge runtimes", async () => {
    const tools = toAITools([
      {
        name: "async_check",
        parameters: {
          $async: true,
          type: "object",
          properties: {
            value: { type: "number", minimum: 10 },
          },
          required: ["value"],
        },
      },
    ]);
    const validate = (tools.async_check!.inputSchema as any).validate;

    expect((tools.async_check!.inputSchema as any).jsonSchema).not.toHaveProperty(
      "$async",
    );
    expect(await validate({ value: 9 })).toEqual(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({
          message: expect.stringContaining("$async is not supported"),
        }),
      }),
    );
    expect(await validate({ value: 10 })).toEqual(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({
          message: expect.stringContaining("$async is not supported"),
        }),
      }),
    );
  });

  it("fails closed when an original schema cannot be compiled", async () => {
    const tools = toAITools([
      {
        name: "broken",
        parameters: {
          type: "object",
          properties: {
            payload: { $ref: "#/$defs/missing" },
          },
        },
      },
    ]);
    const result = await (tools.broken!.inputSchema as any).validate({
      payload: "unsafe",
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({
          message: expect.stringContaining("Invalid tool input schema"),
        }),
      }),
    );
  });

  it("isolates separately decoded schemas that reuse the same $id", async () => {
    const first = toAITools([{
      name: "first",
      parameters: {
        $id: "https://example.com/reused-tool-schema",
        type: "object",
        properties: { first: { type: "string" } },
        required: ["first"],
      },
    }]);
    const second = toAITools([{
      name: "second",
      parameters: {
        $id: "https://example.com/reused-tool-schema",
        type: "object",
        properties: { second: { type: "number" } },
        required: ["second"],
      },
    }]);

    const [firstResult, secondResult] = await Promise.all([
      (first.first!.inputSchema as any).validate({ first: "ok" }),
      (second.second!.inputSchema as any).validate({ second: 2 }),
    ]);

    expect(firstResult).toEqual({
      success: true,
      value: { first: "ok" },
    });
    expect(secondResult).toEqual({
      success: true,
      value: { second: 2 },
    });
  });

  it("validates ordinary local references without mutating the source schema", async () => {
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        payload: { $ref: "#/$defs/payload" },
      },
      required: ["payload"],
      $defs: {
        payload: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      },
    };
    const original = structuredClone(schema);
    const tools = toAITools([{ name: "local_ref", parameters: schema }]);
    const validate = (tools.local_ref!.inputSchema as any).validate;

    expect(await validate({ payload: { name: "safe" } })).toEqual({
      success: true,
      value: { payload: { name: "safe" } },
    });
    expect(await validate({ payload: { name: 42 } })).toEqual(
      expect.objectContaining({ success: false, error: expect.any(Error) }),
    );
    expect(schema).toEqual(original);
  });

  it("enforces recursive Draft 2020-12 dynamic references", async () => {
    const tools = toAITools([{
      name: "recursive_tree",
      parameters: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $dynamicAnchor: "node",
        type: "object",
        properties: {
          data: { type: "string" },
          children: {
            type: "array",
            items: { $dynamicRef: "#node" },
          },
        },
        required: ["data"],
      },
    }]);
    const validate = (tools.recursive_tree!.inputSchema as any).validate;

    expect(await validate({
      data: "root",
      children: [{ data: "child" }],
    })).toEqual({
      success: true,
      value: { data: "root", children: [{ data: "child" }] },
    });
    expect(await validate({
      data: "root",
      children: [{ data: 42 }],
    })).toEqual(
      expect.objectContaining({ success: false, error: expect.any(Error) }),
    );
  });

  it("fails closed for malformed schemas instead of treating them as parameterless", async () => {
    const tools = toAITools([{
      name: "malformed",
      parameters: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          value: { type: "number", minimum: "not-a-number" },
        },
      },
    }]);

    expect(
      await (tools.malformed!.inputSchema as any).validate({ value: 100 }),
    ).toEqual(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({
          message: expect.stringContaining("Invalid tool input schema"),
        }),
      }),
    );
    expect((tools.malformed!.inputSchema as any).jsonSchema).toEqual({
      type: "object",
      properties: {
        value: {
          type: "number",
          description: "Minimum: not-a-number.",
        },
      },
      $schema: "https://json-schema.org/draft/2020-12/schema",
    });
  });

  it("fails closed for unknown schema dialects", async () => {
    const tools = toAITools([{
      name: "unknown_draft",
      parameters: {
        $schema: "https://example.com/unknown-schema-dialect",
        type: "object",
      },
    }]);

    expect(
      await (tools.unknown_draft!.inputSchema as any).validate({}),
    ).toEqual(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({
          message: expect.stringContaining("Unsupported JSON Schema dialect"),
        }),
      }),
    );
    expect((tools.unknown_draft!.inputSchema as any).jsonSchema).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
  });

  it("rejects external references before the validator can perform network I/O", async () => {
    const tools = toAITools([{
      name: "external_ref",
      parameters: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          payload: { $ref: "https://attacker.example/schema.json" },
        },
      },
    }]);

    expect(
      await (tools.external_ref!.inputSchema as any).validate({ payload: {} }),
    ).toEqual(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({
          message: expect.stringContaining(
            "External tool schema references are not supported",
          ),
        }),
      }),
    );
    expect((tools.external_ref!.inputSchema as any).jsonSchema).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
  });

  it("does not interpret references embedded in literal instance values", async () => {
    const literal = { $ref: "https://example.com/this-is-data" };
    const tools = toAITools([{
      name: "literal_reference",
      parameters: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          payload: { const: literal },
        },
        required: ["payload"],
      },
    }]);
    const validate = (tools.literal_reference!.inputSchema as any).validate;

    expect(await validate({ payload: literal })).toEqual({
      success: true,
      value: { payload: literal },
    });
  });

  it("fails closed for non-JSON schema values without poisoning structural cache entries", async () => {
    const malformed = toAITools([{
      name: "malformed_runtime_value",
      parameters: {
        type: "object",
        properties: {
          value: {
            type: "number",
            custom: () => "not JSON",
          },
        },
      },
    }]);
    const valid = toAITools([{
      name: "valid_runtime_value",
      parameters: {
        type: "object",
        properties: {
          value: { type: "number" },
        },
      },
    }]);

    expect(
      await (malformed.malformed_runtime_value!.inputSchema as any).validate({
        value: 1,
      }),
    ).toEqual(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({
          message: expect.stringContaining("non-JSON function"),
        }),
      }),
    );
    expect(
      await (valid.valid_runtime_value!.inputSchema as any).validate({
        value: 1,
      }),
    ).toEqual({ success: true, value: { value: 1 } });
  });

  it("accepts TypeBox-style symbol metadata that is absent from serialized JSON Schema", async () => {
    const valueSchema = { type: "number" };
    const schema = {
      type: "object",
      properties: { value: valueSchema },
      required: ["value"],
    };
    Object.defineProperty(schema, Symbol.for("TypeBox.Kind"), {
      value: "Object",
      enumerable: true,
    });
    Object.defineProperty(valueSchema, Symbol.for("TypeBox.Kind"), {
      value: "Number",
      enumerable: true,
    });
    const tools = toAITools([{
      name: "typebox_metadata",
      parameters: schema,
    }]);
    const validate = (tools.typebox_metadata!.inputSchema as any).validate;

    expect(await validate({ value: 1 })).toEqual({
      success: true,
      value: { value: 1 },
    });
    expect(await validate({ value: "wrong" })).toEqual(
      expect.objectContaining({ success: false, error: expect.any(Error) }),
    );
  });

  it("ignores validator-internal-looking fields instead of redirecting references", async () => {
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        value: {
          $ref: "#/$defs/strict",
          __absolute_ref__: "#/$defs/permissive",
        },
      },
      required: ["value"],
      $defs: {
        strict: { type: "string" },
        permissive: {},
      },
    };
    const original = structuredClone(schema);
    const tools = toAITools([{ name: "reserved_field", parameters: schema }]);
    const validate = (tools.reserved_field!.inputSchema as any).validate;

    expect(await validate({ value: 42 })).toEqual(
      expect.objectContaining({ success: false, error: expect.any(Error) }),
    );
    expect(await validate({ value: "safe" })).toEqual({
      success: true,
      value: { value: "safe" },
    });
    expect(schema).toEqual(original);
  });

  it("marks provider tool calls invalid when they violate the original schema", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: {
        content: [
          {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: "calculate",
            input: JSON.stringify({ target: 999 }),
          },
        ],
        finishReason: { unified: "tool-calls", raw: undefined },
        usage: {
          inputTokens: { total: 1 },
          outputTokens: { total: 1 },
        },
        warnings: [],
      },
    } as any);
    const tools = toAITools([
      {
        name: "calculate",
        parameters: {
          type: "object",
          properties: {
            target: { type: "number", minimum: 1000 },
          },
          required: ["target"],
        },
      },
    ]);

    const result = await generateText({
      model,
      prompt: "Calculate a target.",
      tools,
    });

    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        toolName: "calculate",
        input: { target: 999 },
        invalid: true,
        error: expect.objectContaining({
          message: expect.stringContaining("minimum"),
        }),
      }),
    ]);
  });
});
