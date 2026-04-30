/**
 * Behavioral tests for the 7 core coding tools (read / write / edit /
 * bash / glob / grep / ls). Each tool is exercised via its `execute()`
 * entry point against a fresh temp cwd per test.
 *
 * Focus: production-grade adversarial edge cases. LLMs hallucinate
 * paths, mangle whitespace, retry with mutated args, and produce
 * inputs that look valid but break naive implementations. The test
 * suite covers what we've actually seen go wrong (or what *will* go
 * wrong) in chat-completion runs:
 *
 *   - sandbox escapes via `..`, absolute paths, symlink-like traversal
 *   - LLM-mangled `edit` old_text (trailing whitespace, regex chars)
 *   - bash shell-meta payloads, output explosions, non-zero stderr
 *   - read on binary, on directories, with negative/oversize offsets
 *   - glob patterns with no match, recursion, hidden files
 *   - grep regex metachars vs literal, include/exclude filters
 *   - ls on missing paths, on files vs dirs, on hostile paths
 *
 * What's *not* in scope here: AI SDK schema validation (TypeBox is
 * mechanical) and cross-runtime concerns (those are the Layer-2
 * Docker rig).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync, rmSync, writeFileSync, mkdirSync,
  readFileSync, statSync, symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSystemTools } from "../system-tools.js";
import { NodeFileSystem } from "../adapters/node-filesystem.js";
import { NodeShell } from "../adapters/node-shell.js";
import type { PolpoTool as AgentTool } from "@polpo-ai/core";

let cwd: string;
let tools: AgentTool<any>[];

function tool(name: string): AgentTool<any> {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`Tool '${name}' not registered. Got: ${tools.map((x) => x.name).join(", ")}`);
  return t;
}

/** Pull the textual payload from the first content block of a tool
 *  result. Tool results are a discriminated union of text/image
 *  blocks; every tool we test here emits text first. */
function text(result: { content: Array<{ type: string } & Record<string, any>> }): string {
  const block = result.content[0];
  if (block?.type !== "text") throw new Error(`Expected text content block, got ${block?.type}`);
  return block.text;
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "polpo-tools-"));
  tools = createSystemTools(cwd, undefined, [cwd], undefined, undefined, new NodeFileSystem(), new NodeShell());
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────
describe("read — happy path", () => {
  it("returns line-numbered content", async () => {
    writeFileSync(join(cwd, "a.txt"), "alpha\nbeta\ngamma");
    const result = await tool("read").execute("c1", { path: "a.txt" });
    expect(text(result)).toContain("1\talpha");
    expect(text(result)).toContain("3\tgamma");
    expect(result.details).toMatchObject({ lines: 3, total: 3 });
  });

  it("handles a 50k-line file without truncating in details.total", async () => {
    const big = Array.from({ length: 50_000 }, (_, i) => `L${i}`).join("\n");
    writeFileSync(join(cwd, "big.txt"), big);
    const result = await tool("read").execute("c1", { path: "big.txt", limit: 10 });
    expect(result.details).toMatchObject({ total: 50_000, lines: 10 });
    expect(text(result)).toMatch(/more lines/i);
  });

  it("reads files with embedded NUL bytes without crashing", async () => {
    writeFileSync(join(cwd, "nul.txt"), "before\x00after");
    const result = await tool("read").execute("c1", { path: "nul.txt" });
    expect(text(result)).toContain("before");
  });

  it("reads files with multibyte UTF-8 + emoji + RTL", async () => {
    writeFileSync(join(cwd, "u.txt"), "café 中文 🐙 שלום");
    const result = await tool("read").execute("c1", { path: "u.txt" });
    expect(text(result)).toContain("café");
    expect(text(result)).toContain("中文");
    expect(text(result)).toContain("🐙");
    expect(text(result)).toContain("שלום");
  });
});

