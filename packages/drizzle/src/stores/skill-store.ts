import { eq } from "drizzle-orm";
import type { SkillStore, SkillRecord } from "@polpo-ai/core";
import { type Dialect, serializeJson, deserializeJson } from "../utils.js";

type AnyTable = any;

/**
 * Drizzle-backed SkillStore.
 *
 * Same table schema on PG and SQLite, just different column types for
 * the JSON fields (jsonb on PG, text on SQLite). `serializeJson` /
 * `deserializeJson` handle both transparently.
 */
export class DrizzleSkillStore implements SkillStore {
  constructor(
    private db: any,
    private table: AnyTable,
    private dialect: Dialect,
  ) {}

  async list(): Promise<SkillRecord[]> {
    const rows: any[] = await this.db.select().from(this.table);
    return rows.map((r) => this.rowToRecord(r));
  }

  async get(name: string): Promise<SkillRecord | undefined> {
    const rows: any[] = await this.db.select().from(this.table)
      .where(eq(this.table.name, name));
    if (rows.length === 0) return undefined;
    return this.rowToRecord(rows[0]);
  }

  async upsert(record: SkillRecord): Promise<void> {
    const values = {
      name: record.name,
      description: record.description,
      source: record.source ?? null,
      installedAt: record.installedAt,
      allowedTools: serializeJson(record.allowedTools, this.dialect),
      tags: serializeJson(record.tags, this.dialect),
      category: record.category ?? null,
    };
    await this.db.insert(this.table).values(values)
      .onConflictDoUpdate({
        target: this.table.name,
        set: {
          description: values.description,
          source: values.source,
          installedAt: values.installedAt,
          allowedTools: values.allowedTools,
          tags: values.tags,
          category: values.category,
        },
      });
  }

  async remove(name: string): Promise<boolean> {
    const rows: any[] = await this.db.select({ name: this.table.name }).from(this.table)
      .where(eq(this.table.name, name));
    if (rows.length === 0) return false;
    await this.db.delete(this.table).where(eq(this.table.name, name));
    return true;
  }

  private rowToRecord(row: any): SkillRecord {
    return {
      name: row.name,
      description: row.description ?? "",
      source: row.source ?? undefined,
      installedAt: row.installedAt ?? new Date(0).toISOString(),
      allowedTools: deserializeJson<string[] | undefined>(row.allowedTools, undefined, this.dialect),
      tags: deserializeJson<string[] | undefined>(row.tags, undefined, this.dialect),
      category: row.category ?? undefined,
    };
  }
}
