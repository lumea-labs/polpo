import * as fs from "node:fs";
import * as path from "node:path";
import type { Command } from "commander";
import * as clack from "@clack/prompts";
import pc from "picocolors";
import {
  hooksFromClaudeSettings,
  validateHookPack,
  type HookCapabilities,
  type HookPack,
} from "@polpo-ai/core/runtime-hooks";
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

/** Number of handlers across every event and matcher group. */
function handlerCount(pack: Pick<HookPack, "hooks">): number {
  return Object.values(pack.hooks ?? {}).reduce((total, groups) => total + (groups ?? []).reduce((sum, group) => sum + (group.hooks?.length ?? 0), 0), 0);
}

/** A deployed entry: a pack, or a stored pack the host flags (e.g. a legacy format to recreate). */
type DeployedHookPack = Partial<HookPack> & { name: string; status?: string; error?: string };

function loadHookPack(file: string): HookPack {
  const pack = validateHookPack(JSON.parse(fs.readFileSync(file, "utf8")));
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
          clack.log.success(`${path.relative(opts.dir, file)} ${pc.dim(`(${handlerCount(pack)} hooks)`)}`);
        } catch (error) {
          failures += 1;
          clack.log.error(`${path.relative(opts.dir, file)} — ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (failures > 0) process.exitCode = 1;
    });

  hooks.command("import <settings>")
    .description("Import the hooks block of a Claude Code settings file as a named pack")
    .requiredOption("-n, --name <name>", "Pack name (file .polpo/hooks/<name>.json)")
    .option("-d, --dir <path>", "Project directory", ".")
    .option("--force", "Replace an existing pack")
    .action((settings: string, opts: { name: string; dir: string; force?: boolean }) => {
      const hooksBlock = hooksFromClaudeSettings(JSON.parse(fs.readFileSync(settings, "utf8")));
      const pack = validateHookPack({ name: opts.name, hooks: hooksBlock });
      const target = path.resolve(opts.dir, ".polpo", "hooks", `${pack.name}.json`);
      if (fs.existsSync(target) && !opts.force) throw new Error(`${path.relative(opts.dir, target)} exists; pass --force to replace it`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `${JSON.stringify(pack, null, 2)}\n`);
      clack.log.success(`${path.relative(opts.dir, target)} ${pc.dim(`(${handlerCount(pack)} hooks)`)}`);
      clack.log.info("Assign the pack to an agent with \"hooks\": [\"" + pack.name + "\"] and deploy.");
    });

  addEnvironmentOptions(hooks.command("list"))
    .description("List deployed runtime hook packs")
    .option("-d, --dir <path>", "Project directory", ".")
    .option("--local", "List local packs instead of deployed packs")
    .action(async (opts: { dir: string; local?: boolean; env?: string; prod?: boolean }) => {
      if (opts.local) {
        const packs = hookFiles(opts.dir).map(loadHookPack);
        if (packs.length === 0) clack.log.info("No local runtime hook packs.");
        for (const pack of packs) clack.log.info(`${pack.name}\t${handlerCount(pack)} hooks`);
        return;
      }
      const credentials = await requireAuth({ context: "Listing runtime hooks requires an authenticated session." });
      const projectId = loadProjectId(opts.dir);
      if (!projectId) throw new Error("No project linked in this directory");
      const client = createApiClient(credentials, projectId, resolveCliEnvironment(opts));
      const response = await client.get<{ ok?: boolean; data?: DeployedHookPack[] }>("/v1/hooks");
      if (response.status !== 200) throw new Error(`Hooks API returned ${response.status}`);
      const packs = response.data.data ?? [];
      if (packs.length === 0) clack.log.info("No deployed runtime hook packs.");
      for (const pack of packs) {
        if (pack.status && pack.status !== "ok") {
          clack.log.warn(`${pack.name}\t${pack.status}${pack.error ? ` — ${pack.error}` : ""}`);
        } else {
          clack.log.info(`${pack.name}\t${handlerCount({ hooks: pack.hooks ?? {} })} hooks`);
        }
      }
    });

  addEnvironmentOptions(hooks.command("capabilities"))
    .description("Show the runtime hook contract supported by the target environment")
    .option("-d, --dir <path>", "Project directory", ".")
    .option("--json", "Print machine-readable JSON")
    .action(async (opts: { dir: string; json?: boolean; env?: string; prod?: boolean }) => {
      const credentials = await requireAuth({ context: "Inspecting runtime hook capabilities requires an authenticated session." });
      const projectId = loadProjectId(opts.dir);
      if (!projectId) throw new Error("No project linked in this directory");
      const client = createApiClient(credentials, projectId, resolveCliEnvironment(opts));
      const response = await client.get<{ ok?: boolean; data?: HookCapabilities }>("/v1/hooks/capabilities");
      if (response.status !== 200 || !response.data.data) {
        throw new Error(`Hooks capabilities API returned ${response.status}`);
      }
      const capabilities = response.data.data;
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(capabilities, null, 2)}\n`);
        return;
      }
      clack.log.info(`Reference\t${capabilities.reference}`);
      clack.log.info(`Handlers\t${capabilities.handlerTypes.join(", ")}`);
      clack.log.info(`Emitted events\t${capabilities.emittedEvents.join(", ")}`);
      clack.log.info(`Stop continuation cap\t${capabilities.stopHookBlockCap}`);
    });
}
