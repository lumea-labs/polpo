import { describe, expect, it } from "vitest";

import {
  createSingleFileCustomToolArtifact,
  parseCustomToolSourceArtifact,
} from "../custom-tool-source-artifact.js";

describe("custom tool source artifacts", () => {
  it("normalizes a valid, sorted multi-file artifact", () => {
    const artifact = parseCustomToolSourceArtifact({
      version: 1,
      entry: "site_context_get.ts",
      files: {
        "site_context_get.ts": "export { value } from './lib/value';",
        "lib/value.ts": "export const value = 1;",
      },
    });

    expect(artifact).toEqual({
      version: 1,
      entry: "site_context_get.ts",
      files: {
        "lib/value.ts": "export const value = 1;",
        "site_context_get.ts": "export { value } from './lib/value';",
      },
    });
    expect(Object.isFrozen(artifact)).toBe(true);
    expect(Object.isFrozen(artifact.files)).toBe(true);
  });

  it("creates the compatibility artifact for a single source", () => {
    expect(createSingleFileCustomToolArtifact("echo", "export default {};"))
      .toEqual({
        version: 1,
        entry: "echo.ts",
        files: { "echo.ts": "export default {};" },
      });
  });

  it.each([
    "/absolute.ts",
    "../escape.ts",
    "nested/../../escape.ts",
    "nested\\windows.ts",
    "./dot.ts",
    "nested//empty.ts",
    "node_modules/pkg.ts",
    "evil;touch-pwned.ts",
    "quoted'name.ts",
    "bad.txt",
  ])("rejects unsafe or unsupported path %s", (path) => {
    expect(() => parseCustomToolSourceArtifact({
      version: 1,
      entry: path,
      files: { [path]: "export {};" },
    })).toThrow();
  });

  it("rejects unknown fields, a missing entry, and case-insensitive collisions", () => {
    expect(() => parseCustomToolSourceArtifact({
      version: 1,
      entry: "entry.ts",
      files: { "entry.ts": "export {};" },
      hash: "untrusted",
    })).toThrow(/unsupported/i);
    expect(() => parseCustomToolSourceArtifact({
      version: 1,
      entry: "entry.ts",
      files: { "other.ts": "export {};" },
    })).toThrow(/entry/i);
    expect(() => parseCustomToolSourceArtifact({
      version: 1,
      entry: "Entry.ts",
      files: {
        "Entry.ts": "export {};",
        "entry.ts": "export {};",
      },
    })).toThrow(/collision/i);
  });

  it("rejects non-string, empty, oversized, and excessive source graphs", () => {
    expect(() => parseCustomToolSourceArtifact({
      version: 1,
      entry: "entry.ts",
      files: { "entry.ts": 1 },
    })).toThrow(/string/i);
    expect(() => parseCustomToolSourceArtifact({
      version: 1,
      entry: "entry.ts",
      files: {},
    })).toThrow(/at least one/i);
    expect(() => parseCustomToolSourceArtifact({
      version: 1,
      entry: "entry.ts",
      files: { "entry.ts": "x".repeat(2 * 1024 * 1024 + 1) },
    })).toThrow(/bytes/i);
    expect(() => parseCustomToolSourceArtifact({
      version: 1,
      entry: "f0.ts",
      files: Object.fromEntries(Array.from({ length: 129 }, (_, index) => [
        `f${index}.ts`,
        "export {};",
      ])),
    })).toThrow(/128/i);
  });
});
