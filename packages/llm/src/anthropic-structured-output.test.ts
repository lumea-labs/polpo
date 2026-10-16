import { afterEach, describe, expect, it, vi } from "vitest";
import { Output, generateText, jsonSchema } from "ai";
import { createProviderRuntimeAdapter } from "./provider-runtime-adapter.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Anthropic reasoning with structured output", () => {
  it("uses Haiku native output_format instead of a forced JSON tool", async () => {
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-haiku-4-5",
        content: [
          { type: "thinking", thinking: "Checked the schema.", signature: "sig_test" },
          { type: "text", text: '{"decision":"accept"}' },
        ],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 8 },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    const adapter = createProviderRuntimeAdapter({
      apiKeyResolver: () => "test-anthropic-key",
    });
    const ref = { provider: "anthropic", model: "claude-haiku-4-5" };
    const model = await adapter.createLanguageModel({ ref, context: {} });
    const providerOptions = await adapter.buildProviderOptions?.({
      ref,
      context: {},
      reasoning: "medium",
      maxOutputTokens: 2048,
    });

    const result = await generateText({
      model,
      prompt: "Return the decision.",
      maxRetries: 0,
      maxOutputTokens: 2048,
      providerOptions: providerOptions as any,
      output: Output.object({
        name: "decision",
        schema: jsonSchema({
          type: "object",
          properties: { decision: { type: "string", enum: ["accept", "reject"] } },
          required: ["decision"],
          additionalProperties: false,
        }),
      }),
    });

    expect(result.output).toEqual({ decision: "accept" });
    expect(requestBody).toMatchObject({
      model: "claude-haiku-4-5",
      thinking: { type: "enabled", budget_tokens: 1024 },
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            required: ["decision"],
            additionalProperties: false,
          },
        },
      },
    });
    expect(requestBody).not.toHaveProperty("tools");
    expect(requestBody).not.toHaveProperty("tool_choice");
  });
});
