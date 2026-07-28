import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { prepareSpawn } from "../adapters/spawn-helpers.js";
import type { AgentConfig } from "@polpo-ai/core";
import type { RuntimeContextResolution } from "@polpo-ai/core/runtime-context";

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

describe("runtime context prompt", () => {
  it("is absent by default and appended exactly once when provided", () => {
    const baseline = prepareSpawn(agent, "/proj", ctx).systemPrompt;
    const runtimeContext: RuntimeContextResolution = {
      segments: [{
        kind: "memory",
        entries: [{
          id: "memory-1",
          content: "Use the customer's preferred report format.",
          source: { type: "memory", id: "memory-1" },
          timestamp: "2026-07-28T10:00:00.000Z",
          trust: "user_provided",
          estimatedTokens: 11,
        }],
      }],
      audit: {
        resolvedAt: "2026-07-28T10:00:00.000Z",
        tokenBudget: 1_000,
        estimatedTokens: 50,
        candidateEntries: 1,
        selectedEntries: 1,
        droppedEntries: 0,
      },
    };

    const withContext = prepareSpawn(agent, "/proj", {
      ...ctx,
      runtimeContext,
    }).systemPrompt;

    expect(baseline).not.toContain("## Retrieved Memory");
    expect(withContext).toContain("## Retrieved Memory");
    expect(withContext.match(/## Retrieved Memory/g)).toHaveLength(1);
    expect(withContext).toContain("preferred report format");
  });
});
