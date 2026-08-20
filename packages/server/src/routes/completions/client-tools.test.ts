import { describe, expect, it } from "vitest";

import {
  RequestClientToolError,
  assertRequestClientToolNamesAvailable,
  createRequestClientTools,
  requestToolChoiceToAI,
  selectRequestClientToolCall,
} from "./client-tools.js";

const requestTool = (name = "configure_site_module") => ({
  type: "function" as const,
  function: {
    name,
    description: "Open the module configuration UI.",
    parameters: {
      type: "object",
      properties: {
        module: { type: "string" },
      },
      required: ["module"],
      additionalProperties: false,
    },
    strict: true,
  },
});

function capturedError(run: () => void): RequestClientToolError {
  try {
    run();
  } catch (error) {
    if (error instanceof RequestClientToolError) return error;
    throw error;
  }
  throw new Error("Expected RequestClientToolError");
}

describe("request-scoped client tools", () => {
  it("maps OpenAI function tools to return-only AI SDK tools", () => {
    const tools = createRequestClientTools([requestTool()]);

    expect(Object.keys(tools)).toEqual(["configure_site_module"]);
    expect(tools.configure_site_module).toMatchObject({
      description: "Open the module configuration UI.",
      strict: true,
      inputSchema: {
        jsonSchema: {
          type: "object",
          properties: { module: { type: "string" } },
          required: ["module"],
          additionalProperties: false,
        },
      },
    });
    expect(tools.configure_site_module).not.toHaveProperty("execute");
  });

  it("uses a closed empty object schema for parameterless functions", () => {
    const tools = createRequestClientTools([{
      type: "function",
      function: { name: "open_dialog" },
    }]);

    expect(tools.open_dialog.inputSchema).toMatchObject({
      jsonSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    });
  });

  it("rejects collisions with any effective tool name case-insensitively", () => {
    const error = capturedError(() => assertRequestClientToolNamesAvailable(
      [requestTool("Configure_Site_Module")],
      ["configure_site_module", "bash"],
    ));
    expect(error).toMatchObject({
      code: "tool_name_conflict",
      toolName: "Configure_Site_Module",
    });
  });

  it("accepts request tools that do not overlap the effective palette", () => {
    expect(() => assertRequestClientToolNamesAvailable(
      [requestTool()],
      ["bash", "tool_search", "ask_user_question"],
    )).not.toThrow();
  });

  it.each([
    ["auto", "auto"],
    ["none", "none"],
    ["required", "required"],
    [
      { type: "function", function: { name: "configure_site_module" } },
      { type: "tool", toolName: "configure_site_module" },
    ],
  ])("maps OpenAI tool_choice %# to AI SDK tool choice", (choice, expected) => {
    expect(requestToolChoiceToAI(choice as any)).toEqual(expected);
  });

  it("returns the only client-side call without executing it", () => {
    const call = {
      toolCallId: "call_1",
      toolName: "configure_site_module",
      input: { module: "commerce" },
    };

    expect(selectRequestClientToolCall([call], new Set([call.toolName]))).toBe(call);
  });

  it("returns undefined when the turn contains no client-side call", () => {
    expect(selectRequestClientToolCall([
      { toolCallId: "call_1", toolName: "bash", input: {} },
    ], new Set(["configure_site_module"]))).toBeUndefined();
  });

  it("fails closed when a client-side call is mixed with another call", () => {
    const error = capturedError(() => selectRequestClientToolCall([
      { toolCallId: "call_1", toolName: "configure_site_module", input: {} },
      { toolCallId: "call_2", toolName: "bash", input: {} },
    ], new Set(["configure_site_module"])));
    expect(error).toMatchObject({
      code: "parallel_client_tool_calls_returned",
    });
  });
});
