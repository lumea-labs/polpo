/**
 * Credential store tests.
 *
 * `cloud/config.ts` captures `os.homedir()` into a module-level constant at
 * import time. To test it safely in isolation we:
 *   1. stub `node:os` via `vi.mock` + `vi.importActual`
 *   2. call `vi.resetModules()` + dynamic-import the SUT in each test, so
 *      the module re-reads our mocked homedir() for every case.
 *
 * This is the standard ESM pattern and avoids writing to the user's real
 * `~/.polpo/credentials.json` during tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const homeHolder = { path: "" };

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => homeHolder.path,
  };
});

type ConfigModule = typeof import("../../src/commands/cloud/config.js");
let config: ConfigModule;

beforeEach(async () => {
  homeHolder.path = fs.mkdtempSync(path.join(os.tmpdir(), "polpo-creds-"));
  vi.resetModules();
  config = await import("../../src/commands/cloud/config.js");
});

afterEach(() => {
  fs.rmSync(homeHolder.path, { recursive: true, force: true });
});

function credsFile(): string {
  return path.join(homeHolder.path, ".polpo", "credentials.json");
}

describe("saveCredentials + loadCredentials roundtrip", () => {
  it("save then load returns the same credentials", () => {
    config.saveCredentials("sk_live_abc", "https://api.example.test");
    const loaded = config.loadCredentials();
    expect(loaded).toEqual({
      apiKey: "sk_live_abc",
      baseUrl: "https://api.example.test",
    });
  });

  it("writes the file at ~/.polpo/credentials.json", () => {
    config.saveCredentials("sk_live_abc");
    expect(fs.existsSync(credsFile())).toBe(true);
  });

  it("defaults baseUrl to https://api.polpo.sh when omitted", () => {
    config.saveCredentials("sk_live_abc");
    expect(config.loadCredentials()?.baseUrl).toBe("https://api.polpo.sh");
  });

  it("overwrites previous credentials when called twice", () => {
    config.saveCredentials("old_key", "https://old.example");
    config.saveCredentials("new_key", "https://new.example");
    expect(config.loadCredentials()).toEqual({
      apiKey: "new_key",
      baseUrl: "https://new.example",
    });
  });

  it("creates ~/.polpo/ if missing", () => {
    expect(fs.existsSync(path.join(homeHolder.path, ".polpo"))).toBe(false);
    config.saveCredentials("sk_live_abc");
    expect(fs.existsSync(path.join(homeHolder.path, ".polpo"))).toBe(true);
  });
});

describe("loadCredentials edge cases", () => {
  it("returns null when the credentials file does not exist", () => {
    expect(config.loadCredentials()).toBeNull();
  });

  it("returns null when the file contains invalid JSON", () => {
    fs.mkdirSync(path.join(homeHolder.path, ".polpo"), { recursive: true });
    fs.writeFileSync(credsFile(), "{ not json");
    expect(config.loadCredentials()).toBeNull();
  });

  it("returns null when apiKey is missing", () => {
    fs.mkdirSync(path.join(homeHolder.path, ".polpo"), { recursive: true });
    fs.writeFileSync(
      credsFile(),
      JSON.stringify({ baseUrl: "https://api.polpo.sh" }),
    );
    expect(config.loadCredentials()).toBeNull();
  });

  it("returns null when baseUrl is missing", () => {
    fs.mkdirSync(path.join(homeHolder.path, ".polpo"), { recursive: true });
    fs.writeFileSync(credsFile(), JSON.stringify({ apiKey: "sk_live_abc" }));
    expect(config.loadCredentials()).toBeNull();
  });

  it("returns null when the file is empty", () => {
    fs.mkdirSync(path.join(homeHolder.path, ".polpo"), { recursive: true });
    fs.writeFileSync(credsFile(), "");
    expect(config.loadCredentials()).toBeNull();
  });

  it("returns null when apiKey is an empty string (falsy check)", () => {
    fs.mkdirSync(path.join(homeHolder.path, ".polpo"), { recursive: true });
    fs.writeFileSync(
      credsFile(),
      JSON.stringify({ apiKey: "", baseUrl: "https://api.polpo.sh" }),
    );
    expect(config.loadCredentials()).toBeNull();
  });
});

describe("clearCredentials", () => {
  it("removes the credentials file when present", () => {
    config.saveCredentials("sk_live_abc");
    expect(fs.existsSync(credsFile())).toBe(true);
    config.clearCredentials();
    expect(fs.existsSync(credsFile())).toBe(false);
  });

  it("is a no-op when the file is missing", () => {
    expect(fs.existsSync(credsFile())).toBe(false);
    expect(() => config.clearCredentials()).not.toThrow();
  });

  it("leaves the .polpo dir intact", () => {
    config.saveCredentials("sk_live_abc");
    config.clearCredentials();
    expect(fs.existsSync(path.join(homeHolder.path, ".polpo"))).toBe(true);
  });
});

// Skip on Windows — POSIX permission bits aren't meaningful there.
const isPosix = process.platform !== "win32";

describe.skipIf(!isPosix)("file permissions (POSIX)", () => {
  it("writes credentials with 0600 (owner-only read/write)", () => {
    config.saveCredentials("sk_live_abc");
    const mode = fs.statSync(credsFile()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("creates the .polpo dir with 0700 (owner-only)", () => {
    config.saveCredentials("sk_live_abc");
    const mode = fs.statSync(path.join(homeHolder.path, ".polpo")).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it("downgrades permissions on an existing overly-permissive file", () => {
    // Simulate a credentials file that predates the chmod fix
    // (e.g. written by a previous CLI version with default umask 0644).
    fs.mkdirSync(path.join(homeHolder.path, ".polpo"), { recursive: true });
    fs.writeFileSync(credsFile(), "{}", { mode: 0o644 });
    config.saveCredentials("sk_live_abc");
    const mode = fs.statSync(credsFile()).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
