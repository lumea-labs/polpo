import { describe, expect, it } from "vitest";
import {
  MAX_PERSISTED_REASONING_BYTES,
  preparePersistedReasoning,
} from "./session-store.js";

describe("preparePersistedReasoning", () => {
  it("preserves a reasoning summary below the byte limit", () => {
    expect(preparePersistedReasoning("Checked the constraints.")).toEqual({
      text: "Checked the constraints.",
    });
  });

  it("omits empty values", () => {
    expect(preparePersistedReasoning("")).toBeUndefined();
    expect(preparePersistedReasoning(undefined)).toBeUndefined();
  });

  it("truncates by UTF-8 bytes without splitting a code point", () => {
    expect(preparePersistedReasoning("ab😀cd", 5)).toEqual({
      text: "ab",
      truncated: true,
    });
  });

  it("bounds the default payload to 64 KiB", () => {
    const result = preparePersistedReasoning("x".repeat(MAX_PERSISTED_REASONING_BYTES + 1));
    expect(result?.text).toHaveLength(MAX_PERSISTED_REASONING_BYTES);
    expect(result?.truncated).toBe(true);
  });
});
