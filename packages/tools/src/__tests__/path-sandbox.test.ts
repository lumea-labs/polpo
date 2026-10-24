import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPathAllowed } from "../path-sandbox.js";
import { createSystemTools } from "../system-tools.js";
import { NodeFileSystem } from "../adapters/node-filesystem.js";
import { NodeShell } from "../adapters/node-shell.js";

let root: string;
let sandbox: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "polpo-sandbox-"));
  sandbox = join(root, "sandbox");
  outside = join(root, "outside");
  mkdirSync(sandbox);
  mkdirSync(outside);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("isPathAllowed — symlinked ancestors of new paths", () => {
  it("rejects a not-yet-existing file under a symlinked directory that points outside", () => {
    symlinkSync(outside, join(sandbox, "escape"));
    expect(isPathAllowed(join(sandbox, "escape", "new.txt"), [sandbox])).toBe(false);
    expect(isPathAllowed(join(sandbox, "escape", "deep", "nested", "new.txt"), [sandbox])).toBe(false);
  });

  it("rejects a dangling symlink whose target is outside the sandbox", () => {
    symlinkSync(join(outside, "not-yet.txt"), join(sandbox, "dangling"));
    expect(isPathAllowed(join(sandbox, "dangling"), [sandbox])).toBe(false);
  });

  it("rejects symlink loops instead of falling back to the logical path", () => {
    symlinkSync(join(sandbox, "b"), join(sandbox, "a"));
    symlinkSync(join(sandbox, "a"), join(sandbox, "b"));
    expect(isPathAllowed(join(sandbox, "a", "file.txt"), [sandbox])).toBe(false);
  });

  it("still allows new files under real and in-sandbox symlinked directories", () => {
    mkdirSync(join(sandbox, "real"));
    symlinkSync(join(sandbox, "real"), join(sandbox, "alias"));
    expect(isPathAllowed(join(sandbox, "real", "new.txt"), [sandbox])).toBe(true);
    expect(isPathAllowed(join(sandbox, "alias", "new.txt"), [sandbox])).toBe(true);
    expect(isPathAllowed(join(sandbox, "missing", "dir", "new.txt"), [sandbox])).toBe(true);
  });

  it("accepts an allowed root that is itself reached through a symlink", () => {
    const linkedRoot = join(root, "linked-root");
    symlinkSync(sandbox, linkedRoot);
    expect(isPathAllowed(join(linkedRoot, "new.txt"), [linkedRoot])).toBe(true);
    expect(isPathAllowed(join(sandbox, "new.txt"), [linkedRoot])).toBe(true);
  });

  it("blocks the write tool from creating a file through a symlinked directory", async () => {
    symlinkSync(outside, join(sandbox, "escape"));
    const tools = createSystemTools(sandbox, undefined, [sandbox], undefined, undefined, new NodeFileSystem(), new NodeShell());
    const write = tools.find((tool) => tool.name === "write")!;
    await expect(write.execute("c1", { path: "escape/pwned.txt", content: "x" })).rejects.toThrow(/sandbox/);
    expect(existsSync(join(outside, "pwned.txt"))).toBe(false);
  });
});
