import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
} from "node:fs";
import { join, dirname } from "node:path";
import type { SkillStore, SkillRecord } from "@polpo-ai/core";

/**
 * File-backed SkillStore.
 *
 * Persists the full catalog to `${polpoDir}/skills-index.json` as a
 * JSON object keyed by skill name. Writes are atomic (tmp + rename).
 *
 * Legacy compatibility: the old `skills-index.json` format contained
 * only `{ tags?, category? }` per skill. This store reads those files
 * transparently (treating them as partial records) and the caller —
 * typically the upsert triggered by skills/add — fills in the full
 * record on next write.
 */
export class FileSkillStore implements SkillStore {
  private readonly filePath: string;

  constructor(polpoDir: string) {
    this.filePath = join(polpoDir, "skills-index.json");
  }

  async list(): Promise<SkillRecord[]> {
    const all = this.readAll();
    return Object.values(all);
  }

  async get(name: string): Promise<SkillRecord | undefined> {
    const all = this.readAll();
    return all[name];
  }

  async upsert(record: SkillRecord): Promise<void> {
    const all = this.readAll();
    all[record.name] = record;
    this.writeAll(all);
  }

  async remove(name: string): Promise<boolean> {
    const all = this.readAll();
    if (!(name in all)) return false;
    delete all[name];
    this.writeAll(all);
    return true;
  }

  /** Read the JSON file, normalising legacy shapes. */
  private readAll(): Record<string, SkillRecord> {
    if (!existsSync(this.filePath)) return {};
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf-8");
    } catch {
      return {};
    }
    if (!raw.trim()) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {};
    }
    if (!parsed || typeof parsed !== "object") return {};

    const out: Record<string, SkillRecord> = {};
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const v = value as Partial<SkillRecord>;
      out[name] = {
        name,
        description: typeof v.description === "string" ? v.description : "",
        source: typeof v.source === "string" ? v.source : undefined,
        installedAt:
          typeof v.installedAt === "string"
            ? v.installedAt
            : new Date(0).toISOString(),
        allowedTools: Array.isArray(v.allowedTools) ? v.allowedTools : undefined,
        tags: Array.isArray(v.tags) ? v.tags : undefined,
        category: typeof v.category === "string" ? v.category : undefined,
      };
    }
    return out;
  }

  /** Write the full catalog atomically (tmp + rename). */
  private writeAll(all: Record<string, SkillRecord>): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = this.filePath + ".tmp";
    writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n", "utf-8");
    renameSync(tmp, this.filePath);
  }
}
