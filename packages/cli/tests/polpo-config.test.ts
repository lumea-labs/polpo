import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  polpoDirPath,
  polpoConfigPath,
  readPolpoConfig,
  writePolpoConfig,
} from "../src/util/polpo-config.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "polpo-config-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("polpoDirPath / polpoConfigPath", () => {
  it("polpoDirPath returns <cwd>/.polpo absolute", () => {
    expect(polpoDirPath(tmpDir)).toBe(path.resolve(tmpDir, ".polpo"));
  });

  it("polpoConfigPath returns <cwd>/.polpo/project.json", () => {
    expect(polpoConfigPath(tmpDir)).toBe(
      path.join(tmpDir, ".polpo", "project.json"),
    );
  });

  it("resolves relative cwd to absolute", () => {
    const rel = path.relative(process.cwd(), tmpDir);
    expect(path.isAbsolute(polpoDirPath(rel))).toBe(true);
  });
});

describe("readPolpoConfig", () => {
  it("returns null when .polpo/ does not exist", () => {
    expect(readPolpoConfig(tmpDir)).toBeNull();
  });

  it("returns null when no project config exists", () => {
    fs.mkdirSync(path.join(tmpDir, ".polpo"));
    expect(readPolpoConfig(tmpDir)).toBeNull();
  });

  it("reads a valid JSON config", () => {
    fs.mkdirSync(path.join(tmpDir, ".polpo"));
    fs.writeFileSync(
      path.join(tmpDir, ".polpo", "project.json"),
      JSON.stringify({ project: "demo", projectId: "uuid-123" }),
    );
    expect(readPolpoConfig(tmpDir)).toEqual({
      project: "demo",
      projectId: "uuid-123",
    });
  });

  it("returns null for corrupt JSON (does NOT throw)", () => {
    fs.mkdirSync(path.join(tmpDir, ".polpo"));
    fs.writeFileSync(path.join(tmpDir, ".polpo", "project.json"), "{ not json");
    expect(readPolpoConfig(tmpDir)).toBeNull();
  });

  it("returns null for empty file", () => {
    fs.mkdirSync(path.join(tmpDir, ".polpo"));
    fs.writeFileSync(path.join(tmpDir, ".polpo", "project.json"), "");
    expect(readPolpoConfig(tmpDir)).toBeNull();
  });

  it("preserves unknown / extra fields", () => {
    fs.mkdirSync(path.join(tmpDir, ".polpo"));
    fs.writeFileSync(
      path.join(tmpDir, ".polpo", "project.json"),
      JSON.stringify({ project: "x", customField: "keep-me", nested: { a: 1 } }),
    );
    const cfg = readPolpoConfig(tmpDir);
    expect(cfg?.customField).toBe("keep-me");
    expect(cfg?.nested).toEqual({ a: 1 });
  });
});

