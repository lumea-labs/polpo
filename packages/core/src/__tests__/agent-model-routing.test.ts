import { describe, expect, it } from "vitest";
import { validateAgentModelRoutingConfig } from "../model-router.js";

describe("validateAgentModelRoutingConfig", () => {
  it.each([
    undefined,
    { mode: "off" as const },
    { mode: "auto" as const },
  ])("accepts a supported model routing mode %#", (config) => {
    expect(validateAgentModelRoutingConfig(config)).toEqual(config);
  });

  it.each([
    null,
    "auto",
    [],
    {},
    { mode: "future" },
    { mode: "auto", hidden: true },
  ])("rejects unsafe agent model routing config %#", (config) => {
    expect(() => validateAgentModelRoutingConfig(config)).toThrow(
      /Agent model routing/,
    );
  });
});
