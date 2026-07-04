/**
 * Skills Index — CRUD for the on-disk index (.polpo/skills-index.json).
 *
 * The index stores per-skill metadata (tags, category) used to enrich
 * discovered skills for search and grouping.
 */

import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

// ── Skills Index ──

/** A single entry in the skills index file (.polpo/skills-index.json). */
export interface SkillIndexEntry {
  /** Freeform tags for search and filtering. */
  tags?: string[];
  /** Macro-category for grouping. */
  category?: string;
}

/** The full skills index: maps skill names to their index metadata. */
export type SkillIndex = Record<string, SkillIndexEntry>;

// ── Skills Index (tags & categories) ──

const SKILLS_INDEX_FILE = "skills-index.json";

/**
 * Load the skills index from `.polpo/skills-index.json`.
 * Returns null if the file doesn't exist or is invalid.
 */
export function loadSkillIndex(polpoDir: string): SkillIndex | null {
  const indexPath = join(polpoDir, SKILLS_INDEX_FILE);
  if (!existsSync(indexPath)) return null;
  try {
    const raw = readFileSync(indexPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as SkillIndex;
  } catch { return null; }
}

/**
 * Save the full skills index to `.polpo/skills-index.json`.
 */
export function saveSkillIndex(polpoDir: string, index: SkillIndex): void {
  const indexPath = join(polpoDir, SKILLS_INDEX_FILE);
  mkdirSync(polpoDir, { recursive: true });
  writeFileSync(indexPath, JSON.stringify(index, null, 2) + "\n", "utf-8");
}

/**
 * Update a single skill's entry in the skills index.
 * Creates the index file if it doesn't exist.
 * Merges with existing entry (tags/category are replaced individually).
 */
export function updateSkillIndex(polpoDir: string, skillName: string, entry: SkillIndexEntry): void {
  const index = loadSkillIndex(polpoDir) ?? {};
  index[skillName] = { ...index[skillName], ...entry };
  // Remove empty fields
  if (index[skillName].tags?.length === 0) delete index[skillName].tags;
  if (!index[skillName].category) delete index[skillName].category;
  // Remove empty entries
  if (Object.keys(index[skillName]).length === 0) delete index[skillName];
  saveSkillIndex(polpoDir, index);
}

/**
 * Remove a skill's entry from the skills index.
 */
export function removeSkillFromIndex(polpoDir: string, skillName: string): void {
  const index = loadSkillIndex(polpoDir);
  if (!index || !index[skillName]) return;
  delete index[skillName];
  saveSkillIndex(polpoDir, index);
}
