import { describe, expect, it } from "vitest";
import {
  resolveAllowedToolPolicy,
  toolNameAllowedByPolicy,
} from "./tool-policy.js";

describe("tool execution policy", () => {
  it("leaves tools unrestricted when every policy layer is omitted", () => {
    const policy = resolveAllowedToolPolicy({});

    expect(policy.restricted).toBe(false);
    expect(toolNameAllowedByPolicy("site_checkout", policy)).toBe(true);
  });

  it("intersects global, mode, execution, loop, and step constraints", () => {
    const policy = resolveAllowedToolPolicy({
      global: ["site_*", "ask_user_question"],
      mode: ["site_context_get", "site_checkout", "site_validate"],
      execution: ["site_checkout", "site_validate"],
      loop: ["site_context_get", "site_checkout"],
      step: ["site_checkout"],
    });

    expect(toolNameAllowedByPolicy("site_checkout", policy)).toBe(true);
    expect(toolNameAllowedByPolicy("site_context_get", policy)).toBe(false);
    expect(toolNameAllowedByPolicy("site_validate", policy)).toBe(false);
    expect(toolNameAllowedByPolicy("ask_user_question", policy)).toBe(false);
  });

  it("treats an explicit empty layer as deny-all", () => {
    const policy = resolveAllowedToolPolicy({
      global: ["site_*"],
      execution: [],
    });

    expect(policy.restricted).toBe(true);
    expect(toolNameAllowedByPolicy("site_checkout", policy)).toBe(false);
  });

  it("matches tool names case-insensitively and supports bounded star wildcards", () => {
    const policy = resolveAllowedToolPolicy({
      global: ["MCP__CMS__*", "site_?_get"],
    });

    expect(toolNameAllowedByPolicy("mcp__cms__publish", policy)).toBe(true);
    expect(toolNameAllowedByPolicy("SITE_X_GET", policy)).toBe(true);
    expect(toolNameAllowedByPolicy("site_long_get", policy)).toBe(false);
  });

  it("treats hyphens and regular-expression syntax as literal tool-name characters", () => {
    const policy = resolveAllowedToolPolicy({
      global: [
        "mcp__insforge__fetch-docs",
        "tool.with+(syntax)[v2]",
      ],
    });

    expect(toolNameAllowedByPolicy("mcp__insforge__fetch-docs", policy)).toBe(true);
    expect(toolNameAllowedByPolicy("mcp__insforge__fetchXdocs", policy)).toBe(false);
    expect(toolNameAllowedByPolicy("tool.with+(syntax)[v2]", policy)).toBe(true);
    expect(toolNameAllowedByPolicy("toolXwithhhhhsyntaxv", policy)).toBe(false);
  });

  it("supports wildcards around literal hyphens without broadening the match", () => {
    const policy = resolveAllowedToolPolicy({
      global: ["mcp__insforge__fetch-*", "mcp__?-server__read"],
    });

    expect(toolNameAllowedByPolicy("mcp__insforge__fetch-docs", policy)).toBe(true);
    expect(toolNameAllowedByPolicy("mcp__insforge__fetch-schema-v2", policy)).toBe(true);
    expect(toolNameAllowedByPolicy("mcp__x-server__read", policy)).toBe(true);
    expect(toolNameAllowedByPolicy("mcp__xx-server__read", policy)).toBe(false);
    expect(toolNameAllowedByPolicy("mcp__insforge__list-docs", policy)).toBe(false);
  });

  it("compiles every printable ASCII tool-name character safely", () => {
    const wildcardCharacters = new Set(["*", "?"]);

    for (let codePoint = 33; codePoint <= 126; codePoint += 1) {
      const character = String.fromCodePoint(codePoint);
      if (wildcardCharacters.has(character)) continue;
      const toolName = `mcp__provider__tool${character}name`;
      const policy = resolveAllowedToolPolicy({ global: [toolName] });

      expect(
        toolNameAllowedByPolicy(toolName, policy),
        `failed to match ASCII U+${codePoint.toString(16).padStart(4, "0")}`,
      ).toBe(true);
    }
  });

  it("does not let a narrower execution layer add a globally denied tool", () => {
    const policy = resolveAllowedToolPolicy({
      global: ["site_context_get"],
      execution: ["site_changes_submit"],
    });

    expect(toolNameAllowedByPolicy("site_context_get", policy)).toBe(false);
    expect(toolNameAllowedByPolicy("site_changes_submit", policy)).toBe(false);
  });

  it("records named layers without exposing mutable policy arrays", () => {
    const source = ["site_checkout"];
    const policy = resolveAllowedToolPolicy({ global: source });
    source.push("site_changes_submit");

    expect(policy.layers).toEqual([{ name: "global", allowedTools: ["site_checkout"] }]);
    expect(Object.isFrozen(policy.layers)).toBe(true);
    expect(Object.isFrozen(policy.layers[0]?.allowedTools)).toBe(true);
  });

  it("rejects malformed policy entries before model or tool resolution", () => {
    expect(() => resolveAllowedToolPolicy({
      global: ["site_checkout", ""],
    })).toThrow("global.allowedTools[1]");
    expect(() => resolveAllowedToolPolicy({
      global: ["site_checkout", "SITE_CHECKOUT"],
    })).toThrow("duplicate");
  });
});
