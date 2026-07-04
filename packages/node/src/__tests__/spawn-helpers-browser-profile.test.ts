import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { prepareSpawn } from "../adapters/spawn-helpers.js";
import type { AgentConfig } from "@polpo-ai/core";

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
