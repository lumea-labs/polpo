import { describe, expect, it, vi } from "vitest";
import {
  LOOP_AGENT_INPUT_MAX_BYTES,
  LoopAgentInputError,
  prepareLoopAgentInput,
} from "./agent-input.js";

describe("prepareLoopAgentInput", () => {
  it("resolves nested context bindings and preserves static values", () => {
    const prepared = prepareLoopAgentInput(
      {
        failures: { $context: "validation.failures" },
        attempt: 2,
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["failures", "attempt"],
        properties: {
          failures: { type: "array", minItems: 1 },
          attempt: { type: "integer", minimum: 1 },
        },
      },
      { validation: { failures: [{ path: "index.ts", message: "broken" }] } },
    );

    expect(prepared.value).toEqual({
      failures: [{ path: "index.ts", message: "broken" }],
      attempt: 2,
    });
    expect(prepared.diagnostics).toMatchObject({
      schemaValidated: true,
      bindingCount: 1,
      bindingPaths: [{ inputPath: "$.failures", contextPath: "validation.failures" }],
    });
    expect(prepared.diagnostics.bytes).toBeGreaterThan(0);
    expect(prepared.diagnostics.hash).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
    expect(Object.isFrozen(prepared.value)).toBe(true);
    expect(Object.isFrozen((prepared.value as any).failures)).toBe(true);
  });

  it("fails closed when a binding is missing", () => {
    expect(() => prepareLoopAgentInput(
      { failures: { $context: "validation.failures" } },
      undefined,
      {},
    )).toThrowError(expect.objectContaining({
      code: "loop_binding_missing",
      contextPath: "validation.failures",
      inputPath: "$.failures",
    }));
  });

  it("rejects values that do not satisfy the input schema", () => {
    expect(() => prepareLoopAgentInput(
      { failures: [], attempt: 0 },
      {
        type: "object",
        required: ["failures", "attempt"],
        properties: {
          failures: { type: "array", minItems: 1 },
          attempt: { type: "integer", minimum: 1 },
        },
      },
      {},
    )).toThrowError(expect.objectContaining({
      name: "LoopAgentInputError",
      code: "loop_agent_input_invalid",
    }));
  });

  it.each([
    [null],
    ["not-a-schema"],
    [{ $ref: "https://example.com/schema.json" }],
    [{ $async: true, type: "object" }],
  ])("rejects a malformed or unresolved schema: %j", (schema) => {
    expect(() => prepareLoopAgentInput({}, schema, {})).toThrowError(
      expect.objectContaining({ code: "loop_agent_input_invalid" }),
    );
  });

  it("rejects hostile schema objects without evaluating accessors", () => {
    const read = vi.fn(() => ({ type: "string" }));
    const schema = { type: "object" } as Record<string, unknown>;
    Object.defineProperty(schema, "properties", { enumerable: true, get: read });

    expect(() => prepareLoopAgentInput({}, schema, {})).toThrowError(
      expect.objectContaining({ code: "loop_agent_input_invalid" }),
    );
    expect(read).not.toHaveBeenCalled();
  });

  it("accepts unicode and measures the UTF-8 payload size", () => {
    const prepared = prepareLoopAgentInput({ instruction: "Correggi 🧰" }, undefined, {});
    expect(prepared.diagnostics.bytes).toBe(
      new TextEncoder().encode(prepared.serialized).byteLength,
    );
  });

  it("accepts the exact byte limit and rejects one byte over it", () => {
    const prefixBytes = new TextEncoder().encode('{"value":""}').byteLength;
    const exact = "a".repeat(LOOP_AGENT_INPUT_MAX_BYTES - prefixBytes);
    expect(prepareLoopAgentInput({ value: exact }, undefined, {}).diagnostics.bytes)
      .toBe(LOOP_AGENT_INPUT_MAX_BYTES);

    expect(() => prepareLoopAgentInput({ value: `${exact}a` }, undefined, {}))
      .toThrowError(expect.objectContaining({ code: "loop_agent_input_too_large" }));
  });

  it("rejects circular, sparse, accessor, prototype-polluting, and non-JSON inputs", () => {
    const circular: any = {};
    circular.self = circular;
    const sparse = new Array(2);
    sparse[1] = "x";
    const accessor = {};
    Object.defineProperty(accessor, "secret", { enumerable: true, get: () => "x" });

    const cases: unknown[] = [
      circular,
      sparse,
      accessor,
      { value: Number.NaN },
      { value: BigInt(1) },
      { value: new Date() },
      { value: { $context: "validation.__proto__.x" } },
    ];
    for (const input of cases) {
      expect(() => prepareLoopAgentInput(input, undefined, { validation: {} }))
        .toThrowError(expect.objectContaining({ code: "loop_binding_invalid" }));
    }
  });

  it("clones context values so later mutations cannot change prepared input", () => {
    const failures = [{ message: "before" }];
    const prepared = prepareLoopAgentInput(
      { failures: { $context: "validation.failures" } },
      undefined,
      { validation: { failures } },
    );
    failures[0]!.message = "after";
    expect(prepared.value).toEqual({ failures: [{ message: "before" }] });
  });
});
