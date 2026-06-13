import { projectLoopConfigSchema } from "../schemas.js";
import type { ProjectLoopConfig } from "./types.js";

/**
 * Code-first loop definition helper.
 *
 * This intentionally returns the canonical JSON-compatible ProjectLoopConfig:
 * developers can keep loops in TypeScript with type checking, while the runtime,
 * dashboard, API, and audit logs keep one declarative contract.
 */
export function defineProjectLoop(config: ProjectLoopConfig): ProjectLoopConfig {
  return projectLoopConfigSchema.parse(config) as ProjectLoopConfig;
}

export function defineLoop(config: ProjectLoopConfig): ProjectLoopConfig {
  return defineProjectLoop(config);
}
