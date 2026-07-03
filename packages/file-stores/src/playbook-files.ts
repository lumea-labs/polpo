/**
 * Playbook file persistence — discovery and CRUD over the .polpo/playbooks
 * directory layout (with legacy templates/ compatibility). Pure logic
 * (validation, instantiation) lives in @polpo-ai/core (playbook-logic).
 */

import { readdirSync, readFileSync, existsSync, realpathSync, statSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { PlaybookDefinition, PlaybookInfo } from "@polpo-ai/core/playbook-store";
import { validatePlaybookDefinition } from "@polpo-ai/core";
import { getPolpoDir, getGlobalPolpoDir } from "./paths.js";

// ── Discovery ──────────────────────────────────────────────────────────

function scanPlaybookDir(dir: string): PlaybookInfo[] {
  if (!existsSync(dir)) return [];

  const results: PlaybookInfo[] = [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    const entryPath = join(dir, entry);

    // Follow symlinks
    let realPath: string;
    try {
      realPath = realpathSync(entryPath);
    } catch {
      continue; // broken symlink
    }

    // Must be a directory
    try {
      if (!statSync(realPath).isDirectory()) continue;
    } catch {
      continue;
    }

    // Must contain playbook.json or template.json (backward compat)
    let playbookFile = join(realPath, "playbook.json");
    if (!existsSync(playbookFile)) {
      playbookFile = join(realPath, "template.json");
      if (!existsSync(playbookFile)) continue;
    }

    try {
      const raw = readFileSync(playbookFile, "utf-8");
      const def = JSON.parse(raw) as Partial<PlaybookDefinition>;

      if (!def.name || !def.description || !def.mission) continue;

      results.push({
        name: def.name,
        description: def.description,
        parameters: def.parameters ?? [],
        path: realPath,
      });
    } catch {
      // Invalid JSON — skip silently
    }
  }

  return results;
}

/**
 * Discover all available playbooks from known locations.
 * Returns deduplicated list (first occurrence wins by name).
 *
 * Also scans legacy templates/ directories for backward compatibility.
 */
export function discoverPlaybooks(cwd: string, polpoDir?: string): PlaybookInfo[] {
  const seen = new Set<string>();
  const results: PlaybookInfo[] = [];

  const dirs: string[] = [];

  // 1. Project-level: <polpoDir>/playbooks/ (+ legacy templates/)
  if (polpoDir) {
    dirs.push(join(polpoDir, "playbooks"));
    dirs.push(join(polpoDir, "templates"));
  }

  // 2. Fallback if polpoDir is not the default .polpo
  const defaultPolpoDir = getPolpoDir(cwd);
  if (!polpoDir || resolve(polpoDir) !== resolve(defaultPolpoDir)) {
    dirs.push(join(defaultPolpoDir, "playbooks"));
    dirs.push(join(defaultPolpoDir, "templates"));
  }

  // 3. User-level: ~/.polpo/playbooks/ (+ legacy templates/)
  const globalDir = getGlobalPolpoDir();
  dirs.push(join(globalDir, "playbooks"));
  dirs.push(join(globalDir, "templates"));

  for (const dir of dirs) {
    for (const pb of scanPlaybookDir(dir)) {
      if (!seen.has(pb.name)) {
        seen.add(pb.name);
        results.push(pb);
      }
    }
  }

  return results;
}

/**
 * Load a full playbook definition by name.
 * Returns null if not found.
 */
export function loadPlaybook(cwd: string, polpoDir: string | undefined, name: string): PlaybookDefinition | null {
  const playbooks = discoverPlaybooks(cwd, polpoDir);
  const info = playbooks.find(p => p.name === name);
  if (!info) return null;

  // Try playbook.json first, then template.json (backward compat)
  let playbookFile = join(info.path, "playbook.json");
  if (!existsSync(playbookFile)) {
    playbookFile = join(info.path, "template.json");
  }

  try {
    const raw = readFileSync(playbookFile, "utf-8");
    return JSON.parse(raw) as PlaybookDefinition;
  } catch {
    return null;
  }
}


/**
 * Save a playbook to disk.
 *
 * Creates/overwrites `<polpoDir>/playbooks/<name>/playbook.json`.
 * Validates the definition structure before writing.
 *
 * @returns The absolute path to the saved playbook directory.
 * @throws If validation fails or the write fails.
 */
export function savePlaybook(polpoDir: string, definition: PlaybookDefinition): string {
  const errors = validatePlaybookDefinition(definition);
  if (errors.length > 0) {
    throw new Error(`Invalid playbook definition:\n  - ${errors.join("\n  - ")}`);
  }

  const playbookDir = join(polpoDir, "playbooks", definition.name);
  mkdirSync(playbookDir, { recursive: true });

  const playbookFile = join(playbookDir, "playbook.json");
  writeFileSync(playbookFile, JSON.stringify(definition, null, 2), "utf-8");

  return playbookDir;
}

/**
 * Delete a playbook from disk.
 *
 * Removes the `<polpoDir>/playbooks/<name>/` directory entirely.
 * Also checks `~/.polpo/playbooks/<name>/` if not found in polpoDir.
 *
 * @returns true if deleted, false if not found.
 */
export function deletePlaybook(cwd: string, polpoDir: string | undefined, name: string): boolean {
  // Find where the playbook lives
  const playbooks = discoverPlaybooks(cwd, polpoDir);
  const info = playbooks.find(p => p.name === name);
  if (!info) return false;

  rmSync(info.path, { recursive: true, force: true });
  return true;
}

