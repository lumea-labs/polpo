import { describe, it, expect } from "vitest";
import { slugify } from "../src/util/slugify.js";

describe("slugify", () => {
  describe("happy path", () => {
    it("passes through a simple lowercase word unchanged", () => {
      expect(slugify("foo")).toBe("foo");
    });

    it("lowercases uppercase input", () => {
      expect(slugify("FOO")).toBe("foo");
    });

    it("replaces a single space with a single hyphen", () => {
      expect(slugify("hello world")).toBe("hello-world");
    });

    it("keeps digits", () => {
      expect(slugify("v2-agent")).toBe("v2-agent");
    });

    it("handles mixed case + numbers + spaces", () => {
      expect(slugify("My Agent 1")).toBe("my-agent-1");
    });
  });

  describe("edge cases", () => {
    it("returns 'project' for empty string", () => {
      expect(slugify("")).toBe("project");
    });

    it("returns 'project' for whitespace only", () => {
      expect(slugify("   ")).toBe("project");
    });

    it("returns 'project' for symbol-only input", () => {
      expect(slugify("!!!")).toBe("project");
      expect(slugify("---")).toBe("project");
      expect(slugify("?/\\")).toBe("project");
    });

    it("collapses multiple non-alphanumerics into a single hyphen", () => {
      expect(slugify("hello   world")).toBe("hello-world");
      expect(slugify("hello___world")).toBe("hello-world");
      expect(slugify("hello.-.world")).toBe("hello-world");
    });

    it("strips leading and trailing hyphens", () => {
      expect(slugify("-hello-")).toBe("hello");
      expect(slugify("  hello  ")).toBe("hello");
      expect(slugify("!hello!")).toBe("hello");
    });

    it("replaces unicode accents with hyphens (no normalization)", () => {
      // Regex drops non a-z0-9 chars, so accents become separators
      expect(slugify("caffè")).toBe("caff");
      expect(slugify("ça va")).toBe("a-va");
    });

    it("drops emoji", () => {
      expect(slugify("hello 🐙 world")).toBe("hello-world");
      expect(slugify("🚀")).toBe("project");
    });

    it("handles dots, slashes, and path separators", () => {
      expect(slugify("src/cli/index.ts")).toBe("src-cli-index-ts");
      expect(slugify("../foo")).toBe("foo");
    });

    it("is idempotent on already-slugified input", () => {
      const once = slugify("My Cool Project");
      const twice = slugify(once);
      expect(once).toBe(twice);
    });

    it("handles single character", () => {
      expect(slugify("a")).toBe("a");
      expect(slugify("1")).toBe("1");
      expect(slugify("!")).toBe("project");
    });

    it("handles very long strings", () => {
      const long = "a".repeat(500);
      expect(slugify(long)).toBe(long);
    });

    it("handles newlines and tabs", () => {
      expect(slugify("hello\nworld")).toBe("hello-world");
      expect(slugify("hello\tworld")).toBe("hello-world");
    });
  });
});
