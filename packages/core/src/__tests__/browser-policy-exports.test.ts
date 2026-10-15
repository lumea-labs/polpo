import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

// Use the browser bundler already supplied by Vite. Resolve through its own
// dependency boundary instead of assuming a hoisted esbuild installation.
const require = createRequire(import.meta.url);
const vitestRequire = createRequire(require.resolve("vitest/package.json"));
const { build } = createRequire(vitestRequire.resolve("vite"))("esbuild");
const coreRoot = fileURLToPath(new URL("../../", import.meta.url));

describe("public policy subpaths used by browser environment dashboards", () => {
  it("bundles the published entrypoints without Node shims and executes them in a browser-like global", async () => {
    const bundle = await build({ absWorkingDir: coreRoot, bundle: true, platform: "browser", format: "iife",
      write: false, treeShaking: false, metafile: true, logLevel: "silent", stdin: {
        resolveDir: coreRoot, sourcefile: "browser-consumer.js", contents: `
          import { projectEnvironmentBaseUrl } from '@polpo-ai/core/project-environment';
          import { MAX_MODEL_FALLBACKS, normalizeModelPolicy } from '@polpo-ai/core/model-policy';
          import { resolveConfiguredModelSelection } from '@polpo-ai/core/model-profiles';
          import { SANDBOX_IDLE_TTL_MINUTES_MAX } from '@polpo-ai/core/runtime-sandbox';
          import { AUDIO_MODEL_CATALOG, DEFAULT_TTS_MODEL } from '@polpo-ai/core/agent-models';
          import { normalizeAgentMemorySettings } from '@polpo-ai/core/memory-settings';
          globalThis.result = {
            development: projectEnvironmentBaseUrl('https://api.example.test', 'development'),
            production: projectEnvironmentBaseUrl('https://api.example.test', 'production'),
            limit: MAX_MODEL_FALLBACKS,
            candidates: normalizeModelPolicy({ primary: 'vendor/a', fallbacks: ['vendor/b', 'vendor/b'] }).candidates,
            selected: resolveConfiguredModelSelection('vendor/a', {}).policy.primary,
            sandboxTtl: SANDBOX_IDLE_TTL_MINUTES_MAX,
            audioDefaultExists: AUDIO_MODEL_CATALOG.some(model => model.id === DEFAULT_TTS_MODEL),
            memory: normalizeAgentMemorySettings(undefined),
          };
        `,
      } });
    const sandbox: { result?: Record<string, unknown>; URL: typeof URL } = { URL };
    vm.runInNewContext(bundle.outputFiles[0].text, sandbox);
    expect(sandbox.result).toMatchObject({ development: "https://api.example.test/environments/development",
      production: "https://api.example.test/environments/production", limit: 3,
      candidates: ["vendor/a", "vendor/b"], selected: "vendor/a", sandboxTtl: 10080, audioDefaultExists: true });
    expect(Object.keys(bundle.metafile.inputs).some(path => /skills-reader|project-layout|dist\/index\.js$/.test(path))).toBe(false);
  });
});
