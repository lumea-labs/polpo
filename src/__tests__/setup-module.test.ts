import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// ── env-persistence ────────────────────────────────────────────────

describe("env-persistence", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `polpo-test-env-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it("creates directory and .env file if they don't exist", async () => {
    const { persistToEnvFile } = await import("../setup/env-persistence.js");
    const polpoDir = join(testDir, ".polpo");

    persistToEnvFile(polpoDir, "OPENAI_API_KEY", "sk-test123");

    expect(existsSync(join(polpoDir, ".env"))).toBe(true);
    const content = readFileSync(join(polpoDir, ".env"), "utf-8");
    expect(content).toBe("OPENAI_API_KEY=sk-test123\n");
  });

  it("upserts existing env var without duplicating", async () => {
    const { persistToEnvFile } = await import("../setup/env-persistence.js");
    const polpoDir = join(testDir, ".polpo");
    mkdirSync(polpoDir, { recursive: true });
    writeFileSync(join(polpoDir, ".env"), "OPENAI_API_KEY=old-key\nOTHER=keep\n");

    persistToEnvFile(polpoDir, "OPENAI_API_KEY", "new-key");

    const content = readFileSync(join(polpoDir, ".env"), "utf-8");
    expect(content).toContain("OPENAI_API_KEY=new-key");
    expect(content).toContain("OTHER=keep");
    // Must not duplicate
    expect(content.match(/OPENAI_API_KEY/g)?.length).toBe(1);
  });

  it("appends new env var to existing file", async () => {
    const { persistToEnvFile } = await import("../setup/env-persistence.js");
    const polpoDir = join(testDir, ".polpo");
    mkdirSync(polpoDir, { recursive: true });
    writeFileSync(join(polpoDir, ".env"), "EXISTING=value\n");

    persistToEnvFile(polpoDir, "NEW_KEY", "new-value");

    const content = readFileSync(join(polpoDir, ".env"), "utf-8");
    expect(content).toContain("EXISTING=value");
    expect(content).toContain("NEW_KEY=new-value");
  });

  it("removeFromEnvFile removes a key", async () => {
    const { persistToEnvFile, removeFromEnvFile } = await import("../setup/env-persistence.js");
    const polpoDir = join(testDir, ".polpo");
    mkdirSync(polpoDir, { recursive: true });
    writeFileSync(join(polpoDir, ".env"), "KEEP=yes\nREMOVE_ME=secret\nALSO_KEEP=yes\n");

    removeFromEnvFile(polpoDir, "REMOVE_ME");

    const content = readFileSync(join(polpoDir, ".env"), "utf-8");
    expect(content).toContain("KEEP=yes");
    expect(content).toContain("ALSO_KEEP=yes");
    expect(content).not.toContain("REMOVE_ME");
  });

  it("removeFromEnvFile is a no-op if file doesn't exist", async () => {
    const { removeFromEnvFile } = await import("../setup/env-persistence.js");
    // Should not throw
    removeFromEnvFile(join(testDir, "nonexistent"), "FOO");
  });
});


// ── hasOAuthProfilesForProvider (OAuth removed — always returns false) ──

describe("hasOAuthProfilesForProvider", () => {
  it("always returns false (OAuth removed)", async () => {
    const { hasOAuthProfilesForProvider } = await import("../setup/providers.js");
    expect(hasOAuthProfilesForProvider("openai-codex")).toBe(false);
    expect(hasOAuthProfilesForProvider("anthropic")).toBe(false);
  });
});


// ── auth-options (OAuth removed — only manual API key) ──────────

describe("auth-options", () => {
  it("getAuthOptions returns manual API key option only", async () => {
    const { getAuthOptions } = await import("../setup/index.js");
    const options = getAuthOptions();

    expect(options.length).toBe(1);

    const manualOption = options.find((o) => o.type === "api_key");
    expect(manualOption).toBeDefined();
  });

  it("FREE_OAUTH_PROVIDERS is empty (OAuth removed)", async () => {
    const { FREE_OAUTH_PROVIDERS } = await import("../setup/index.js");
    expect(FREE_OAUTH_PROVIDERS.size).toBe(0);
  });
});

// ── oauth-flow (OAuth removed — stubs) ──────────────────────────

describe("oauth-flow stubs", () => {
  it("findOAuthProvider always returns undefined", async () => {
    const { findOAuthProvider } = await import("../setup/index.js");
    expect(findOAuthProvider("anthropic")).toBeUndefined();
    expect(findOAuthProvider("openai-codex")).toBeUndefined();
  });

  it("getOAuthProviderList returns empty list", async () => {
    const { getOAuthProviderList } = await import("../setup/index.js");
    expect(getOAuthProviderList()).toEqual([]);
  });

  it("startOAuthLogin always rejects", async () => {
    const { startOAuthLogin } = await import("../setup/index.js");

    await expect(
      startOAuthLogin("anthropic", {
        onAuthUrl: () => {},
        onPrompt: async () => "",
        onProgress: () => {},
      })
    ).rejects.toThrow("OAuth login has been removed");
  });
});

// ── models ─────────────────────────────────────────────────────────

describe("models", () => {
  it("formatCost returns 'free' for 0", async () => {
    const { formatCost } = await import("../setup/models.js");
    expect(formatCost(0)).toBe("free");
  });

  it("formatCost formats sub-dollar costs with 2 decimals", async () => {
    const { formatCost } = await import("../setup/models.js");
    expect(formatCost(0.25)).toBe("$0.25/M");
    expect(formatCost(0.5)).toBe("$0.50/M");
  });

  it("formatCost formats dollar+ costs as integers", async () => {
    const { formatCost } = await import("../setup/models.js");
    expect(formatCost(3)).toBe("$3/M");
    expect(formatCost(15)).toBe("$15/M");
  });

  it("modelLabel returns structured data without formatting", async () => {
    const { modelLabel } = await import("../setup/models.js");

    const result = modelLabel({
      name: "test-model",
      id: "test-model",
      provider: "test",
      reasoning: true,
      cost: { input: 3, output: 15 },
    } as any);

    expect(result.name).toBe("test-model");
    expect(result.tags).toContain("reasoning");
    expect(result.costStr).toContain("$3/M");
    expect(result.costStr).toContain("$15/M");
  });

  it("modelLabel marks free models", async () => {
    const { modelLabel } = await import("../setup/models.js");

    const result = modelLabel({
      name: "free-model",
      id: "free-model",
      provider: "test",
      reasoning: false,
      cost: { input: 0, output: 0 },
    } as any);

    expect(result.tags).toContain("free");
    expect(result.costStr).toBe("");
  });

  it("getProviderModels returns sorted models", async () => {
    const { getProviderModels } = await import("../setup/models.js");

    const models = getProviderModels("anthropic");
    if (models.length >= 2) {
      for (let i = 1; i < models.length; i++) {
        expect(models[i].cost.input).toBeGreaterThanOrEqual(models[i - 1].cost.input);
      }
    }
  });
});

// ── Integration: CLI and server use the same detectProviders ───────

describe("integration: shared module consistency", () => {
  it("setup/index.ts re-exports all expected symbols", async () => {
    const setup = await import("../setup/index.js");

    // Providers
    expect(typeof setup.detectProviders).toBe("function");
    expect(typeof setup.hasOAuthProfilesForProvider).toBe("function");

    // Env persistence
    expect(typeof setup.persistToEnvFile).toBe("function");
    expect(typeof setup.removeFromEnvFile).toBe("function");

    // Auth options
    expect(typeof setup.getAuthOptions).toBe("function");
    expect(setup.FREE_OAUTH_PROVIDERS).toBeDefined();

    // OAuth flow
    expect(typeof setup.findOAuthProvider).toBe("function");
    expect(typeof setup.getOAuthProviderList).toBe("function");
    expect(typeof setup.startOAuthLogin).toBe("function");

    // Models
    expect(typeof setup.getProviderModels).toBe("function");
    expect(typeof setup.formatCost).toBe("function");
    expect(typeof setup.modelLabel).toBe("function");
  });

  it("detectProviders returns consistent shape regardless of caller", async () => {
    const { detectProviders } = await import("../setup/index.js");
    const providers = detectProviders();

    for (const p of providers) {
      // Every provider must have all required fields
      expect(typeof p.name).toBe("string");
      expect(p.envVar === undefined || typeof p.envVar === "string").toBe(true);
      expect(typeof p.hasKey).toBe("boolean");
      expect(["env", "none"]).toContain(p.source);
    }
  });
});