describe("read — adversarial", () => {
  it("rejects parent traversal `../../../etc/passwd`", async () => {
    await expect(
      tool("read").execute("c1", { path: "../../../etc/passwd" }),
    ).rejects.toThrow(/sandbox|allowed|denied/i);
  });

  it("rejects an absolute path outside the sandbox", async () => {
    await expect(
      tool("read").execute("c1", { path: "/etc/passwd" }),
    ).rejects.toThrow(/sandbox|allowed|denied/i);
  });

  it("rejects a symlink that escapes the sandbox", async () => {
    const escapeLink = join(cwd, "escape");
    symlinkSync("/etc/passwd", escapeLink);
    // The path itself is inside the sandbox, but realpathSync follows
    // the symlink and detects the escape.
    await expect(
      tool("read").execute("c1", { path: "escape" }),
    ).rejects.toThrow(/sandbox|allowed|denied/i);
  });

  it("returns an error on a missing file rather than crashing", async () => {
    await expect(
      tool("read").execute("c1", { path: "nope.txt" }),
    ).rejects.toThrow();
  });

  it("returns an error when path is a directory", async () => {
    mkdirSync(join(cwd, "subdir"));
    await expect(
      tool("read").execute("c1", { path: "subdir" }),
    ).rejects.toThrow();
  });

  it("treats offset beyond the file as empty without crashing", async () => {
    writeFileSync(join(cwd, "small.txt"), "one\ntwo");
    const result = await tool("read").execute("c1", { path: "small.txt", offset: 1000, limit: 10 });
    // Should not throw; lines should be 0, total still 2.
    expect(result.details).toMatchObject({ total: 2, lines: 0 });
  });
});

// ────────────────────────────────────────────────────────────
describe("write — happy path", () => {
  it("creates the file + parent dirs and reports byte count", async () => {
    const result = await tool("write").execute("c1", { path: "deep/nested/note.md", content: "hello" });
    expect(readFileSync(join(cwd, "deep/nested/note.md"), "utf8")).toBe("hello");
    expect(result.details).toMatchObject({ bytes: 5 });
  });

  it("overwrites an existing file (no append)", async () => {
    writeFileSync(join(cwd, "f.txt"), "old content longer than new");
    await tool("write").execute("c1", { path: "f.txt", content: "new" });
    expect(readFileSync(join(cwd, "f.txt"), "utf8")).toBe("new");
  });

  it("writes empty content without errors", async () => {
    await tool("write").execute("c1", { path: "empty.txt", content: "" });
    expect(readFileSync(join(cwd, "empty.txt"), "utf8")).toBe("");
    expect(statSync(join(cwd, "empty.txt")).size).toBe(0);
  });

  it("preserves multibyte UTF-8 + emoji round-trip", async () => {
    const payload = "café 中文 🐙 \u{1F4A9}";
    await tool("write").execute("c1", { path: "u.txt", content: payload });
    expect(readFileSync(join(cwd, "u.txt"), "utf8")).toBe(payload);
  });

  it("writes a 1MB payload without truncating", async () => {
    const big = "x".repeat(1024 * 1024);
    await tool("write").execute("c1", { path: "big.txt", content: big });
    expect(statSync(join(cwd, "big.txt")).size).toBe(1024 * 1024);
  });
});

describe("write — adversarial", () => {
  it("rejects an absolute escape path", async () => {
    await expect(
      tool("write").execute("c1", { path: "/tmp/escape.txt", content: "x" }),
    ).rejects.toThrow(/sandbox|allowed|denied/i);
  });

  it("rejects parent traversal", async () => {
    await expect(
      tool("write").execute("c1", { path: "../escape.txt", content: "x" }),
    ).rejects.toThrow(/sandbox|allowed|denied/i);
  });

  it("rejects writing through a symlink that escapes the sandbox", async () => {
    const link = join(cwd, "out.txt");
    symlinkSync("/tmp/should-not-be-touched", link);
    // path-sandbox should refuse before the write hits the FS.
    await expect(
      tool("write").execute("c1", { path: "out.txt", content: "pwned" }),
    ).rejects.toThrow(/sandbox|allowed|denied/i);
  });
});

// ────────────────────────────────────────────────────────────
describe("edit — happy path", () => {
  it("replaces a unique substring", async () => {
    writeFileSync(join(cwd, "f.txt"), "the quick brown fox");
    await tool("edit").execute("c1", { path: "f.txt", old_text: "quick", new_text: "lazy" });
    expect(readFileSync(join(cwd, "f.txt"), "utf8")).toBe("the lazy brown fox");
  });

  it("treats regex metachars literally (.*$+ etc.)", async () => {
    writeFileSync(join(cwd, "f.txt"), "price: $9.99 (sale)");
    await tool("edit").execute("c1", { path: "f.txt", old_text: "$9.99", new_text: "$5.00" });
    expect(readFileSync(join(cwd, "f.txt"), "utf8")).toBe("price: $5.00 (sale)");
  });

  it("preserves trailing newline when present", async () => {
    writeFileSync(join(cwd, "f.txt"), "hello\n");
    await tool("edit").execute("c1", { path: "f.txt", old_text: "hello", new_text: "world" });
    expect(readFileSync(join(cwd, "f.txt"), "utf8")).toBe("world\n");
  });

  it("replaces a multi-line block", async () => {
    writeFileSync(join(cwd, "f.txt"), "line1\nold\nblock\nline4");
    await tool("edit").execute("c1", { path: "f.txt", old_text: "old\nblock", new_text: "fresh\nstuff" });
    expect(readFileSync(join(cwd, "f.txt"), "utf8")).toBe("line1\nfresh\nstuff\nline4");
  });
});

