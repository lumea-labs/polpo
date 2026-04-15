/**
 * Read projectId from .polpo/polpo.json in the current project directory.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export function loadProjectId(dir = "."): string | undefined {
  const configPath = path.join(path.resolve(dir), ".polpo", "polpo.json");
  if (!fs.existsSync(configPath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf-8")).projectId;
  } catch { return undefined; }
}
