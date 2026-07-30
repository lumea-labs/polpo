import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseConfig, generatePolpoConfigDefault, savePolpoConfig } from "../core/config.js";

const TMP = "/tmp/polpo-config-test";
const POLPO_DIR = join(TMP, ".polpo");

/** Write a polpo.json config and return the workDir (TMP). */
function writeConfig(config: object): string {
  mkdirSync(POLPO_DIR, { recursive: true });
  writeFileSync(join(POLPO_DIR, "polpo.json"), JSON.stringify(config, null, 2));
  return TMP;
}

/** Minimal valid config for reuse. */
function minimalConfig() {
  return {
    project: "test-project",
    team: {
      name: "test-team",
      agents: [
        { name: "agent-1" },
      ],
    },
    settings: {
      maxRetries: 3,
      workDir: ".",
      logLevel: "normal",
    },
  };
}

describe("parseConfig (.polpo/polpo.json)", () => {
  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  // ────────────────────────────────────────────────────
  // Happy paths
  // ────────────────────────────────────────────────────

  describe("happy paths", () => {
    it("parses a valid minimal config", async () => {
      const workDir = writeConfig(minimalConfig());
      const config = await parseConfig(workDir);

      expect(config.version).toBe("1");
      expect(config.project).toBe("test-project");
      expect(config.teams).toEqual([]); // teams come from stores, not polpo.json
      expect(config.tasks).toEqual([]);
    });

    it("parses config with full settings", async () => {
      const cfg = {
        ...minimalConfig(),
        settings: {
          maxRetries: 5,
          workDir: "/tmp/work",
          logLevel: "verbose",
          taskTimeout: 120000,
          staleThreshold: 60000,
          orchestratorModel: "claude-sonnet-4-5-20250929",
        },
      };
      const workDir = writeConfig(cfg);
      const config = await parseConfig(workDir);

      expect(config.settings.maxRetries).toBe(5);
      expect(config.settings.workDir).toBe("/tmp/work");
      expect(config.settings.logLevel).toBe("verbose");
      expect(config.settings.taskTimeout).toBe(120000);
      expect(config.settings.staleThreshold).toBe(60000);
      expect(config.settings.orchestratorModel).toBe("claude-sonnet-4-5-20250929");
    });

    it("parses model profiles and an explicit orchestrator profile reference", async () => {
      const cfg = {
        ...minimalConfig(),
        settings: {
          ...minimalConfig().settings,
          orchestratorModel: { profile: "balanced" },
          modelProfiles: {
            fast: "openai/gpt-4o-mini",
            balanced: {
              primary: "anthropic/claude-sonnet-4",
              fallbacks: [{ profile: "fast" }],
            },
          },
        },
      };

      const config = await parseConfig(writeConfig(cfg));

      expect(config.settings.orchestratorModel).toEqual({ profile: "balanced" });
      expect(config.settings.modelProfiles).toEqual(cfg.settings.modelProfiles);
    });

    it.each([
      { modelProfiles: [] },
      { modelProfiles: { "reasoning/high": "openai/gpt-4o-mini" } },
      { modelProfiles: { fast: { profile: "" } } },
      { modelProfiles: { fast: { primary: 42 } } },
    ])("rejects malformed model profile settings: %j", async (invalid) => {
      const cfg = {
        ...minimalConfig(),
        settings: {
          ...minimalConfig().settings,
          ...invalid,
        },
      };

      await expect(parseConfig(writeConfig(cfg))).rejects.toThrow(/Invalid modelProfiles/);
    });

    it.each([
      { orchestratorModel: "" },
      { orchestratorModel: null },
      { orchestratorModel: { profile: "fast", primary: "openai/gpt-4o-mini" } },
      { orchestratorModel: { primary: "openai/gpt-4o-mini", arbitrary: true } },
    ])("rejects malformed orchestrator model settings: %j", async (invalid) => {
      const cfg = {
        ...minimalConfig(),
        settings: {
          ...minimalConfig().settings,
          ...invalid,
        },
      };

      await expect(parseConfig(writeConfig(cfg))).rejects.toThrow(/Invalid orchestratorModel/);
    });

    it("ignores teams in polpo.json — returns empty teams", async () => {
      const cfg = {
        ...minimalConfig(),
        team: {
          name: "multi-team",
          agents: [
            { name: "coder" },
            { name: "engine-dev" },
            { name: "custom-dev" },
          ],
        },
      };
      const workDir = writeConfig(cfg);
      const config = await parseConfig(workDir);

      expect(config.teams).toEqual([]); // teams come from stores only
    });

    it("defaults logLevel to 'normal' when settings are missing", async () => {
      const cfg = { ...minimalConfig() };
      delete (cfg as any).settings;
      const workDir = writeConfig(cfg);
      const config = await parseConfig(workDir);
      expect(config.settings.logLevel).toBe("normal");
    });

    it("defaults workDir to '.' when settings are missing", async () => {
      const cfg = { ...minimalConfig() };
      delete (cfg as any).settings;
      const workDir = writeConfig(cfg);
      const config = await parseConfig(workDir);
      expect(config.settings.workDir).toBe(".");
    });

    it("defaults chat completions to the shared run lifecycle", async () => {
      const workDir = writeConfig(minimalConfig());
      const config = await parseConfig(workDir);
      expect(config.settings.chatExecution).toBe("run");
    });

    it("keeps context trust off unless enforcement is explicit", async () => {
      const defaultConfig = await parseConfig(writeConfig(minimalConfig()));
      expect(defaultConfig.settings.contextTrust).toBe("off");

      const enforcedDir = writeConfig({
        ...minimalConfig(),
        settings: { ...minimalConfig().settings, contextTrust: "enforce" },
      });
      expect((await parseConfig(enforcedDir)).settings.contextTrust).toBe("enforce");

      const unknownDir = writeConfig({
        ...minimalConfig(),
        settings: { ...minimalConfig().settings, contextTrust: "future" },
      });
      expect((await parseConfig(unknownDir)).settings.contextTrust).toBe("off");
    });

    it("keeps inline chat execution only when explicitly requested", async () => {
      const cfg = {
        ...minimalConfig(),
        settings: { ...minimalConfig().settings, chatExecution: "inline" },
      };
      const workDir = writeConfig(cfg);
      const config = await parseConfig(workDir);
      expect(config.settings.chatExecution).toBe("inline");
    });

    it("keeps runtime tool guardrails off unless a policy pack is explicit", async () => {
      const workDir = writeConfig(minimalConfig());
      const config = await parseConfig(workDir);

      expect(config.settings.guardrails).toBeUndefined();
    });

    it("parses the explicit serializable runtime tool guardrail settings", async () => {
      const cfg = {
        ...minimalConfig(),
        settings: {
          ...minimalConfig().settings,
          guardrails: {
            toolPolicyPack: "default",
            maxToolOutputCharacters: 4096,
            readOnlyPolicyFailure: "block",
          },
        },
      };
      const workDir = writeConfig(cfg);
      const config = await parseConfig(workDir);

      expect(config.settings.guardrails).toEqual({
        toolPolicyPack: "default",
        maxToolOutputCharacters: 4096,
        readOnlyPolicyFailure: "block",
      });
    });

    it("parses output guardrails independently and defaults streaming to audit", async () => {
      const cfg = {
        ...minimalConfig(),
        settings: {
          ...minimalConfig().settings,
          guardrails: {
            outputPolicyPack: "default",
            maxFinalOutputCharacters: 8192,
          },
        },
      };
      const workDir = writeConfig(cfg);
      const config = await parseConfig(workDir);

      expect(config.settings.guardrails).toEqual({
        outputPolicyPack: "default",
        maxFinalOutputCharacters: 8192,
        streamingOutputMode: "audit",
      });
    });

    it("accepts logLevel 'quiet'", async () => {
      const cfg = {
        ...minimalConfig(),
        settings: { ...minimalConfig().settings, logLevel: "quiet" },
      };
      const workDir = writeConfig(cfg);
      const config = await parseConfig(workDir);
      expect(config.settings.logLevel).toBe("quiet");
    });

    it("accepts logLevel 'verbose'", async () => {
      const cfg = {
        ...minimalConfig(),
        settings: { ...minimalConfig().settings, logLevel: "verbose" },
      };
      const workDir = writeConfig(cfg);
      const config = await parseConfig(workDir);
      expect(config.settings.logLevel).toBe("verbose");
    });

    it("parses provider overrides (baseUrl/api/models only)", async () => {
      const cfg = {
        ...minimalConfig(),
        providers: {
          ollama: { baseUrl: "http://localhost:11434/v1", api: "openai-completions" },
          custom: { baseUrl: "https://my-vllm.example.com/v1" },
        },
      };
      const workDir = writeConfig(cfg);
      const config = await parseConfig(workDir);
      expect(config.providers).toBeDefined();
      expect(config.providers!.ollama.baseUrl).toBe("http://localhost:11434/v1");
      expect(config.providers!.ollama.api).toBe("openai-completions");
      expect(config.providers!.custom.baseUrl).toBe("https://my-vllm.example.com/v1");
    });

    it("ignores provider entries that only have apiKey (no custom config)", async () => {
      const cfg = {
        ...minimalConfig(),
        providers: {
          anthropic: { apiKey: "sk-test" },
          openai: "sk-openai-test",
          ollama: { baseUrl: "http://localhost:11434/v1" },
        },
      };
      const workDir = writeConfig(cfg);
      const config = await parseConfig(workDir);
      expect(config.providers).toBeDefined();
      // Only ollama should remain — it has baseUrl
      expect(config.providers!.ollama).toBeDefined();
      expect(config.providers!.ollama.baseUrl).toBe("http://localhost:11434/v1");
      // anthropic had only apiKey, openai was a string — both skipped
      expect(config.providers!.anthropic).toBeUndefined();
      expect(config.providers!.openai).toBeUndefined();
    });
  });

  // ────────────────────────────────────────────────────
  // Error cases
  // ────────────────────────────────────────────────────

  describe("error cases", () => {
    it("throws when .polpo/polpo.json is missing", async () => {
      mkdirSync(POLPO_DIR, { recursive: true });
      // Don't write polpo.json
      await expect(parseConfig(TMP)).rejects.toThrow(/No configuration found/);
    });

    it("ignores agents in polpo.json without validation", async () => {
      const cfg = {
        ...minimalConfig(),
        team: {
          name: "team",
          agents: [{}], // no name — but parseConfig no longer validates
        },
      };
      const workDir = writeConfig(cfg);
      const config = await parseConfig(workDir);
      expect(config.teams).toEqual([]); // ignored
    });

    it("throws on invalid logLevel", async () => {
      const cfg = {
        ...minimalConfig(),
        settings: { ...minimalConfig().settings, logLevel: "debug" },
      };
      const workDir = writeConfig(cfg);
      await expect(parseConfig(workDir)).rejects.toThrow(
        'Invalid logLevel "debug": must be quiet, normal, or verbose',
      );
    });

    it.each([
      ["unknown pack", { toolPolicyPack: "custom" }],
      ["zero output limit", { toolPolicyPack: "default", maxToolOutputCharacters: 0 }],
      ["fractional output limit", { toolPolicyPack: "default", maxToolOutputCharacters: 1.5 }],
      ["invalid read fallback", { toolPolicyPack: "default", readOnlyPolicyFailure: "allow" }],
      ["unknown output pack", { outputPolicyPack: "custom" }],
      ["zero final output limit", { outputPolicyPack: "default", maxFinalOutputCharacters: 0 }],
      ["invalid streaming mode", { outputPolicyPack: "default", streamingOutputMode: "enforce" }],
      ["orphan streaming mode", { streamingOutputMode: "buffer" }],
    ])("rejects invalid guardrail settings: %s", async (_label, guardrails) => {
      const cfg = {
        ...minimalConfig(),
        settings: { ...minimalConfig().settings, guardrails },
      };
      const workDir = writeConfig(cfg);

      await expect(parseConfig(workDir)).rejects.toThrow(/guardrails\./);
    });
  });
});

describe("generatePolpoConfigDefault", () => {
  it("returns a valid config with project name", () => {
    const config = generatePolpoConfigDefault("my-project");
    expect(config.project).toBe("my-project");
    expect(config.teams).toEqual([]); // agents/teams live in separate store files
    expect(config.settings.maxRetries).toBe(3);
    expect(config.settings.logLevel).toBe("normal");
    expect(config.settings.chatExecution).toBe("run");
    expect(config.settings.contextTrust).toBe("off");
  });

  it("round-trips through savePolpoConfig and parseConfig", async () => {
    mkdirSync(join(TMP, ".polpo"), { recursive: true });
    const config = generatePolpoConfigDefault("round-trip");
    savePolpoConfig(join(TMP, ".polpo"), config);

    const parsed = await parseConfig(TMP);
    expect(parsed.project).toBe("round-trip");
    expect(parsed.teams).toEqual([]); // teams come from stores, not polpo.json
    expect(parsed.settings.maxRetries).toBe(3);
    expect(parsed.settings.chatExecution).toBe("run");
  });
});
