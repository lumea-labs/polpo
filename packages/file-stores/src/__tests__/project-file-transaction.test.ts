import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withProjectFileTransaction } from "../project-file-transaction.js";

const directories: string[] = [];
const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "polpo-file-transaction-"));
  directories.push(dir);
  return dir;
};
afterEach(() => directories.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

describe("project filesystem transactions", () => {
  it("stages a complete write set, supports nested readers and commits together", () => {
    const dir = fixture();
    withProjectFileTransaction(dir, tx => {
      tx.write("agents/a/agent.json", "{}");
      tx.write("agents/a/instructions.md", "Prompt");
      expect(tx.list("agents")).toEqual(["a"]);
      expect(tx.isDirectory("agents/a")).toBe(true);
      expect(withProjectFileTransaction(dir, inner => inner.read("agents/a/instructions.md"))).toBe("Prompt");
      expect(() => readFileSync(join(dir, "agents/a/agent.json"))).toThrow();
    });
    expect(readFileSync(join(dir, "agents/a/instructions.md"), "utf8")).toBe("Prompt");
  });

  it("does not partially persist failed validation", () => {
    const dir = fixture();
    writeFileSync(join(dir, "agents.json"), "old");
    expect(() => withProjectFileTransaction(dir, tx => {
      tx.write("agents.json", "new");
      tx.write("teams.json", "new");
      throw new Error("validation failed");
    })).toThrow("validation failed");
    expect(readFileSync(join(dir, "agents.json"), "utf8")).toBe("old");
    expect(() => readFileSync(join(dir, "teams.json"))).toThrow();
  });

  it("rejects asynchronous critical sections and path traversal", () => {
    const dir = fixture();
    expect(() => withProjectFileTransaction(dir, async tx => { tx.write("agents.json", "unsafe"); }))
      .toThrow(/synchronous/);
    expect(() => withProjectFileTransaction(dir, tx => tx.write("../outside", "unsafe"))).toThrow(/path/);
    expect(() => readFileSync(join(dir, "agents.json"))).toThrow();
  });

  it("rejects an out-of-protocol edit before applying any staged file", () => {
    const dir = fixture();
    writeFileSync(join(dir, "agents.json"), "old");
    expect(() => withProjectFileTransaction(dir, tx => {
      tx.write("teams.json", "new");
      tx.write("agents.json", "new");
      writeFileSync(join(dir, "agents.json"), "manual");
    })).toThrow(/outside the project transaction/);
    expect(readFileSync(join(dir, "agents.json"), "utf8")).toBe("manual");
    expect(() => readFileSync(join(dir, "teams.json"))).toThrow();
  });

  it("rejects both existing and dangling symbolic links", () => {
    const dir = fixture();
    const outside = fixture();
    writeFileSync(join(outside, "file"), "preserve");
    symlinkSync(join(outside, "file"), join(dir, "linked"));
    symlinkSync(join(outside, "absent"), join(dir, "dangling"));
    for (const path of ["linked", "dangling"]) {
      expect(() => withProjectFileTransaction(dir, tx => tx.write(path, "unsafe"))).toThrow(/Symbolic links/);
    }
    expect(readFileSync(join(outside, "file"), "utf8")).toBe("preserve");
  });

  it("rejects a corrupt recovery journal without applying its paths", () => {
    const dir = fixture();
    withProjectFileTransaction(dir, tx => tx.write("agents.json", "old"));
    writeFileSync(join(dir, ".runtime/agent-store/pending.json"), JSON.stringify({ version: 1, changes: [
      { path: "agents.json", before: "old", after: "unsafe" },
      { path: "../escape", before: null, after: "unsafe" },
    ] }));
    expect(() => withProjectFileTransaction(dir, tx => tx.read("agents.json"))).toThrow(/path/);
    expect(readFileSync(join(dir, "agents.json"), "utf8")).toBe("old");
  });
});
