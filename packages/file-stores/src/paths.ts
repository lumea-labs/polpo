/**
 * Canonical .polpo directory layout helpers — owned by the file-stores
 * package because the directory layout IS the file persistence contract.
 */

import { resolve, join } from "node:path";
import { homedir } from "node:os";

/** Name of the per-project config directory. */
export const POLPO_DIR_NAME = ".polpo";

/** Resolve the per-project `.polpo` directory from a working directory. */
export function getPolpoDir(workDir: string): string {
  return resolve(workDir, POLPO_DIR_NAME);
}

/** Resolve the global `~/.polpo` directory in the user's home. */
export function getGlobalPolpoDir(): string {
  return join(homedir(), POLPO_DIR_NAME);
}