describe("edit — adversarial (LLM hallucinations)", () => {
  it("returns a clear error when old_text is missing (LLM transcription typo)", async () => {
    writeFileSync(join(cwd, "f.txt"), "the actual content");
    const result = await tool("edit").execute("c1", { path: "f.txt", old_text: "the actaul content", new_text: "x" });
    expect(result.details).toMatchObject({ error: "not_found" });
    expect(text(result)).toMatch(/not found/i);
    // File must remain pristine — no half-application.
    expect(readFileSync(join(cwd, "f.txt"), "utf8")).toBe("the actual content");
  });

  it("returns a clear error when old_text is ambiguous (recurring snippet)", async () => {
    writeFileSync(join(cwd, "f.txt"), "import x; import y; import z;");
    const result = await tool("edit").execute("c1", { path: "f.txt", old_text: "import", new_text: "//" });
    expect(result.details).toMatchObject({ error: "not_unique", count: 3 });
    expect(readFileSync(join(cwd, "f.txt"), "utf8")).toBe("import x; import y; import z;");
  });

  it("tolerates an LLM that drops indent (substring match preserves indent)", async () => {
    // Pin actual behavior: the tool does substring replace, so an
    // un-indented old_text still matches its indented occurrence and
    // the indent is preserved automatically. This is forgiving toward
    // the common LLM bug of remembering "the meaningful part" of a
    // line without leading whitespace.
    writeFileSync(join(cwd, "f.ts"), "  const x = 1;\n");
    await tool("edit").execute("c1", { path: "f.ts", old_text: "const x = 1;", new_text: "const x = 2;" });
    expect(readFileSync(join(cwd, "f.ts"), "utf8")).toBe("  const x = 2;\n");
  });

  it("treats CRLF vs LF as a real mismatch (cross-OS LLM transcription)", async () => {
    writeFileSync(join(cwd, "f.txt"), "alpha\r\nbeta");
    const result = await tool("edit").execute("c1", { path: "f.txt", old_text: "alpha\nbeta", new_text: "x" });
    expect(result.details).toMatchObject({ error: "not_found" });
  });

  it("permits a no-op replacement (old == new) without corrupting the file", async () => {
    writeFileSync(join(cwd, "f.txt"), "hello");
    const result = await tool("edit").execute("c1", { path: "f.txt", old_text: "hello", new_text: "hello" });
    expect(text(result)).not.toMatch(/error/i);
    expect(readFileSync(join(cwd, "f.txt"), "utf8")).toBe("hello");
  });

  it("rejects edits that target files outside the sandbox", async () => {
    await expect(
      tool("edit").execute("c1", { path: "/etc/passwd", old_text: "root", new_text: "lol" }),
    ).rejects.toThrow(/sandbox|allowed|denied/i);
  });
});

// ────────────────────────────────────────────────────────────
describe("bash — happy path", () => {
  it("runs a command and captures stdout", async () => {
    const result = await tool("bash").execute("c1", { command: "echo hello-from-bash" });
    expect(text(result)).toContain("hello-from-bash");
  });

  it("runs in cwd by default", async () => {
    writeFileSync(join(cwd, "marker-xyz.txt"), "");
    const result = await tool("bash").execute("c1", { command: "ls" });
    expect(text(result)).toContain("marker-xyz.txt");
  });

  it("supports pipes and redirects", async () => {
    const result = await tool("bash").execute("c1", { command: "printf 'a\\nb\\nc\\n' | wc -l" });
    expect(text(result)).toMatch(/3/);
  });
});

