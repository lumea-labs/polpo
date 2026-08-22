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
