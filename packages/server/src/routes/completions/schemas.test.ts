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
    { volumes: [] },
    { volumes: [{ name: "workspace", access: "read-write", writeBack: "manual" }] },
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
    { volumes: [{ name: "workspace", access: "read-only", writeBack: "auto" }] },
    { volumes: [{ name: "workspace" }, { name: "workspace" }] },
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

describe("completion request dynamic client tools", () => {
  const configureSiteModule = {
    type: "function" as const,
    function: {
      name: "configure_site_module",
      description: "Open the native module configuration dialog.",
      parameters: {
        type: "object",
        properties: {
          module: { type: "string" },
          siteId: { type: "string" },
        },
        required: ["module", "siteId"],
        additionalProperties: false,
      },
      strict: true,
    },
  };

  it.each([
    { tools: [configureSiteModule] },
    { tools: [configureSiteModule], tool_choice: "auto" },
    { tools: [configureSiteModule], tool_choice: "none" },
    { tools: [configureSiteModule], tool_choice: "required" },
    {
      tools: [configureSiteModule],
      tool_choice: {
        type: "function",
        function: { name: "configure_site_module" },
      },
      parallel_tool_calls: false,
    },
  ])("accepts OpenAI-compatible client tools %#", (input) => {
    expect(completionRequestSchema.parse({ ...request, ...input })).toMatchObject(input);
  });

  it("accepts a parameterless function with an omitted schema", () => {
    const parsed = completionRequestSchema.parse({
      ...request,
      tools: [{ type: "function", function: { name: "open_dialog" } }],
    });
    expect(parsed.tools?.[0]?.function).toEqual({ name: "open_dialog" });
  });

  it.each([
    {
      label: "invalid name",
      tools: [{ type: "function", function: { name: "has spaces" } }],
    },
    {
      label: "duplicate name",
      tools: [configureSiteModule, configureSiteModule],
    },
    {
      label: "non-object root",
      tools: [{
        type: "function",
        function: { name: "bad", parameters: { type: "array", items: { type: "string" } } },
      }],
    },
    {
      label: "external ref",
      tools: [{
        type: "function",
        function: { name: "bad", parameters: { type: "object", $ref: "https://example.com/schema.json" } },
      }],
    },
    {
      label: "prototype key",
      tools: [{
        type: "function",
        function: {
          name: "bad",
          parameters: JSON.parse('{"type":"object","properties":{"constructor":{"type":"string"}}}'),
        },
      }],
    },
    {
      label: "parallel client calls",
      tools: [configureSiteModule],
      parallel_tool_calls: true,
    },
    {
      label: "unknown forced function",
      tools: [configureSiteModule],
      tool_choice: { type: "function", function: { name: "missing" } },
    },
    {
      label: "tool choice without tools",
      tool_choice: "required",
    },
    {
      label: "client tools inside a loop",
      loop: "create-site",
      tools: [configureSiteModule],
    },
    {
      label: "unknown nested field",
      tools: [{ type: "function", function: { name: "bad", unknown: true } }],
    },
  ])("rejects $label", ({ label: _label, ...input }) => {
    expect(completionRequestSchema.safeParse({ ...request, ...input }).success).toBe(false);
  });

  it("rejects more than 64 client tools", () => {
    const tools = Array.from({ length: 65 }, (_, index) => ({
      type: "function",
      function: { name: `client_tool_${index}` },
    }));
    expect(completionRequestSchema.safeParse({ ...request, tools }).success).toBe(false);
  });

  it("rejects an aggregate tool declaration larger than 128 KiB", () => {
    expect(completionRequestSchema.safeParse({
      ...request,
      tools: [{
        type: "function",
        function: { name: "large", description: "x".repeat(128 * 1024) },
      }],
    }).success).toBe(false);
  });

  it("rejects pathologically deep schemas", () => {
    let schema: Record<string, unknown> = { type: "string" };
    for (let index = 0; index < 40; index += 1) {
      schema = { type: "object", properties: { nested: schema } };
    }
    expect(completionRequestSchema.safeParse({
      ...request,
      tools: [{ type: "function", function: { name: "deep", parameters: schema } }],
    }).success).toBe(false);
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

describe("completion request execution tool policy", () => {
  it("accepts an empty deny-all restriction and wildcard patterns", () => {
    expect(completionRequestSchema.parse({
      ...request,
      polpo: { execution: { allowedTools: [] } },
    }).polpo?.execution).toEqual({ allowedTools: [] });
    expect(completionRequestSchema.parse({
      ...request,
      polpo: { execution: { allowedTools: ["site_*", "ask_user_question"] } },
    }).polpo?.execution?.allowedTools).toEqual(["site_*", "ask_user_question"]);
  });

  it.each([
    { execution: { allowedTools: [""] } },
    { execution: { allowedTools: ["read", "READ"] } },
    { execution: { allowedTools: "read" } },
    { execution: { deniedTools: ["bash"] } },
  ])("rejects malformed execution tool policy %#", (polpo) => {
    expect(completionRequestSchema.safeParse({ ...request, polpo }).success).toBe(false);
  });
});

describe("completion request skill activation", () => {
  it("accepts one or more skills for the current execution", () => {
    expect(completionRequestSchema.parse({
      ...request,
      polpo: {
        skills: ["frontend-design", "accessibility-audit"],
      },
    }).polpo).toEqual({
      skills: ["frontend-design", "accessibility-audit"],
    });
  });

  it.each([
    { skills: [] },
    { skills: [""] },
    { skills: ["frontend-design", "frontend-design"] },
    { skills: "frontend-design" },
    { skills: ["frontend-design"], unknown: true },
  ])("rejects malformed skill activation %#", (polpo) => {
    expect(completionRequestSchema.safeParse({ ...request, polpo }).success).toBe(false);
  });
});

describe("completion request durable delivery", () => {
  it("accepts an explicit continue-on-disconnect policy", () => {
    expect(completionRequestSchema.parse({
      ...request,
      stream: true,
      polpo: { delivery: { onDisconnect: "continue" } },
    }).polpo?.delivery).toEqual({ onDisconnect: "continue" });
  });

  it("keeps delivery omitted for backward-compatible cancellation semantics", () => {
    expect(completionRequestSchema.parse(request).polpo?.delivery).toBeUndefined();
  });

  it.each([
    { delivery: { onDisconnect: "detach" } },
    { delivery: { onDisconnect: true } },
    { delivery: { onDisconnect: "continue", unknown: true } },
    { delivery: "continue" },
  ])("rejects malformed delivery policy %#", (polpo) => {
    expect(completionRequestSchema.safeParse({ ...request, polpo }).success).toBe(false);
  });
});

describe("completion request client-tool continuation", () => {
  const continuation = {
    type: "client_tool" as const,
    tool_call_id: "call_configure",
    expected_session_version: 2,
  };

  it("accepts exactly one tool result for an explicit durable project loop", () => {
    expect(completionRequestSchema.parse({
      messages: [{ role: "tool", tool_call_id: "call_configure", content: "configured" }],
      stream: true,
      agent: "leo",
      loop: "build-site",
      polpo: {
        continuation,
        delivery: { onDisconnect: "continue" },
      },
    }).polpo?.continuation).toEqual(continuation);
  });

  it("accepts exactly one tool result for a durable direct-chat continuation", () => {
    expect(completionRequestSchema.parse({
      messages: [{ role: "tool", tool_call_id: "call_configure", content: '{"cancelled":true}' }],
      stream: true,
      agent: "leo",
      polpo: {
        continuation,
        delivery: { onDisconnect: "continue" },
      },
    }).polpo?.continuation).toEqual(continuation);
  });

  it.each([
    {
      messages: [{ role: "user", content: "duplicate request" }],
      agent: "leo",
      loop: "build-site",
    },
    {
      messages: [
        { role: "tool", tool_call_id: "call_configure", content: "configured" },
        { role: "user", content: "duplicate request" },
      ],
      agent: "leo",
      loop: "build-site",
    },
    {
      messages: [{ role: "tool", tool_call_id: "other", content: "configured" }],
      agent: "leo",
      loop: "build-site",
    },
    {
      messages: [{ role: "tool", tool_call_id: "call_configure", content: "configured" }],
      loop: "build-site",
    },
  ])("rejects malformed or underspecified continuation %#", (input) => {
    expect(completionRequestSchema.safeParse({
      ...input,
      stream: true,
      polpo: {
        continuation,
        delivery: { onDisconnect: "continue" },
      },
    }).success).toBe(false);
  });

  it.each([
    { stream: false, delivery: { onDisconnect: "continue" } },
    { stream: true, delivery: { onDisconnect: "cancel" } },
    { stream: true, delivery: undefined },
  ])("requires durable streaming execution %#", ({ stream, delivery }) => {
    expect(completionRequestSchema.safeParse({
      messages: [{ role: "tool", tool_call_id: "call_configure", content: "configured" }],
      stream,
      agent: "leo",
      loop: "build-site",
      polpo: { continuation, ...(delivery ? { delivery } : {}) },
    }).success).toBe(false);
  });
});
