import * as fs from "node:fs";
import * as path from "node:path";
import { projectLoopConfigSchema } from "@polpo-ai/core/schemas";
import type { ProjectLoopConfig } from "@polpo-ai/core";
import { compileLoopSource } from "@polpo-ai/server";

export const LOOP_SOURCE_EXTENSIONS = [".json", ".js", ".mjs", ".ts"] as const;
export type LoopDeployPayload =
  | { name: string; body: ProjectLoopConfig }
  | { name: string; body: { source: string; fileName: string } };

function loopSourceExtension(file: string): string | undefined {
  return LOOP_SOURCE_EXTENSIONS.find((ext) => file.endsWith(ext));
}

function loopSourceKey(file: string): string {
  const ext = loopSourceExtension(file);
  return ext ? path.basename(file, ext) : path.basename(file);
}

export function listLoopSourceFiles(polpoDir: string): string[] {
  const dir = path.join(polpoDir, "loops");
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir)
    .filter((file) => loopSourceExtension(file))
    .sort();

  const seen = new Map<string, string>();
  for (const file of files) {
    const key = loopSourceKey(file);
    const previous = seen.get(key);
    if (previous) {
      throw new Error(`Duplicate loop definition "${key}": choose either ${previous} or ${file}, not both.`);
    }
    seen.set(key, file);
  }

  return files
    .map((file) => path.join(dir, file))
    .sort();
}

export async function loadLoopSource(file: string): Promise<ProjectLoopConfig> {
  if (file.endsWith(".json")) {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    return projectLoopConfigSchema.parse(raw) as ProjectLoopConfig;
  }

  return compileLoopSource(fs.readFileSync(file, "utf-8"), path.basename(file));
}

export async function loadLoopDeployPayload(file: string): Promise<LoopDeployPayload> {
  const loop = await loadLoopSource(file);
  if (file.endsWith(".json")) {
    return { name: loop.name, body: loop };
  }
  return {
    name: loop.name,
    body: {
      source: fs.readFileSync(file, "utf-8"),
      fileName: path.basename(file),
    },
  };
}
