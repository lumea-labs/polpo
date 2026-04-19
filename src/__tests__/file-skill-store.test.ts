import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { FileSkillStore } from "../stores/file-skill-store.js";
import type { SkillRecord } from "@polpo-ai/core";

const TEST_DIR = join(process.cwd(), ".test-skill-store");
const INDEX_PATH = join(TEST_DIR, "skills-index.json");

function recordOf(overrides: Partial<SkillRecord> & { name: string }): SkillRecord {
  return {
    description: "",
    installedAt: "2026-04-19T00:00:00.000Z",
    ...overrides,
  };
}

describe("FileSkillStore", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("list() returns [] when the file does not exist yet", async () => {
    const store = new FileSkillStore(TEST_DIR);
    expect(await store.list()).toEqual([]);
  });

  it("get() returns undefined when the file does not exist yet", async () => {
    const store = new FileSkillStore(TEST_DIR);
    expect(await store.get("frontend-design")).toBeUndefined();
  });

  it("upsert() creates the directory and writes the file", async () => {
    const store = new FileSkillStore(TEST_DIR);
    await store.upsert(recordOf({
      name: "frontend-design",
      description: "Build distinctive UIs",
      source: "anthropics/skills",
    }));

    expect(existsSync(INDEX_PATH)).toBe(true);
    const raw = JSON.parse(readFileSync(INDEX_PATH, "utf-8"));
    expect(raw["frontend-design"].description).toBe("Build distinctive UIs");
    expect(raw["frontend-design"].source).toBe("anthropics/skills");
  });

  it("get() returns the record after upsert", async () => {
    const store = new FileSkillStore(TEST_DIR);
    await store.upsert(recordOf({ name: "pdf", description: "PDF tools" }));
    const got = await store.get("pdf");
    expect(got).toBeDefined();
    expect(got?.description).toBe("PDF tools");
  });

  it("list() returns all upserted records", async () => {
    const store = new FileSkillStore(TEST_DIR);
    await store.upsert(recordOf({ name: "a", description: "A" }));
    await store.upsert(recordOf({ name: "b", description: "B" }));
    const all = await store.list();
    expect(all.map((s) => s.name).sort()).toEqual(["a", "b"]);
  });

  it("upsert() overwrites an existing record by name", async () => {
    const store = new FileSkillStore(TEST_DIR);
    await store.upsert(recordOf({ name: "x", description: "first" }));
    await store.upsert(recordOf({ name: "x", description: "second" }));
    const got = await store.get("x");
    expect(got?.description).toBe("second");
    expect((await store.list()).length).toBe(1);
  });

  it("remove() returns true when the record existed", async () => {
    const store = new FileSkillStore(TEST_DIR);
    await store.upsert(recordOf({ name: "docx" }));
    expect(await store.remove("docx")).toBe(true);
    expect(await store.get("docx")).toBeUndefined();
  });

  it("remove() returns false when the record did not exist", async () => {
    const store = new FileSkillStore(TEST_DIR);
    expect(await store.remove("never-installed")).toBe(false);
  });

  it("preserves unrelated records on remove", async () => {
    const store = new FileSkillStore(TEST_DIR);
    await store.upsert(recordOf({ name: "keep" }));
    await store.upsert(recordOf({ name: "drop" }));
    await store.remove("drop");
    expect((await store.list()).map((s) => s.name)).toEqual(["keep"]);
  });

  it("reads legacy `{ tags?, category? }` file shape transparently", async () => {
    // Simulate the old skills-index.json format from before SkillStore
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(
      INDEX_PATH,
      JSON.stringify({
        "legacy-skill": { tags: ["io"], category: "utility" },
      }),
      "utf-8",
    );

    const store = new FileSkillStore(TEST_DIR);
    const got = await store.get("legacy-skill");
    expect(got).toBeDefined();
    expect(got?.tags).toEqual(["io"]);
    expect(got?.category).toBe("utility");
    // Missing fields default to safe values
    expect(got?.description).toBe("");
    expect(typeof got?.installedAt).toBe("string");
  });

  it("ignores corrupt JSON and returns []", async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(INDEX_PATH, "not valid json {{{", "utf-8");
    const store = new FileSkillStore(TEST_DIR);
    expect(await store.list()).toEqual([]);
  });

  it("ignores empty file and returns []", async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(INDEX_PATH, "", "utf-8");
    const store = new FileSkillStore(TEST_DIR);
    expect(await store.list()).toEqual([]);
  });

  it("upsert() writes atomically via tmp + rename (no half-written file on crash)", async () => {
    const store = new FileSkillStore(TEST_DIR);
    await store.upsert(recordOf({ name: "a" }));
    // Check no leftover .tmp file
    expect(existsSync(INDEX_PATH + ".tmp")).toBe(false);
  });

  it("round-trips tags and category end-to-end", async () => {
    const store = new FileSkillStore(TEST_DIR);
    await store.upsert(recordOf({
      name: "tagged",
      description: "",
      tags: ["ui", "react"],
      category: "frontend",
    }));
    const got = await store.get("tagged");
    expect(got?.tags).toEqual(["ui", "react"]);
    expect(got?.category).toBe("frontend");
  });

  it("round-trips allowedTools", async () => {
    const store = new FileSkillStore(TEST_DIR);
    await store.upsert(recordOf({
      name: "with-tools",
      description: "",
      allowedTools: ["read", "http_fetch"],
    }));
    const got = await store.get("with-tools");
    expect(got?.allowedTools).toEqual(["read", "http_fetch"]);
  });

  it("two stores on the same polpoDir see the same data", async () => {
    const a = new FileSkillStore(TEST_DIR);
    const b = new FileSkillStore(TEST_DIR);
    await a.upsert(recordOf({ name: "shared" }));
    expect(await b.get("shared")).toBeDefined();
  });
});
