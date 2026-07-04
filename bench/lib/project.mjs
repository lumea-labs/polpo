/**
 * bench/lib/project.mjs — throwaway bench project scaffolding.
 *
 * Shared by run.mjs (local mode) and lib/crash-resume.mjs (which needs its
 * own project dir + child-hosted server it can SIGKILL). One writer keeps
 * polpo.json / agents.json conventions in a single place.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Write a minimal bench project into `dir/.polpo`.
 *
 * @param {string} dir project root
 * @param {number} mockPort mock LLM port (provider baseUrl override)
 * @param {{ executionMode?: "subprocess" | "in-process" | null }} [opts]
 *   executionMode — when set, written as `settings.taskExecution` so the
 *   SAME scenarios run under either execution backend (adaptive isolation,
 *   settings tier). Omitted → runtime default (subprocess).
 */
export function writeProject(dir, mockPort, { executionMode = null } = {}) {
  const polpoDir = join(dir, ".polpo");
  mkdirSync(polpoDir, { recursive: true });
  writeFileSync(
    join(polpoDir, "polpo.json"),
    JSON.stringify(
      {
        project: "polpo-bench",
        settings: {
          storage: "file",
          maxRetries: 0, // failures must be terminal — no silent retries mid-benchmark
          workDir: ".",
          logLevel: "quiet",
          ...(executionMode ? { taskExecution: executionMode } : {}),
        },
        // NOTE: the provider is named "openai" (with a baseUrl override) instead
        // of a dedicated "bench" provider because the runtime's pre-spawn
        // validation (validateProviderKeys) only accepts providers present in
        // the static PROVIDER_ENV_MAP — unknown custom providers can never
        // spawn task agents. See bench/README.md, "Runtime findings".
        providers: {
          openai: { baseUrl: `http://127.0.0.1:${mockPort}/v1` },
        },
      },
      null,
      2,
    ),
  );
  // FileAgentStore format: [{ agent: AgentConfig, teamName }]
  writeFileSync(
    join(polpoDir, "agents.json"),
    JSON.stringify(
      [
        {
          agent: { name: "bench-agent", role: "developer", model: "openai/mock-1", maxTurns: 250 },
          teamName: "bench",
        },
        {
          agent: { name: "bench-capped", role: "developer", model: "openai/mock-1", maxTurns: 15 },
          teamName: "bench",
        },
      ],
      null,
      2,
    ),
  );
}
