import * as fs from "node:fs";
import * as path from "node:path";
import type { Command } from "commander";
import * as clack from "@clack/prompts";
import pc from "picocolors";
import { validateRuntimeHookPack, type RuntimeHookPack } from "@polpo-ai/core/runtime-hooks";
import { createApiClient } from "./api.js";
import { addEnvironmentOptions, resolveCliEnvironment } from "./environment.js";
import { loadProjectId } from "./project-context.js";
import { requireAuth } from "../../util/auth.js";

function hookFiles(root: string): string[] {
  const directory = path.resolve(root, ".polpo", "hooks");
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => path.join(directory, name));
}

function loadHookPack(file: string): RuntimeHookPack {
  const pack = validateRuntimeHookPack(JSON.parse(fs.readFileSync(file, "utf8")));
  const expected = path.basename(file, ".json");
  if (pack.name !== expected) throw new Error(`Pack name ${JSON.stringify(pack.name)} must match ${JSON.stringify(expected)}`);
  return pack;
}

export function registerHooksCommand(program: Command): void {
  const hooks = program.command("hooks").description("Validate and inspect runtime hook packs");

  hooks.command("validate")
    .description("Validate .polpo/hooks/*.json")
    .option("-d, --dir <path>", "Project directory", ".")
    .action((opts: { dir: string }) => {
      const files = hookFiles(opts.dir);
      if (files.length === 0) {
        clack.log.info("No runtime hook packs found in .polpo/hooks.");
        return;
      }
      let failures = 0;
      for (const file of files) {
        try {
          const pack = loadHookPack(file);
          clack.log.success(`${path.relative(opts.dir, file)} ${pc.dim(`(${pack.hooks.length} hooks)`)}`);
        } catch (error) {
          failures += 1;
          clack.log.error(`${path.relative(opts.dir, file)} — ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (failures > 0) process.exitCode = 1;
    });

  addEnvironmentOptions(hooks.command("list"))
    .description("List deployed runtime hook packs")
    .option("-d, --dir <path>", "Project directory", ".")
    .option("--local", "List local packs instead of deployed packs")
    .action(async (opts: { dir: string; local?: boolean; env?: string; prod?: boolean }) => {
      if (opts.local) {
        const packs = hookFiles(opts.dir).map(loadHookPack);
        if (packs.length === 0) clack.log.info("No local runtime hook packs.");
        for (const pack of packs) clack.log.info(`${pack.name}\t${pack.hooks.length} hooks`);
        return;
      }
      const credentials = await requireAuth({ context: "Listing runtime hooks requires an authenticated session." });
      const projectId = loadProjectId(opts.dir);
      if (!projectId) throw new Error("No project linked in this directory");
      const client = createApiClient(credentials, projectId, resolveCliEnvironment(opts));
      const response = await client.get<{ ok?: boolean; data?: RuntimeHookPack[] }>("/v1/hooks");
      if (response.status !== 200) throw new Error(`Hooks API returned ${response.status}`);
      const packs = response.data.data ?? [];
      if (packs.length === 0) clack.log.info("No deployed runtime hook packs.");
      for (const pack of packs) clack.log.info(`${pack.name}\t${pack.hooks.length} hooks`);
    });
}
