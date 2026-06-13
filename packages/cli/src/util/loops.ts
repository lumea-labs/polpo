import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { projectLoopConfigSchema } from "@polpo-ai/core/schemas";
import type { ProjectLoopConfig } from "@polpo-ai/core";

export const LOOP_SOURCE_EXTENSIONS = [".json", ".js", ".mjs", ".ts"] as const;

export function listLoopSourceFiles(polpoDir: string): string[] {
  const dir = path.join(polpoDir, "loops");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((file) => LOOP_SOURCE_EXTENSIONS.some((ext) => file.endsWith(ext)))
    .map((file) => path.join(dir, file))
    .sort();
}

export async function loadLoopSource(file: string): Promise<ProjectLoopConfig> {
  if (file.endsWith(".json")) {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    return projectLoopConfigSchema.parse(raw) as ProjectLoopConfig;
  }

  const mod = await import(pathToFileURL(path.resolve(file)).href);
  const raw = mod.default ?? mod.loop ?? mod.projectLoop;
  if (!raw) {
    throw new Error("Loop module must export default, loop, or projectLoop");
  }
  return projectLoopConfigSchema.parse(raw) as ProjectLoopConfig;
}
