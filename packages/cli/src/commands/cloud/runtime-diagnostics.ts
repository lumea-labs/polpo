import { writeFile } from "node:fs/promises";
import type { Command } from "commander";
import pc from "picocolors";
import { createApiClient } from "./api.js";
import {
  addEnvironmentOptions,
  resolveCliEnvironment,
  type EnvironmentOptions,
} from "./environment.js";
import { loadProjectId } from "./project-context.js";
import { requireAuth } from "../../util/auth.js";
import { friendlyError } from "../../util/errors.js";

function runtimeDiagnosticsPath(runId: string, suffix = ""): string {
  return `/v1/runtime/diagnostics/runs/${encodeURIComponent(runId)}${suffix}`;
}

async function context(opts: EnvironmentOptions & { dir?: string }) {
  const credentials = await requireAuth({
    context: "Runtime diagnostics require an authenticated session.",
  });
  const projectId = loadProjectId(opts.dir ?? ".");
  if (!projectId) throw new Error("No project linked. Run polpo create or polpo link first.");
  return {
    client: createApiClient(credentials, projectId, resolveCliEnvironment(opts)),
  };
}

export function registerRuntimeDiagnosticsCommands(program: Command): void {
  const runtime = program.command("runtime")
    .description("Inspect admitted runtime contracts and sanitized Run evidence");

  addEnvironmentOptions(runtime.command("inspect <run-id>"))
    .description("Inspect one Run plan, provider warnings, receipts, and stall decisions")
    .option("-d, --dir <path>", "Project directory", ".")
    .option("--json", "Print the full sanitized diagnostic record")
    .action(async (runId, opts) => {
      try {
        const { client } = await context(opts);
        const response = await client.get<any>(runtimeDiagnosticsPath(runId));
        if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
        const value = response.data?.data ?? response.data;
        if (opts.json) {
          console.log(JSON.stringify(value, null, 2));
          return;
        }
        console.log(pc.bold(`Run ${runId}`));
        console.log(`Phase: ${value?.phase ?? "unknown"}`);
        console.log(`Model route: ${value?.modelRoute ?? "unknown"}`);
        console.log(`Active tools: ${Array.isArray(value?.activeTools) ? value.activeTools.join(", ") || "none" : "unknown"}`);
        console.log(`Warnings: ${Array.isArray(value?.warnings) ? value.warnings.length : 0}`);
        console.log(`Receipts: ${Array.isArray(value?.receipts) ? value.receipts.length : 0}`);
        console.log(`Terminal outcome: ${value?.outcome?.code ?? value?.outcome?.status ?? "unknown"}`);
      } catch (error) {
        console.error(pc.red(friendlyError(error instanceof Error ? error.message : String(error))));
        process.exitCode = 1;
      }
    });

  addEnvironmentOptions(runtime.command("export-replay <run-id>"))
    .description("Export the host-sanitized replay record for one Run")
    .requiredOption("-o, --output <file>", "Output JSON path")
    .option("-d, --dir <path>", "Project directory", ".")
    .action(async (runId, opts) => {
      try {
        const { client } = await context(opts);
        const response = await client.get<any>(runtimeDiagnosticsPath(runId, "/replay"));
        if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
        const value = response.data?.data ?? response.data;
        await writeFile(opts.output, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
        console.log(pc.green(`Sanitized replay written to ${opts.output}`));
      } catch (error) {
        console.error(pc.red(friendlyError(error instanceof Error ? error.message : String(error))));
        process.exitCode = 1;
      }
    });
}
