import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { pgTable, text as pgText, jsonb } from "drizzle-orm/pg-core";

/**
 * Skills catalog — one row per installed skill for the project.
 *
 * Mirrors the fields in `@polpo-ai/core`'s `SkillRecord`. `tags` and
 * `allowedTools` are stored as JSON (jsonb on PG, JSON-stringified text
 * on SQLite) so we can re-emit them as arrays without a join table.
 *
 * `name` is the primary key since a project cannot have two skills
 * with the same canonical name (the directory collides anyway).
 */
export const skillsSqlite = sqliteTable("skills", {
  name: text("name").primaryKey(),
  description: text("description").notNull().default(""),
  source: text("source"),
  installedAt: text("installed_at").notNull(),
  allowedTools: text("allowed_tools"), // JSON-serialized string[]
  tags: text("tags"),                   // JSON-serialized string[]
  category: text("category"),
});

export const skillsPg = pgTable("skills", {
  name: pgText("name").primaryKey(),
  description: pgText("description").notNull().default(""),
  source: pgText("source"),
  installedAt: pgText("installed_at").notNull(),
  allowedTools: jsonb("allowed_tools"), // string[]
  tags: jsonb("tags"),                   // string[]
  category: pgText("category"),
});
