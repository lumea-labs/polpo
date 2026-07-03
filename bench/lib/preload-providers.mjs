/**
 * bench/lib/preload-providers.mjs — provider-override glue for task runner subprocesses.
 *
 * WHY THIS EXISTS (verified on the current runtime, v0.10.x dist build):
 * `providers` overrides from `.polpo/polpo.json` are applied via
 * `setProviderOverrides()` **in the orchestrator process only**. The task
 * runner is a detached Node subprocess (dist/core/runner.js) that never reads
 * polpo.json and never receives the overrides (RunnerConfig has no
 * `providers` field, SpawnContext has no `gatewayConfig`). Without this glue,
 * an agent with model "bench/mock-1" fails inside the runner with
 * "No LLM gateway configured and no API key found for provider bench".
 *
 * The benchmark harness injects this file into every spawned Node process via
 * `NODE_OPTIONS="--import <this file>"`, replaying the same overrides that
 * polpo.json declares (passed as JSON in POLPO_BENCH_PROVIDERS). On a runtime
 * that propagates providers correctly this is a harmless no-op re-set of the
 * same values — the benchmark itself stays black-box.
 *
 * POLPO_BENCH_LLM_DIST must point at the runtime's llm entry (the module
 * instance the engine actually imports), e.g. <repo>/dist/llm/pi-client.js.
 */

const providersJson = process.env.POLPO_BENCH_PROVIDERS;
const llmModulePath = process.env.POLPO_BENCH_LLM_DIST;

if (providersJson && llmModulePath) {
  try {
    const { pathToFileURL } = await import("node:url");
    const mod = await import(pathToFileURL(llmModulePath).href);
    if (typeof mod.setProviderOverrides === "function") {
      mod.setProviderOverrides(JSON.parse(providersJson));
    }
  } catch {
    // Best-effort: if the module moved (different runtime), stay silent —
    // the run will fail loudly on its own and the README explains this knob.
  }
}
