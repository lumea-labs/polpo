import { describe, expect, it } from "vitest";
import { StructuredOutputDeltaGate } from "./model-output.js";

describe("StructuredOutputDeltaGate", () => {
  it("holds leading whitespace and streams a JSON turn delta by delta", () => {
    const gate = new StructuredOutputDeltaGate();
    expect(gate.push("\n  ")).toBeUndefined();
    expect(gate.streamed).toBe(false);
    expect(gate.push(' {"a"')).toBe('{"a"');
    expect(gate.push(": 1}")).toBe(": 1}");
    expect(gate.streamed).toBe(true);
  });

  it("streams top-level arrays", () => {
    const gate = new StructuredOutputDeltaGate();
    expect(gate.push("[1,")).toBe("[1,");
  });

  it("never streams a turn that opens with prose or a fence", () => {
    const prose = new StructuredOutputDeltaGate();
    expect(prose.push("Let me check ")).toBeUndefined();
    expect(prose.push('{"a":1}')).toBeUndefined();
    expect(prose.streamed).toBe(false);

    const fenced = new StructuredOutputDeltaGate();
    expect(fenced.push("```json\n{")).toBeUndefined();
    expect(fenced.streamed).toBe(false);
  });
});
