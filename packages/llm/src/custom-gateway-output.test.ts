import { afterEach, describe, expect, it, vi } from "vitest";
import { generateText, Output } from "ai";
import { createGatewayModel } from "./provider-factory.js";
import { modelOutputForJsonSchema } from "./model-output.js";
import { streamModelTurn } from "./stream-turn.js";

const schema = {
  type: "object",
  additionalProperties: false,
  properties: {
    goal: { type: "string" },
    constraints: { type: "array", items: { type: "string" } },
  },
  required: ["goal", "constraints"],
};
const value = { goal: "Create the site", constraints: [] };
const messages = [{ role: "user" as const, content: "Create a design brief." }];

function gateway() {
  return createGatewayModel("openai", "gpt-5.6-luna", {
    url: "https://custom-gateway.test/v1",
    apiKey: "test-key",
    headers: { "x-project": "test-project" },
  });
}

function mockTransport(text = JSON.stringify(value), providerError?: string) {
  const requests: Array<{ url: string; headers: Headers; body: Record<string, any> }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    requests.push({ url: String(url), headers: new Headers(init?.headers), body });
    if (providerError) {
      return Response.json({ error: { message: providerError, type: "invalid_request_error", code: "invalid_json_schema" } }, { status: 400 });
    }
    if (body.stream) {
      const parts = [
        { id: "completion-test", created: 1, model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
        { id: "completion-test", created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } },
      ];
      return new Response(parts.map((part) => `data: ${JSON.stringify(part)}\n\n`).join("") + "data: [DONE]\n\n", {
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    return Response.json({
      id: "completion-test", created: 1, model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    });
  }));
  return requests;
}

afterEach(() => vi.unstubAllGlobals());

describe("custom gateway structured output HTTP contract", () => {
  it.each([false, true])("sends the full strict schema (stream=%s)", async (stream) => {
    const requests = mockTransport();
    const output = modelOutputForJsonSchema(schema, "design_brief");
    const result = stream
      ? await streamModelTurn({ model: gateway(), messages, output })
      : await generateText({ model: gateway(), messages, output, maxRetries: 0 });

    expect(result.output).toEqual(value);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://custom-gateway.test/v1/chat/completions");
    expect(requests[0].headers.get("authorization")).toBe("Bearer test-key");
    expect(requests[0].headers.get("x-project")).toBe("test-project");
    expect(requests[0].body.model).toBe("openai/gpt-5.6-luna");
    expect(requests[0].body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "design_brief", strict: true, schema },
    });
  });

  it("keeps explicit JSON mode without a schema", async () => {
    const requests = mockTransport();
    await streamModelTurn({ model: gateway(), messages, output: Output.json() });
    expect(requests[0].body.response_format).toEqual({ type: "json_object" });
  });

  it("does not add a response format to ordinary text requests", async () => {
    const requests = mockTransport("Hello");
    const result = await streamModelTurn({ model: gateway(), messages });
    expect(result.text).toBe("Hello");
    expect(requests[0].body).not.toHaveProperty("response_format");
  });

  it.each(['{"goal":42,"constraints":[]}', '{"goal":"Site"}', "not JSON"])(
    "still rejects a nonconforming gateway response: %s", async (text) => {
      const requests = mockTransport(text);
      await expect(streamModelTurn({
        model: gateway(), messages, output: modelOutputForJsonSchema(schema),
      })).rejects.toThrow();
      expect(requests).toHaveLength(1);
      expect(requests[0].body.response_format.type).toBe("json_schema");
    },
  );

  it("preserves a provider schema error and never retries with JSON mode", async () => {
    const message = "Invalid schema: every property must be required";
    const requests = mockTransport("", message);
    await expect(streamModelTurn({
      model: gateway(), messages, output: modelOutputForJsonSchema(schema),
    })).rejects.toMatchObject({ statusCode: 400, message });
    expect(requests).toHaveLength(1);
    expect(requests[0].body.response_format.json_schema.strict).toBe(true);
  });

  it("does not silently rewrite optional properties or mutate the consumer schema", async () => {
    const optionalSchema = { ...schema, required: ["goal"] };
    const original = structuredClone(optionalSchema);
    const requests = mockTransport();
    await streamModelTurn({
      model: gateway(), messages, output: modelOutputForJsonSchema(optionalSchema),
    });
    expect(requests[0].body.response_format.json_schema.schema).toEqual(original);
    expect(optionalSchema).toEqual(original);
  });

  it("preserves required nullable fields and nested schemas", async () => {
    const nestedSchema = {
      ...schema,
      properties: {
        ...schema.properties,
        details: {
          anyOf: [
            { type: "null" },
            { type: "object", additionalProperties: false, properties: { note: { type: "string" } }, required: ["note"] },
          ],
        },
      },
      required: [...schema.required, "details"],
    };
    const requests = mockTransport(JSON.stringify({ ...value, details: null }));
    const result = await streamModelTurn({
      model: gateway(), messages, output: modelOutputForJsonSchema(nestedSchema),
    });
    expect(result.output).toEqual({ ...value, details: null });
    expect(requests[0].body.response_format.json_schema.schema).toEqual(nestedSchema);
  });
});
