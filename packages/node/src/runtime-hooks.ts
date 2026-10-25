import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  HookConfigError,
  HookEngine,
  HookRuntime,
  validateHookPack,
  type HookHost,
  type HookPack,
  type HookRuntimeContext,
  type HookRuntimeOptions,
} from "@polpo-ai/core/runtime-hooks";

/** Load named packs from `.polpo/hooks/<name>.json` (Claude Code `hooks` object). */
export async function loadRuntimeHookPacks(polpoDir: string, names: readonly string[]): Promise<HookPack[]> {
  const packs: HookPack[] = [];
  for (const rawName of names) {
    const name = normalizePackName(rawName);
    let raw: string;
    try {
      raw = await readFile(join(polpoDir, "hooks", `${name}.json`), "utf8");
    } catch (error) {
      throw new HookConfigError(`could not be read: ${error instanceof Error ? error.message : String(error)}`, `hooks/${name}.json`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new HookConfigError("is not valid JSON", `hooks/${name}.json`);
    }
    const pack = validateHookPack(parsed);
    if (pack.name !== name) throw new HookConfigError(`declares name "${pack.name}"`, `hooks/${name}.json`);
    packs.push(pack);
  }
  return packs;
}

/**
 * Build the hook runtime for one agent invocation from the packs assigned to
 * the agent. Returns undefined when the agent has no hooks.
 */
export async function createProjectHookRuntime(options: {
  polpoDir: string;
  names: readonly string[];
  host: HookHost;
  context: HookRuntimeContext;
  runtimeOptions?: HookRuntimeOptions;
  baseEnv?: Record<string, string>;
}): Promise<HookRuntime | undefined> {
  if (options.names.length === 0) return undefined;
  const packs = await loadRuntimeHookPacks(options.polpoDir, options.names);
  const engine = new HookEngine({
    projectDir: options.context.projectDir,
    host: options.host,
    sources: packs.map((pack) => ({ source: "agent" as const, name: pack.name, hooks: pack.hooks })),
    ...(options.baseEnv ? { baseEnv: options.baseEnv } : {}),
  });
  return new HookRuntime(engine, options.context, options.runtimeOptions);
}

function normalizePackName(value: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(value)) {
    throw new HookConfigError(`invalid pack name ${JSON.stringify(value)}`, "hooks");
  }
  return value;
}