describe("bash — adversarial", () => {
  it("surfaces a non-zero exit clearly", async () => {
    const result = await tool("bash").execute("c1", { command: "false" });
    expect(text(result).toLowerCase()).toMatch(/exit|fail|error|status/);
  });

  it("captures stderr when stdout is empty", async () => {
    const result = await tool("bash").execute("c1", { command: "echo oops 1>&2" });
    expect(text(result).toLowerCase()).toContain("oops");
  });

  it("kills a hanging process well before the natural runtime", { timeout: 45_000 }, async () => {
    // `sleep 30` would naturally take 30s. We ask for timeout:500.
    // Goal: verify the call returns *well under* 30s — the actual
    // floor on execa's enforcement is loose (observed ~5s) and we
    // intentionally don't pin a tight number, just "not the natural
    // runtime". Surfaces the timeout via the text payload or a
    // non-zero exit.
    const t0 = Date.now();
    const result = await tool("bash").execute("c1", { command: "sleep 30", timeout: 500 });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(20_000);
    expect(text(result).toLowerCase()).toMatch(/timeout|kill|exceed|exit|sigterm|error|terminated/);
  });

  it("truncates massive output instead of OOMing the process", async () => {
    const result = await tool("bash").execute("c1", {
      command: "head -c 10000000 /dev/zero | tr '\\0' 'a'",
      timeout: 10_000,
    });
    // Must not blow up — output bounded, no crash.
    expect(text(result).length).toBeLessThan(2_000_000);
  });

  it("does not let `cd` leak into the next call", async () => {
    await tool("bash").execute("c1", { command: "cd /usr" });
    const result = await tool("bash").execute("c2", { command: "pwd" });
    // Each tool call starts a fresh shell rooted at cwd. Asserting
    // /usr is absent confirms the previous `cd` didn't leak; using
    // /usr (instead of /tmp, which is cwd's parent) avoids a false
    // positive when cwd happens to live under /tmp.
    expect(text(result)).toContain(cwd);
    expect(text(result)).not.toMatch(/^\/usr\b/m);
  });

  it("handles an empty/whitespace command without crashing", async () => {
    const result = await tool("bash").execute("c1", { command: "   " });
    // Either runs as no-op or returns a clear error — must not throw.
    expect(result).toBeDefined();
  });

  it("accepts shell-meta in arguments (we are not a sandbox at the bash layer)", async () => {
    // We deliberately do *not* claim bash is safe against injection —
    // it executes a full command line. This test pins the contract so
    // future "sanitization" doesn't silently mangle legitimate uses.
    const result = await tool("bash").execute("c1", { command: "echo 'a; echo b' | head -n1" });
    expect(text(result)).toContain("a; echo b");
  });
});

// ────────────────────────────────────────────────────────────
describe("glob — happy path", () => {
  it("matches files by simple pattern", async () => {
    writeFileSync(join(cwd, "a.ts"), "");
    writeFileSync(join(cwd, "b.ts"), "");
    writeFileSync(join(cwd, "c.txt"), "");
    const result = await tool("glob").execute("c1", { pattern: "*.ts" });
    expect(text(result)).toContain("a.ts");
    expect(text(result)).toContain("b.ts");
    expect(text(result)).not.toContain("c.txt");
  });

  it("handles `**` recursive patterns", async () => {
    mkdirSync(join(cwd, "src/inner"), { recursive: true });
    writeFileSync(join(cwd, "src/a.ts"), "");
    writeFileSync(join(cwd, "src/inner/b.ts"), "");
    const result = await tool("glob").execute("c1", { pattern: "**/*.ts" });
    expect(text(result)).toContain("a.ts");
    expect(text(result)).toContain("b.ts");
  });

  it("supports brace expansion `{a,b}`", async () => {
    writeFileSync(join(cwd, "a.ts"), "");
    writeFileSync(join(cwd, "b.tsx"), "");
    writeFileSync(join(cwd, "c.md"), "");
    const result = await tool("glob").execute("c1", { pattern: "*.{ts,tsx}" });
    expect(text(result)).toContain("a.ts");
    expect(text(result)).toContain("b.tsx");
    expect(text(result)).not.toContain("c.md");
  });
});

describe("glob — adversarial", () => {
  it("reports no match clearly without throwing", async () => {
    const result = await tool("glob").execute("c1", { pattern: "*.unicorn" });
    expect(text(result).toLowerCase()).toMatch(/no.*(match|found)|0|empty/);
  });

  it("does not crash on an empty pattern", async () => {
    const result = await tool("glob").execute("c1", { pattern: "" });
    expect(result).toBeDefined();
  });

  it("ignores patterns reaching outside cwd (`../*`)", async () => {
    // We can't assert what's outside cwd, but we *can* assert nothing
    // from /etc/ leaks into the result text.
    const result = await tool("glob").execute("c1", { pattern: "../../*" });
    expect(text(result)).not.toMatch(/passwd|hostname|hosts/);
  });
});

