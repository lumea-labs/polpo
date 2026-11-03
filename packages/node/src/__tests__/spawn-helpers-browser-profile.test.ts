import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

describe("database tool loading", () => {
  it.each(["database_read", "database_*"])("loads extended capabilities for %s", (name) => {
    const prep = prepareSpawn({ ...agent, allowedTools: [name] }, "/proj", ctx);
    expect(prep.hasExtendedTools).toBe(true);
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

describe("task skill activation prompt", () => {
  it("prioritizes only explicitly selected skills without hiding other assignments", () => {
    const root = mkdtempSync(join(tmpdir(), "polpo-task-skills-"));
    const polpoDir = join(root, ".polpo");
    try {
      for (const [name, marker] of [["general", "GENERAL_MARKER"], ["testing", "TESTING_MARKER"]]) {
        const directory = join(polpoDir, "skills", name);
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\n---\n${marker}\n`);
      }
      const skillAgent = {
        ...agent,
        skills: ["general", "testing"],
      } as unknown as AgentConfig;
      const prompt = prepareSpawn(skillAgent, root, {
        polpoDir,
        activatedSkills: ["testing"],
      }).systemPrompt;

      expect(prompt).toContain("TESTING_MARKER");
      expect(prompt).toContain("GENERAL_MARKER");
      expect(prompt.indexOf("TESTING_MARKER")).toBeLessThan(prompt.indexOf("GENERAL_MARKER"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails before model setup when an activated assignment has no installed bundle", () => {
    expect(() => prepareSpawn({
      ...agent,
      skills: ["missing-skill"],
    } as unknown as AgentConfig, "/proj", {
      ...ctx,
      activatedSkills: ["missing-skill"],
    })).toThrow(/bundle is not installed/i);
  });
});

describe("task runtime model profiles", () => {
  it("expands a profile before provider adaptation and preserves fallback order", () => {
    const profiledAgent = {
      ...agent,
      model: { profile: "balanced" },
      allowedModelProfiles: ["balanced"],
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
