import { describe, expect, it } from "vitest";
import { normalizeRuntimeMetadata, sameRuntimeMetadata } from "../runtime-metadata.js";

describe("caller metadata snapshots", () => {
  it("compares independent JSON/JSONB key orderings without changing special keys", () => {
    const source = JSON.parse('{"connectionNamespace":"app-a","__proto__":"data","z":"last","A":"first"}');
    const captured = normalizeRuntimeMetadata(source)!;
    source.connectionNamespace = "mutated";
    expect(captured.connectionNamespace).toBe("app-a");
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.getPrototypeOf(captured)).toBe(Object.prototype);
    expect(Object.hasOwn(captured, "__proto__")).toBe(true);
    expect(sameRuntimeMetadata(captured, JSON.parse('{"A":"first","z":"last","__proto__":"data","connectionNamespace":"app-a"}'))).toBe(true);
    expect(sameRuntimeMetadata(captured, source)).toBe(false);
    expect(sameRuntimeMetadata(undefined, {})).toBe(false);
  });
});