describe("writePolpoConfig", () => {
  it("updates an existing legacy config without migrating it implicitly", () => {
    const polpoDir = path.join(tmpDir, ".polpo");
    fs.mkdirSync(polpoDir, { recursive: true });
    fs.writeFileSync(
      path.join(polpoDir, "polpo.json"),
      JSON.stringify({ project: "legacy", projectId: "old" }),
    );

    writePolpoConfig(tmpDir, { projectId: "new" });

    expect(JSON.parse(fs.readFileSync(path.join(polpoDir, "polpo.json"), "utf-8")))
      .toEqual({ project: "legacy", projectId: "new" });
    expect(fs.existsSync(path.join(polpoDir, "project.json"))).toBe(false);
  });

  it("creates .polpo/ if missing and writes a new config", () => {
    writePolpoConfig(tmpDir, { project: "demo" });
    expect(fs.existsSync(path.join(tmpDir, ".polpo", "project.json"))).toBe(true);
    expect(readPolpoConfig(tmpDir)).toEqual({ schemaVersion: 2, project: "demo" });
  });

  it("writes formatted JSON with trailing newline", () => {
    writePolpoConfig(tmpDir, { project: "demo" });
    const raw = fs.readFileSync(
      path.join(tmpDir, ".polpo", "project.json"),
      "utf-8",
    );
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toContain('  "project": "demo"');
  });

  it("merges with existing config instead of replacing", () => {
    writePolpoConfig(tmpDir, { project: "demo", apiUrl: "https://api.old" });
    writePolpoConfig(tmpDir, { projectId: "uuid-xyz" });
    expect(readPolpoConfig(tmpDir)).toEqual({
      schemaVersion: 2,
      project: "demo",
      apiUrl: "https://api.old",
      projectId: "uuid-xyz",
    });
  });

  it("patch fields overwrite existing ones with the same name", () => {
    writePolpoConfig(tmpDir, { apiUrl: "https://api.old" });
    writePolpoConfig(tmpDir, { apiUrl: "https://api.new" });
    expect(readPolpoConfig(tmpDir)).toEqual({ schemaVersion: 2, apiUrl: "https://api.new" });
  });

  it("preserves unknown keys on merge", () => {
    fs.mkdirSync(path.join(tmpDir, ".polpo"));
    fs.writeFileSync(
      path.join(tmpDir, ".polpo", "project.json"),
      JSON.stringify({ project: "x", customPlugin: { foo: "bar" } }),
    );
    writePolpoConfig(tmpDir, { projectId: "uuid" });
    expect(readPolpoConfig(tmpDir)).toEqual({
      schemaVersion: 2,
      project: "x",
      customPlugin: { foo: "bar" },
      projectId: "uuid",
    });
  });

  it("works when .polpo already exists as a directory", () => {
    fs.mkdirSync(path.join(tmpDir, ".polpo"));
    writePolpoConfig(tmpDir, { project: "demo" });
    expect(readPolpoConfig(tmpDir)).toEqual({ schemaVersion: 2, project: "demo" });
  });

  it("treats corrupt existing file as empty (does NOT crash the write)", () => {
    fs.mkdirSync(path.join(tmpDir, ".polpo"));
    fs.writeFileSync(path.join(tmpDir, ".polpo", "project.json"), "garbage{");
    writePolpoConfig(tmpDir, { project: "recovered" });
    expect(readPolpoConfig(tmpDir)).toEqual({ schemaVersion: 2, project: "recovered" });
  });

  it("persists projectSlug + projectId together (canonical post-F4 shape)", () => {
    writePolpoConfig(tmpDir, {
      project: "demo",
      projectSlug: "abcdefghijklmnopqrst",
      projectId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(readPolpoConfig(tmpDir)).toEqual({
      schemaVersion: 2,
      project: "demo",
      projectSlug: "abcdefghijklmnopqrst",
      projectId: "550e8400-e29b-41d4-a716-446655440000",
    });
  });

  it("backfilling projectSlug into a legacy id-only file preserves the id", () => {
    fs.mkdirSync(path.join(tmpDir, ".polpo"));
    fs.writeFileSync(
      path.join(tmpDir, ".polpo", "polpo.json"),
      JSON.stringify({ project: "legacy", projectId: "old-uuid" }),
    );
    writePolpoConfig(tmpDir, { projectSlug: "abcdefghijklmnopqrst" });
    expect(readPolpoConfig(tmpDir)).toEqual({
      project: "legacy",
      projectId: "old-uuid",
      projectSlug: "abcdefghijklmnopqrst",
    });
  });

  it("prefers project.json when both config filenames exist", () => {
    fs.mkdirSync(path.join(tmpDir, ".polpo"));
    fs.writeFileSync(
      path.join(tmpDir, ".polpo", "polpo.json"),
      JSON.stringify({ project: "legacy" }),
    );
    fs.writeFileSync(
      path.join(tmpDir, ".polpo", "project.json"),
      JSON.stringify({ project: "current" }),
    );
    expect(readPolpoConfig(tmpDir)?.project).toBe("current");
  });
});
