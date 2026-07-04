import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  // Load .env, .env.test, etc. into process.env (empty prefix = all vars)
  const env = loadEnv(mode, process.cwd(), "");
  return {
    test: {
      env,
      // Some suites bootstrap the full server stack (orchestrator + SSE
      // bridge + app) in beforeAll via dynamic imports; under a saturated
      // worker pool that hook already takes ~9-11s, so the default 10s
      // hookTimeout flakes depending on file scheduling. Assertion/test
      // timeouts stay at their defaults.
      hookTimeout: 30_000,
    },
  };
});