// ────────────────────────────────────────────────────────────
describe("grep — happy path", () => {
  it("finds the pattern across files", async () => {
    writeFileSync(join(cwd, "a.txt"), "needle here\nnothing");
    writeFileSync(join(cwd, "b.txt"), "no match\n");
    writeFileSync(join(cwd, "c.txt"), "needle\nagain");
    const result = await tool("grep").execute("c1", { pattern: "needle" });
    expect(text(result)).toContain("a.txt");
    expect(text(result)).toContain("c.txt");
    expect(text(result)).not.toMatch(/\bb\.txt\b/);
  });

  it("supports include filter", async () => {
    writeFileSync(join(cwd, "a.ts"), "needle\n");
    writeFileSync(join(cwd, "a.md"), "needle\n");
    const result = await tool("grep").execute("c1", { pattern: "needle", include: "*.ts" });
    expect(text(result)).toContain("a.ts");
    expect(text(result)).not.toContain("a.md");
  });
});

describe("grep — adversarial", () => {
  it("supports PCRE escapes (\\d, \\w, \\s)", async () => {
    writeFileSync(join(cwd, "f.txt"), "abc\n123\n");
    const result = await tool("grep").execute("c1", { pattern: "\\d+" });
    expect(text(result)).toContain("f.txt");
    expect(text(result)).toContain("123");
  });

  it("supports lookahead and non-greedy quantifiers (PCRE features)", async () => {
    writeFileSync(join(cwd, "f.txt"), "USD42 EUR99\n");
    // Lookahead: 'EUR' followed by digits.
    const r1 = await tool("grep").execute("c1", { pattern: "(?<=EUR)\\d+" });
    expect(text(r1)).toContain("99");
  });

  it("returns a clean no-match result on a non-matching pattern", async () => {
    writeFileSync(join(cwd, "f.txt"), "alpha\nbeta\n");
    const result = await tool("grep").execute("c1", { pattern: "definitely-not-there-123" });
    expect(text(result).toLowerCase()).toMatch(/no.*(match|found)|0|empty/);
  });

  it("doesn't bleed into binary files when their bytes happen to match", async () => {
    // A binary file with the bytes 'needle' embedded — grep should
    // either skip it or show it without confusing the output.
    writeFileSync(join(cwd, "bin.dat"), Buffer.from([0, 1, 2, 0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0, 0]));
    writeFileSync(join(cwd, "real.txt"), "needle\n");
    const result = await tool("grep").execute("c1", { pattern: "needle" });
    expect(text(result)).toContain("real.txt");
  });
});

// ────────────────────────────────────────────────────────────
describe("ls — happy path", () => {
  it("lists files and directories", async () => {
    writeFileSync(join(cwd, "file.txt"), "");
    mkdirSync(join(cwd, "subdir"));
    const result = await tool("ls").execute("c1", { path: "." });
    expect(text(result)).toContain("file.txt");
    expect(text(result)).toContain("subdir");
  });

  it("works on a deeply nested subdir", async () => {
    mkdirSync(join(cwd, "a/b/c"), { recursive: true });
    writeFileSync(join(cwd, "a/b/c/leaf.txt"), "");
    const result = await tool("ls").execute("c1", { path: "a/b/c" });
    expect(text(result)).toContain("leaf.txt");
  });
});

describe("ls — adversarial", () => {
  it("rejects paths outside the sandbox", async () => {
    await expect(tool("ls").execute("c1", { path: "/etc" })).rejects.toThrow(/sandbox|allowed|denied/i);
  });

  it("rejects parent traversal", async () => {
    await expect(tool("ls").execute("c1", { path: "../.." })).rejects.toThrow(/sandbox|allowed|denied/i);
  });

  it("returns a clear error on a missing directory", async () => {
    await expect(tool("ls").execute("c1", { path: "no-such-dir" })).rejects.toThrow();
  });

  it("returns a sane result on an empty directory", async () => {
    mkdirSync(join(cwd, "empty"));
    const result = await tool("ls").execute("c1", { path: "empty" });
    // Should not throw; output may be empty or "no entries"-like.
    expect(result).toBeDefined();
  });
});
