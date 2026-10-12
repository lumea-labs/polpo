import { describe, expect, it } from "vitest";
import { connectionRequiresSecret, type ConnectionRecord } from "../index.js";

describe("Connection credential requirement", () => {
  it.each([
    ["none", undefined, false],
    ["api_key", undefined, true],
    ["oauth2", undefined, true],
    ["mcp", { auth: "none" }, false],
    ["mcp", { auth: "bearer" }, true],
    ["mcp", { auth: "header" }, true],
    ["mcp", { auth: "oauth2" }, true],
    ["mcp", undefined, true],
    ["mcp", { auth: "unsupported" }, true],
  ] as const)("classifies %s / %j without treating unknown MCP auth as public", (authType, metadata, required) => {
    expect(connectionRequiresSecret({ authType, metadata } as Pick<ConnectionRecord, "authType" | "metadata">)).toBe(required);
  });
});
