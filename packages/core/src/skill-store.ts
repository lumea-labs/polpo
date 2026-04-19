/**
 * Persistent per-project skill catalog — name + description + source +
 * optional tags/category kept in a store so that `GET /skills` can be
 * answered without walking the filesystem. The filesystem (polpoDir/
 * skills/<name>/SKILL.md + assets) remains the source of truth for
 * skill CONTENT; the store indexes metadata.
 *
 * Shape is additive to the legacy `SkillIndexEntry` (tags + category)
 * which used to live in a standalone `skills-index.json` — the new
 * record absorbs those fields so callers have a single source.
 */
export interface SkillRecord {
  /** Canonical skill name (matches directory name on disk). */
  name: string;
  /** Short description from SKILL.md frontmatter. */
  description: string;
  /** Where the skill came from: "anthropics/skills", "github.com/…",
   *  "local", etc. Useful for reinstall / update flows. */
  source?: string;
  /** ISO timestamp of the first install. */
  installedAt: string;
  /** Tool names from SKILL.md frontmatter. Cached to avoid re-parsing
   *  SKILL.md on every list. */
  allowedTools?: string[];
  /** User-assigned tags (free-form). */
  tags?: string[];
  /** User-assigned category (single). */
  category?: string;
}

export interface SkillStore {
  /** Return all recorded skills, unordered. */
  list(): Promise<SkillRecord[]>;
  /** Return a single record by name, or undefined. */
  get(name: string): Promise<SkillRecord | undefined>;
  /** Insert or replace a record. `name` is the primary key. */
  upsert(record: SkillRecord): Promise<void>;
  /** Remove a record. Returns true if something was removed. */
  remove(name: string): Promise<boolean>;
}
