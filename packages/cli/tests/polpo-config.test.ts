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

  it("polpoConfigPath returns <cwd>/.polpo/polpo.json", () => {
    expect(polpoConfigPath(tmpDir)).toBe(
      path.join(tmpDir, ".polpo", "polpo.json"),
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

  it("returns null when .polpo/polpo.json does not exist", () => {
    fs.mkdirSync(path.join(tmpDir, ".polpo"));
    expect(readPolpoConfig(tmpDir)).toBeNull();
  });

  it("reads a valid JSON config", () => {
    fs.mkdirSync(path.join(tmpDir, ".polpo"));
    fs.writeFileSync(
      path.join(tmpDir, ".polpo", "polpo.json"),
      JSON.stringify({ project: "demo", projectId: "uuid-123" }),
    );
    expect(readPolpoConfig(tmpDir)).toEqual({
      project: "demo",
      projectId: "uuid-123",
    });
  });

  it("returns null for corrupt JSON (does NOT throw)", () => {
    fs.mkdirSync(path.join(tmpDir, ".polpo"));
    fs.writeFileSync(path.join(tmpDir, ".polpo", "polpo.json"), "{ not json");
    expect(readPolpoConfig(tmpDir)).toBeNull();
  });

  it("returns null for empty file", () => {
    fs.mkdirSync(path.join(tmpDir, ".polpo"));
    fs.writeFileSync(path.join(tmpDir, ".polpo", "polpo.json"), "");
    expect(readPolpoConfig(tmpDir)).toBeNull();
  });

  it("preserves unknown / extra fields", () => {
    fs.mkdirSync(path.join(tmpDir, ".polpo"));
    fs.writeFileSync(
      path.join(tmpDir, ".polpo", "polpo.json"),
      JSON.stringify({ project: "x", customField: "keep-me", nested: { a: 1 } }),
    );
    const cfg = readPolpoConfig(tmpDir);
    expect(cfg?.customField).toBe("keep-me");
    expect(cfg?.nested).toEqual({ a: 1 });
  });
});

describe("writePolpoConfig", () => {
  it("creates .polpo/ if missing and writes a new config", () => {
    writePolpoConfig(tmpDir, { project: "demo" });
    expect(fs.existsSync(path.join(tmpDir, ".polpo", "polpo.json"))).toBe(true);
    expect(readPolpoConfig(tmpDir)).toEqual({ project: "demo" });
  });

  it("writes formatted JSON with trailing newline", () => {
    writePolpoConfig(tmpDir, { project: "demo" });
    const raw = fs.readFileSync(
      path.join(tmpDir, ".polpo", "polpo.json"),
      "utf-8",
    );
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toContain('  "project": "demo"');
  });

  it("merges with existing config instead of replacing", () => {
    writePolpoConfig(tmpDir, { project: "demo", apiUrl: "https://api.old" });
    writePolpoConfig(tmpDir, { projectId: "uuid-xyz" });
    expect(readPolpoConfig(tmpDir)).toEqual({
      project: "demo",
      apiUrl: "https://api.old",
      projectId: "uuid-xyz",
    });
  });

  it("patch fields overwrite existing ones with the same name", () => {
    writePolpoConfig(tmpDir, { apiUrl: "https://api.old" });
    writePolpoConfig(tmpDir, { apiUrl: "https://api.new" });
    expect(readPolpoConfig(tmpDir)).toEqual({ apiUrl: "https://api.new" });
  });

  it("preserves unknown keys on merge", () => {
    fs.mkdirSync(path.join(tmpDir, ".polpo"));
    fs.writeFileSync(
      path.join(tmpDir, ".polpo", "polpo.json"),
      JSON.stringify({ project: "x", customPlugin: { foo: "bar" } }),
    );
    writePolpoConfig(tmpDir, { projectId: "uuid" });
    expect(readPolpoConfig(tmpDir)).toEqual({
      project: "x",
      customPlugin: { foo: "bar" },
      projectId: "uuid",
    });
  });

  it("works when .polpo already exists as a directory", () => {
    fs.mkdirSync(path.join(tmpDir, ".polpo"));
    writePolpoConfig(tmpDir, { project: "demo" });
    expect(readPolpoConfig(tmpDir)).toEqual({ project: "demo" });
  });

  it("treats corrupt existing file as empty (does NOT crash the write)", () => {
    fs.mkdirSync(path.join(tmpDir, ".polpo"));
    fs.writeFileSync(path.join(tmpDir, ".polpo", "polpo.json"), "garbage{");
    writePolpoConfig(tmpDir, { project: "recovered" });
    expect(readPolpoConfig(tmpDir)).toEqual({ project: "recovered" });
  });
});
