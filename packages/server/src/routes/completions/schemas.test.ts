import { describe, expect, it } from "vitest";
import { completionRequestSchema } from "./schemas.js";

const request = {
  messages: [{ role: "user" as const, content: "hello" }],
  agent: "support",
};

describe("completion request guardrail policy", () => {
  it("accepts only an explicit strict request policy", () => {
    expect(completionRequestSchema.parse({
      ...request,
      guardrails: { policyPack: "strict" },
    }).guardrails).toEqual({ policyPack: "strict" });
  });

  it.each([
    { policyPack: "standard" },
    { policyPack: "custom" },
    { policyPack: "strict", unknown: true },
    {},
    "strict",
  ])("rejects a non-monotonic or malformed request policy %#", (guardrails) => {
    expect(completionRequestSchema.safeParse({
      ...request,
      guardrails,
    }).success).toBe(false);
  });
});

describe("completion request sandbox lifecycle", () => {
  it.each([
    { isolation: "reuse" },
    { isolation: "shared", lifecycle: { onRelease: "pool" } },
    { isolation: "fresh", lifecycle: { onRelease: "pool" } },
    {
      isolation: "fresh",
      lifecycle: {
        onRelease: "pool",
        stopAfterIdleMinutes: 30,
        deleteAfterStopMinutes: 45,
      },
    },
    { lifecycle: { onRelease: "pool", deleteAfterStopMinutes: 0 } },
    { lifecycle: { onRelease: "pool", idleTtlMinutes: 30 } },
    { isolation: "reuse", lifecycle: { onRelease: "destroy" } },
  ])("accepts valid sandbox policy %#", (sandbox) => {
    expect(completionRequestSchema.parse({ ...request, sandbox }).sandbox).toEqual(sandbox);
  });

  it.each([
    { lifecycle: { onRelease: "archive" } },
    { lifecycle: { onRelease: "pool", idleTtlMinutes: 0 } },
    { lifecycle: { onRelease: "pool", idleTtlMinutes: 1.5 } },
    { lifecycle: { onRelease: "pool", idleTtlMinutes: 10_081 } },
    { lifecycle: { onRelease: "destroy", idleTtlMinutes: 10 } },
    { lifecycle: { onRelease: "destroy", stopAfterIdleMinutes: 10 } },
    { lifecycle: { onRelease: "destroy", deleteAfterStopMinutes: 10 } },
    { lifecycle: { onRelease: "pool", stopAfterIdleMinutes: 0 } },
    { lifecycle: { onRelease: "pool", deleteAfterStopMinutes: -1 } },
    { lifecycle: { onRelease: "pool", idleTtlMinutes: 10, stopAfterIdleMinutes: 10 } },
    { lifecycle: { onRelease: "pool", unknown: true } },
    { lifecycle: "pool" },
    { isolation: "reuse", unknown: true },
  ])("rejects malformed sandbox policy %#", (sandbox) => {
    expect(completionRequestSchema.safeParse({ ...request, sandbox }).success).toBe(false);
  });
});

describe("completion request response format", () => {
  it.each([
    { type: "text" },
    { type: "json_object" },
    {
      type: "json_schema",
      json_schema: {
        name: "user_profile",
        description: "A normalized user profile",
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
    },
  ])("accepts OpenAI-compatible response_format %#", (response_format) => {
    expect(completionRequestSchema.parse({
      ...request,
      response_format,
    }).response_format).toEqual(response_format);
  });

  it.each([
    { type: "json" },
    { type: "json_schema" },
    { type: "json_schema", json_schema: {} },
    { type: "json_schema", json_schema: { name: "has spaces", schema: {} } },
    { type: "json_schema", json_schema: { name: "x", schema: [] } },
    { type: "json_object", extra: true },
    null,
    "json_object",
  ])("rejects malformed response_format %#", (response_format) => {
    expect(completionRequestSchema.safeParse({
      ...request,
      response_format,
    }).success).toBe(false);
  });
});

describe("completion request tool-call history", () => {
  it("preserves OpenAI-compatible assistant tool calls and tool results", () => {
    const parsed = completionRequestSchema.parse({
      agent: "support",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "ask_user_question", arguments: "{\"questions\":[]}" },
          }],
        },
        {
          role: "tool",
          content: "answered",
          tool_call_id: "call_1",
          name: "ask_user_question",
        },
      ],
    });

    expect(parsed.messages[0]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call_1",
        type: "function",
        function: { name: "ask_user_question", arguments: "{\"questions\":[]}" },
      }],
    });
  });

  it("defaults omitted OpenAI tool arguments to an empty object string", () => {
    const parsed = completionRequestSchema.parse({
      agent: "support",
      messages: [{
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "tool_list" },
        }],
      }],
    });

    expect((parsed.messages[0] as any).tool_calls[0].function.arguments).toBe("{}");
  });
});

describe("completion request Polpo chat capabilities", () => {
  it("accepts explicit ask-user and suggestions support", () => {
    expect(completionRequestSchema.parse({
      ...request,
      polpo: {
        capabilities: {
          ask_user_question: true,
          suggestions: true,
        },
      },
    }).polpo).toEqual({
      capabilities: {
        ask_user_question: true,
        suggestions: true,
      },
    });
  });

  it.each([
    { capabilities: { suggestions: "yes" } },
    { capabilities: { unknown: true } },
    { capabilities: true },
    { capabilities: {}, extra: true },
    "suggestions",
  ])("rejects malformed Polpo capabilities %#", (polpo) => {
    expect(completionRequestSchema.safeParse({ ...request, polpo }).success).toBe(false);
  });
});
