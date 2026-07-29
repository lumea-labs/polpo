import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { prepareSpawn } from "../adapters/spawn-helpers.js";
import type { AgentConfig } from "@polpo-ai/core";

// resolveModel needs a provider key; CI has no secrets by design.
process.env.ANTHROPIC_API_KEY ||= "test-key-not-real";

const agent = { name: "navigator", description: "", model: "anthropic/claude-sonnet-4-5", allowedTools: ["browser_navigate"] } as unknown as AgentConfig;
const ctx = { polpoDir: "/proj/.polpo" } as any;

describe("browser profile root override", () => {
  afterEach(() => { delete process.env.POLPO_BROWSER_PROFILES_ROOT; });

  it("defaults under polpoDir", () => {
    const prep = prepareSpawn(agent, "/proj", ctx);
    expect(prep.browserProfileDir).toBe(join("/proj/.polpo", "browser-profiles", "navigator"));
  });

  it("relocates via POLPO_BROWSER_PROFILES_ROOT (Chrome needs symlink-capable fs)", () => {
    process.env.POLPO_BROWSER_PROFILES_ROOT = "/home/daytona/.polpo/browser-profiles";
    const prep = prepareSpawn(agent, "/proj", ctx);
    expect(prep.browserProfileDir).toBe(join("/home/daytona/.polpo/browser-profiles", "navigator"));
  });
});

describe("task runtime model profiles", () => {
  it("expands a profile before provider adaptation and preserves fallback order", () => {
    const profiledAgent = {
      ...agent,
      model: { profile: "balanced" },
      allowedModelProfiles: ["balanced", "fast"],
    } as unknown as AgentConfig;
    const prep = prepareSpawn(profiledAgent, "/proj", {
      ...ctx,
      modelProfiles: {
        fast: "openai/gpt-4o-mini",
        balanced: {
          primary: "anthropic/claude-sonnet-4-5",
          fallbacks: [{ profile: "fast" }],
        },
      },
    });

    expect(prep.model.provider).toBe("anthropic");
    expect(prep.modelSelection).toEqual({
      primary: "anthropic/claude-sonnet-4-5",
      fallbacks: ["openai/gpt-4o-mini"],
    });
  });

  it("rejects an unknown profile before any runtime work begins", () => {
    expect(() => prepareSpawn({
      ...agent,
      model: { profile: "missing" },
    } as unknown as AgentConfig, "/proj", {
      ...ctx,
      modelProfiles: {},
    })).toThrowError(expect.objectContaining({
      code: "UNKNOWN_PROFILE",
      profile: "missing",
    }));
  });

  it("enforces the project model allowlist after profile expansion", () => {
    expect(() => prepareSpawn({
      ...agent,
      model: { profile: "balanced" },
      allowedModelProfiles: ["balanced"],
    } as unknown as AgentConfig, "/proj", {
      ...ctx,
      modelProfiles: {
        balanced: "anthropic/claude-sonnet-4-5",
      },
      modelAllowlist: {
        "openai/gpt-4o-mini": {},
      },
    })).toThrowError(expect.objectContaining({
      code: "DISALLOWED_MODEL",
      model: "anthropic/claude-sonnet-4-5",
    }));
  });
});
