import { describe, expect, it } from "vitest";
import {
  admitCanonicalToolContract,
  canonicalContractFingerprint,
} from "./canonical-tool-contract.js";

describe("canonical tool contracts", () => {
  it("produces stable order-independent fingerprints without mutating input", () => {
    const first = admitCanonicalToolContract({
      name: "lookup",
      parameters: {
        type: "object",
        properties: { b: { type: "number" }, a: { type: "string" } },
        required: ["a"],
      },
      annotations: { idempotentHint: true, readOnlyHint: true },
    });
    const second = admitCanonicalToolContract({
      name: "lookup",
      parameters: {
        required: ["a"],
        properties: { a: { type: "string" }, b: { type: "number" } },
        type: "object",
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    });

    expect(second.inputSchemaFingerprint).toBe(first.inputSchemaFingerprint);
    expect(second.definitionFingerprint).toBe(first.definitionFingerprint);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.inputSchema)).toBe(true);
    expect(Object.isFrozen((first.inputSchema.properties as any).a)).toBe(true);
  });

  it("changes the definition fingerprint for schema, strictness, or execution changes", () => {
    const base = admitCanonicalToolContract({
      name: "write",
      parameters: { type: "object", properties: {} },
    });
    const changed = [
      admitCanonicalToolContract({
        name: "write",
        parameters: { type: "object", properties: { value: { type: "string" } } },
      }),
      admitCanonicalToolContract({
        name: "write",
        parameters: { type: "object", properties: {} },
        strictness: "provider-required",
      }),
      admitCanonicalToolContract({
        name: "write",
        parameters: { type: "object", properties: {} },
        execution: "client",
      }),
    ];
    expect(changed.every((contract) =>
      contract.definitionFingerprint !== base.definitionFingerprint
    )).toBe(true);
  });

  it("rejects non-JSON and cyclic definitions", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => admitCanonicalToolContract({ name: "bad", parameters: cyclic }))
      .toThrow(/cyclic/);
    expect(() => canonicalContractFingerprint({ value: Number.NaN }))
      .toThrow(/finite/);
  });
});
