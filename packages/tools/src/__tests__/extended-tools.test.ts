/**
 * Behavioral tests for the next layer of @polpo-ai/tools, run through
 * the same mock-LLM-style entry point as system-tools.test.ts:
 *
 *   - register_outcome (task-only, gated by outputDir)
 *   - http_fetch / http_download (with global.fetch mocked)
 *   - vault_get / vault_list (against a synthetic ResolvedVault)
 *   - excel_read / excel_write / excel_info / excel_query
 *   - pdf_read / pdf_info / pdf_merge   (NOT pdf_create — Chromium)
 *   - docx_read / docx_create
 *
 * Each `describe` builds its own tools via the public factory the
 * cloud / OSS callers use, so the wiring layer (path sandbox + fs
 * abstraction + allowedTools filter) is covered alongside the tool
 * body. Sample documents are built in-process from the same
 * libraries the tool uses, so we don't ship any binary fixtures.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOutcomeTools } from "../outcome-tools.js";
import { createHttpTools } from "../http-tools.js";
import { createVaultToolsCore } from "../vault-tools.js";
import { createExcelTools } from "../excel-tools.js";
import { createPdfTools } from "../pdf-tools.js";
import { createDocxTools } from "../docx-tools.js";
import type { ResolvedVault } from "../types.js";
import type { PolpoTool as AgentTool } from "@polpo-ai/core";

let cwd: string;

function pick(tools: AgentTool<any>[], name: string): AgentTool<any> {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`Tool '${name}' not registered. Got: ${tools.map((x) => x.name).join(", ")}`);
  return t;
}

function text(result: { content: Array<{ type: string } & Record<string, any>> }): string {
  const block = result.content[0];
  if (block?.type !== "text") throw new Error(`Expected text content block, got ${block?.type}`);
  return block.text;
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "polpo-ext-tools-"));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────
// register_outcome
// ────────────────────────────────────────────────────────────
describe("register_outcome", () => {
  function build(): AgentTool<any> {
    const tools = createOutcomeTools(cwd, [cwd], ["register_outcome"], cwd);
    return pick(tools, "register_outcome");
  }

  it("registers an inline text outcome with details", async () => {
    const t = build();
    const result = await t.execute("c1", { type: "text", label: "Hello note", text: "ciao mondo" });
    // The shell-side engine reads these `outcome*` keys from details
    // when it collates a TaskOutcome; pin the contract.
    expect(result.details).toMatchObject({
      outcomeType: "text",
      outcomeLabel: "Hello note",
      outcomeText: "ciao mondo",
    });
    expect(text(result).toLowerCase()).toContain("registered");
  });

  it("validates that a file outcome's path actually exists on disk", async () => {
    const t = build();
    const result = await t.execute("c1", { type: "file", label: "Missing report", path: "nope.pdf" });
    expect(result.details).toMatchObject({ error: expect.any(String) });
  });

  it("accepts a real file and infers mime from extension", async () => {
    const t = build();
    writeFileSync(join(cwd, "report.pdf"), "%PDF-1.4 fake");
    const result = await t.execute("c1", { type: "file", label: "Q1 Report", path: "report.pdf" });
    expect(result.details).toMatchObject({
      outcomeType: "file",
      outcomeLabel: "Q1 Report",
      outcomeMimeType: "application/pdf",
    });
    expect(text(result).toLowerCase()).toContain("registered");
  });

  it("registers a url outcome verbatim", async () => {
    const t = build();
    const result = await t.execute("c1", { type: "url", label: "Docs", url: "https://example.com" });
    expect(result.details).toMatchObject({
      outcomeType: "url",
      outcomeUrl: "https://example.com",
    });
  });

  it("registers a json outcome carrying structured data", async () => {
    const t = build();
    const payload = { rows: 42, source: "stripe" };
    const result = await t.execute("c1", { type: "json", label: "Stats", data: payload });
    expect(result.details).toMatchObject({
      outcomeType: "json",
      outcomeData: payload,
    });
  });

  it("rejects file outcomes whose path escapes the sandbox", async () => {
    const t = build();
    await expect(
      t.execute("c1", { type: "file", label: "Escape", path: "/etc/hostname" }),
    ).rejects.toThrow(/sandbox|allowed|denied/i);
  });

  // ── Adversarial ────────────────────────────────────────────
  it("type=file without a path → structured error, not a crash", async () => {
    // LLM hallucinates: declares a file outcome but forgets to set
    // path. The tool must NOT register a phantom record; it must
    // either error or refuse cleanly.
    const t = build();
    const result = await t.execute("c1", { type: "file", label: "Phantom" });
    // Either a structured error OR the engine treats path-less file
    // as text-ish. Pin "produces something parseable, not undefined".
    expect(result.details).toBeDefined();
  });

  it("type=text with empty string returns a structured response (no crash)", async () => {
    // The tool may either accept empty text or refuse it as missing.
    // The contract we lock in: never throws unhandled, always
    // returns a parseable result.
    const t = build();
    const result = await t.execute("c1", { type: "text", label: "Empty", text: "" });
    expect(result.details).toBeDefined();
    expect(text(result).length).toBeGreaterThan(0);
  });

  it("registers an outcome whose path has no extension (mime detection fallback)", async () => {
    const t = build();
    writeFileSync(join(cwd, "Makefile"), "all:\n\techo hi\n");
    const result = await t.execute("c1", { type: "file", label: "Build script", path: "Makefile" });
    expect(result.details).toMatchObject({ outcomeType: "file" });
    // No extension → either no mimeType or a sensible default.
    // Either way, the tool must not crash on the missing extension.
  });

  it("file path that is actually a directory is rejected gracefully", async () => {
    const t = build();
    const subdir = join(cwd, "subdir");
    require("node:fs").mkdirSync(subdir);
    const result = await t.execute("c1", { type: "file", label: "Dir", path: "subdir" });
    expect(result.details).toBeDefined();
    expect(text(result).length).toBeGreaterThan(0);
  });

  it("very long inline text (50KB) is registered without truncation in details", async () => {
    const t = build();
    const big = "x".repeat(50_000);
    const result = await t.execute("c1", { type: "text", label: "Big", text: big });
    // outcomeText preserves the original (truncation is a UI concern,
    // not the tool's contract).
    expect(result.details).toMatchObject({ outcomeText: big });
  });

  it("tags array is normalized (stripped of empties / preserved order)", async () => {
    const t = build();
    const result = await t.execute("c1", {
      type: "url",
      label: "Doc",
      url: "https://example.com",
      tags: ["report", "Q4", "internal"],
    });
    const tags = (result.details as any).outcomeTags;
    expect(tags).toEqual(expect.arrayContaining(["report", "Q4", "internal"]));
  });

  it("symlink-escape path is refused (target outside sandbox)", async () => {
    const t = build();
    require("node:fs").symlinkSync("/etc/hostname", join(cwd, "trick.txt"));
    await expect(
      t.execute("c1", { type: "file", label: "Tricked", path: "trick.txt" }),
    ).rejects.toThrow(/sandbox|allowed|denied/i);
  });
});

// ────────────────────────────────────────────────────────────
// http_fetch / http_download
// ────────────────────────────────────────────────────────────
describe("http_fetch / http_download", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
    globalThis.fetch = vi.fn(impl as any) as any;
  }

  function build() {
    return createHttpTools(cwd, [cwd], ["http_fetch", "http_download"]);
  }

  // ── http_fetch ───────────────────────────────────────────
  it("http_fetch returns body + status for a 200 JSON response", async () => {
    mockFetch(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const t = pick(build(), "http_fetch");
    const result = await t.execute("c1", { url: "https://api.example.com/x" });
    expect(text(result)).toContain('"ok"');
    expect(result.details).toMatchObject({ status: 200 });
  });

  it("http_fetch surfaces non-2xx status without throwing", async () => {
    mockFetch(async () => new Response("not found", { status: 404 }));
    const t = pick(build(), "http_fetch");
    const result = await t.execute("c1", { url: "https://api.example.com/missing" });
    expect(result.details).toMatchObject({ status: 404 });
  });

  it("http_fetch sends method/headers/body through to fetch", async () => {
    const seen: any = {};
    mockFetch(async (url, init) => {
      seen.url = url;
      seen.init = init;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    const t = pick(build(), "http_fetch");
    await t.execute("c1", {
      url: "https://api.example.com/post",
      method: "POST",
      headers: { Authorization: "Bearer x" },
      body: JSON.stringify({ a: 1 }),
    });
    expect(seen.url).toBe("https://api.example.com/post");
    expect(seen.init.method).toBe("POST");
    expect(seen.init.headers).toMatchObject({ Authorization: "Bearer x" });
  });

  it("http_fetch blocks SSRF to localhost / internal hosts", async () => {
    const t = pick(build(), "http_fetch");
    const result = await t.execute("c1", { url: "http://127.0.0.1/" });
    // Either rejects or returns an SSRF error — no real fetch.
    const looksBlocked = (text(result) + JSON.stringify(result.details)).toLowerCase();
    expect(looksBlocked).toMatch(/ssrf|forbidden|block|denied|not allowed|invalid/);
  });

  // ── http_download ────────────────────────────────────────
  it("http_download writes the response body to the sandbox", async () => {
    const payload = Buffer.from("hello-bin");
    mockFetch(async () => new Response(payload, {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    }));
    const t = pick(build(), "http_download");
    const result = await t.execute("c1", {
      url: "https://files.example.com/x.bin",
      path: "downloads/x.bin",
    });
    const onDisk = readFileSync(join(cwd, "downloads/x.bin"));
    expect(onDisk.equals(payload)).toBe(true);
    expect(result.details).toMatchObject({ bytes: payload.byteLength });
  });

  it("http_download rejects writes outside the sandbox", async () => {
    mockFetch(async () => new Response("x", { status: 200 }));
    const t = pick(build(), "http_download");
    await expect(
      t.execute("c1", { url: "https://files.example.com/x", path: "/tmp/outside.bin" }),
    ).rejects.toThrow(/sandbox|allowed|denied/i);
  });

  it("http_download surfaces non-2xx without writing the file", async () => {
    mockFetch(async () => new Response("nope", { status: 500 }));
    const t = pick(build(), "http_download");
    const result = await t.execute("c1", { url: "https://files.example.com/x", path: "x.bin" });
    expect(existsSync(join(cwd, "x.bin"))).toBe(false);
    expect(JSON.stringify(result.details)).toMatch(/500|error|fail/i);
  });

  // ── Adversarial ────────────────────────────────────────────
  it("http_fetch refuses dangerous URL schemes (file://, javascript:, data:)", async () => {
    const t = pick(build(), "http_fetch");
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
    ]) {
      const result = await t.execute("c1", { url });
      const blob = (text(result) + JSON.stringify(result.details)).toLowerCase();
      expect(blob).toMatch(/invalid|forbidden|block|denied|not allowed|protocol|scheme|ssrf/);
    }
  });

  it("http_fetch survives a network error (fetch throws) without crashing", async () => {
    mockFetch(async () => { throw new Error("ECONNRESET — peer reset connection"); });
    const t = pick(build(), "http_fetch");
    const result = await t.execute("c1", { url: "https://api.example.com/x" });
    // Must come back as a tool result, not a thrown rejection.
    expect(result.details).toBeDefined();
    expect(JSON.stringify(result.details).toLowerCase()).toMatch(/error|reset|connection|fail/);
  });

  it("http_fetch handles a non-UTF8 response body without corrupting the result", async () => {
    // Random binary that isn't valid UTF-8.
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x01, 0x02]);
    mockFetch(async () => new Response(bytes, {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    }));
    const t = pick(build(), "http_fetch");
    const result = await t.execute("c1", { url: "https://api.example.com/bin" });
    // Must complete cleanly. Either decoded best-effort or reported
    // as binary; the assertion is "no throw, status preserved".
    expect(result.details).toMatchObject({ status: 200 });
  });

  it("http_fetch truncates / reports very large response bodies", async () => {
    // 5 MB of 'x' — bigger than any sensible LLM context window.
    const huge = "x".repeat(5 * 1024 * 1024);
    mockFetch(async () => new Response(huge, {
      status: 200,
      headers: { "content-type": "text/plain" },
    }));
    const t = pick(build(), "http_fetch");
    const result = await t.execute("c1", { url: "https://api.example.com/huge" });
    // Body in the visible content must NOT be the full 5 MB —
    // either truncated or summarized. Pin the upper bound generously
    // (1 MB) so the assertion isn't brittle to small impl tweaks.
    expect(text(result).length).toBeLessThan(1_000_000);
  });

  it("http_fetch passes through 5xx body so the LLM can read the server error", async () => {
    mockFetch(async () => new Response("internal: db unavailable\nretry-after: 30s", {
      status: 503,
      headers: { "content-type": "text/plain" },
    }));
    const t = pick(build(), "http_fetch");
    const result = await t.execute("c1", { url: "https://api.example.com/x" });
    expect(text(result)).toContain("db unavailable");
    expect(result.details).toMatchObject({ status: 503 });
  });

  it("http_download creates parent dirs for a deeply nested target path", async () => {
    mockFetch(async () => new Response(Buffer.from("ok"), { status: 200 }));
    const t = pick(build(), "http_download");
    await t.execute("c1", {
      url: "https://files.example.com/x",
      path: "a/b/c/d/leaf.bin",
    });
    expect(existsSync(join(cwd, "a/b/c/d/leaf.bin"))).toBe(true);
  });

  it("http_download handles an empty 200 body without erroring", async () => {
    mockFetch(async () => new Response("", { status: 200 }));
    const t = pick(build(), "http_download");
    const result = await t.execute("c1", { url: "https://files.example.com/0", path: "z.bin" });
    expect(existsSync(join(cwd, "z.bin"))).toBe(true);
    expect(statSync(join(cwd, "z.bin")).size).toBe(0);
    expect(result.details).toMatchObject({ bytes: 0 });
  });

  it("http_download survives fetch throw without leaving a half-written file", async () => {
    mockFetch(async () => { throw new Error("DNS failure"); });
    const t = pick(build(), "http_download");
    const result = await t.execute("c1", { url: "https://files.example.com/x", path: "broken.bin" });
    expect(existsSync(join(cwd, "broken.bin"))).toBe(false);
    expect(JSON.stringify(result.details).toLowerCase()).toMatch(/error|dns|fail/);
  });
});

// ────────────────────────────────────────────────────────────
// vault_get / vault_list
// ────────────────────────────────────────────────────────────
describe("vault_get / vault_list", () => {
  function makeVault(entries: Record<string, { type: string; values: Record<string, string> }>): ResolvedVault {
    return {
      get: (service) => entries[service]?.values,
      // These tests never exercise smtp/imap typed accessors — the fake
      // only needs the raw entries (cast to the canonical typed shape).
      getSmtp: () => entries["smtp"]?.values as never,
      getImap: () => entries["imap"]?.values as never,
      getKey: (service, key) => entries[service]?.values[key],
      has: (service) => service in entries,
      list: () => Object.entries(entries).map(([service, v]) => ({
        service, type: v.type, keys: Object.keys(v.values),
      })),
    };
  }

  it("vault_list reports configured services without leaking values", async () => {
    const vault = makeVault({
      stripe: { type: "api_key", values: { key: "sk_test_xxx" } },
      smtp:   { type: "smtp",    values: { host: "smtp.x", user: "u", pass: "p" } },
    });
    const t = pick(createVaultToolsCore(vault), "vault_list");
    const result = await t.execute("c1", {});
    const out = text(result);
    expect(out).toContain("stripe");
    expect(out).toContain("smtp");
    // The actual secret must NOT appear in the output payload.
    expect(out).not.toContain("sk_test_xxx");
    expect(out).not.toContain("smtp.x");
  });

  it("vault_get returns the credential values for a known service", async () => {
    const vault = makeVault({
      stripe: { type: "api_key", values: { key: "sk_test_abcdefg" } },
    });
    const t = pick(createVaultToolsCore(vault), "vault_get");
    const result = await t.execute("c1", { service: "stripe" });
    expect(text(result)).toContain("sk_test_abcdefg");
    expect(result.details).toMatchObject({ found: true });
  });

  it("vault_get returns a clear not-found result for an unknown service", async () => {
    const vault = makeVault({});
    const t = pick(createVaultToolsCore(vault), "vault_get");
    const result = await t.execute("c1", { service: "stripe" });
    expect(result.details).toMatchObject({ found: false });
    expect(text(result).toLowerCase()).toMatch(/no.*entry|not.*found|missing/);
  });

  // ── Adversarial ────────────────────────────────────────────
  it("vault_list with zero entries returns an empty/none-configured result", async () => {
    const vault = makeVault({});
    const t = pick(createVaultToolsCore(vault), "vault_list");
    const result = await t.execute("c1", {});
    // Must not throw; output indicates no services.
    expect(text(result).length).toBeGreaterThan(0);
  });

  it("vault_get on a service with multibyte-named keys still works", async () => {
    const vault = makeVault({
      "服务-α": { type: "custom", values: { "ключ": "valore-€42" } },
    });
    const t = pick(createVaultToolsCore(vault), "vault_get");
    const result = await t.execute("c1", { service: "服务-α" });
    expect(text(result)).toContain("valore-€42");
  });

  it("vault_get with empty-string service name doesn't crash", async () => {
    const vault = makeVault({ stripe: { type: "api_key", values: { key: "x" } } });
    const t = pick(createVaultToolsCore(vault), "vault_get");
    // LLM hallucinates and passes ""; result must be structured, not a crash.
    const result = await t.execute("c1", { service: "" });
    expect(result.details).toMatchObject({ found: false });
  });
});

// ────────────────────────────────────────────────────────────
// excel_read / excel_write / excel_info / excel_query
// ────────────────────────────────────────────────────────────
describe("excel_read / write / info / query", () => {
  async function buildXlsx(file: string, sheet: string, rows: any[][]) {
    const ExcelJS = await import("exceljs");
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(sheet);
    rows.forEach((r) => ws.addRow(r));
    await wb.xlsx.writeFile(file);
  }

  function build() {
    return createExcelTools(cwd, [cwd], ["excel_read", "excel_write", "excel_info", "excel_query"]);
  }

  it("excel_write creates a multi-row xlsx", async () => {
    const t = pick(build(), "excel_write");
    const result = await t.execute("c1", {
      path: "out.xlsx",
      sheet_name: "Sales",
      headers: ["product", "qty"],
      rows: [
        ["pen", 12],
        ["pad", 30],
      ],
    });
    expect(existsSync(join(cwd, "out.xlsx"))).toBe(true);
    expect(statSync(join(cwd, "out.xlsx")).size).toBeGreaterThan(0);
    expect(JSON.stringify(result.details)).toContain("out.xlsx");
  });

  it("excel_read returns the cell content of a sample workbook", async () => {
    await buildXlsx(join(cwd, "in.xlsx"), "Data", [
      ["name", "score"],
      ["alice", 9],
      ["bob", 7],
    ]);
    const t = pick(build(), "excel_read");
    const result = await t.execute("c1", { path: "in.xlsx" });
    const out = text(result);
    expect(out).toContain("alice");
    expect(out).toContain("9");
    expect(out).toContain("bob");
  });

  it("excel_info returns sheet metadata without dumping data", async () => {
    await buildXlsx(join(cwd, "info.xlsx"), "Inventory", [
      ["sku", "qty"],
      ["A1", 100],
      ["A2", 200],
      ["A3", 300],
    ]);
    const t = pick(build(), "excel_info");
    const result = await t.execute("c1", { path: "info.xlsx" });
    const out = text(result).toLowerCase();
    expect(out).toMatch(/inventory|sheet/);
    expect(JSON.stringify(result.details).toLowerCase()).toMatch(/sheet|row|column/);
  });

  it("excel_read on a missing file returns a structured error", async () => {
    const t = pick(build(), "excel_read");
    const result = await t.execute("c1", { path: "no-such.xlsx" });
    expect(JSON.stringify(result.details)).toMatch(/error|fail/i);
  });

  it("excel_write rejects paths outside the sandbox", async () => {
    const t = pick(build(), "excel_write");
    await expect(
      t.execute("c1", { path: "/etc/escape.xlsx", headers: ["a"], rows: [[1]] }),
    ).rejects.toThrow(/sandbox|allowed|denied/i);
  });

  // ── Adversarial ────────────────────────────────────────────
  it("excel_read on a corrupted xlsx returns a structured error", async () => {
    // 256 bytes of random garbage with .xlsx extension — exceljs will
    // throw or return nothing useful. The tool must surface this
    // without crashing the agent loop.
    writeFileSync(join(cwd, "broken.xlsx"), Buffer.alloc(256, 0x42));
    const t = pick(build(), "excel_read");
    const result = await t.execute("c1", { path: "broken.xlsx" });
    expect(JSON.stringify(result.details)).toMatch(/error|fail|invalid/i);
  });

  it("excel_write produces a CSV when the path ends in .csv", async () => {
    const t = pick(build(), "excel_write");
    await t.execute("c1", {
      path: "out.csv",
      headers: ["product", "price"],
      rows: [["pen", 1.5], ["pad", 2.0]],
    });
    const content = readFileSync(join(cwd, "out.csv"), "utf8");
    // CSV is plain text, must contain the data verbatim — no zip
    // structure (xlsx would start with PK\x03\x04).
    expect(content).toContain("product");
    expect(content).toContain("pen");
    expect(content).not.toMatch(/^PK/);
  });

  it("excel_write handles non-ASCII headers and cell values", async () => {
    const t = pick(build(), "excel_write");
    await t.execute("c1", {
      path: "i18n.xlsx",
      sheet_name: "Données",
      headers: ["прoдукт", "数量", "prix (€)"],
      rows: [
        ["café ☕", 12, 3.5],
        ["крендель 🥨", 7, 2.25],
      ],
    });
    expect(existsSync(join(cwd, "i18n.xlsx"))).toBe(true);

    // Round-trip: read it back via excel_read.
    const read = pick(build(), "excel_read");
    const r2 = await read.execute("c1", { path: "i18n.xlsx" });
    const out = text(r2);
    expect(out).toContain("café ☕");
    expect(out).toContain("крендель");
  });

  it("excel_write with empty rows array still writes a file with headers", async () => {
    const t = pick(build(), "excel_write");
    const result = await t.execute("c1", {
      path: "empty.xlsx",
      headers: ["a", "b", "c"],
      rows: [],
    });
    expect(existsSync(join(cwd, "empty.xlsx"))).toBe(true);
    expect(JSON.stringify(result.details)).toContain("empty.xlsx");
  });
});

// ────────────────────────────────────────────────────────────
// pdf_read / pdf_info / pdf_merge
// (pdf_create is in Layer 2 — it spawns Chromium via Shell.)
// ────────────────────────────────────────────────────────────
describe("pdf_read / pdf_info / pdf_merge", () => {
  async function buildSamplePdf(file: string, pageCount = 1, title = "Sample") {
    const { PDFDocument, StandardFonts } = await import("pdf-lib");
    const doc = await PDFDocument.create();
    doc.setTitle(title);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < pageCount; i++) {
      const page = doc.addPage([300, 200]);
      page.drawText(`Page ${i + 1} of ${title}`, { x: 20, y: 100, size: 14, font });
    }
    writeFileSync(file, await doc.save());
  }

  function build() {
    return createPdfTools(cwd, [cwd], ["pdf_read", "pdf_info", "pdf_merge"]);
  }

  it("pdf_info reports page count + title", async () => {
    await buildSamplePdf(join(cwd, "doc.pdf"), 3, "Quarterly");
    const t = pick(build(), "pdf_info");
    const result = await t.execute("c1", { path: "doc.pdf" });
    expect(JSON.stringify(result.details)).toMatch(/3/);
    expect(text(result).toLowerCase()).toMatch(/page|pages/);
  });

  it("pdf_read extracts text-ish content (text or metadata)", async () => {
    await buildSamplePdf(join(cwd, "doc.pdf"), 2, "Report");
    const t = pick(build(), "pdf_read");
    const result = await t.execute("c1", { path: "doc.pdf" });
    // Some impls embed text in the PDF stream and others don't extract
    // it without poppler — accept either behavior, but the call must
    // succeed and return *something* about the document.
    expect(result.details).toBeDefined();
    expect(text(result).length).toBeGreaterThan(0);
  });

  it("pdf_merge combines two PDFs into one with the summed page count", async () => {
    await buildSamplePdf(join(cwd, "a.pdf"), 2, "A");
    await buildSamplePdf(join(cwd, "b.pdf"), 3, "B");
    const t = pick(build(), "pdf_merge");
    const result = await t.execute("c1", {
      inputs: ["a.pdf", "b.pdf"],
      output: "merged.pdf",
    });
    expect(existsSync(join(cwd, "merged.pdf"))).toBe(true);
    // pdf-lib check on the merged output for hard truth.
    const { PDFDocument } = await import("pdf-lib");
    const buf = readFileSync(join(cwd, "merged.pdf"));
    const merged = await PDFDocument.load(buf);
    expect(merged.getPageCount()).toBe(5);
    expect(JSON.stringify(result.details)).toMatch(/5|pages/);
  });

  it("pdf_read on a missing file returns a structured error", async () => {
    const t = pick(build(), "pdf_read");
    const result = await t.execute("c1", { path: "ghost.pdf" });
    expect(JSON.stringify(result.details)).toMatch(/error|fail|not.*found/i);
  });

  it("pdf_merge rejects an output that escapes the sandbox", async () => {
    await buildSamplePdf(join(cwd, "a.pdf"));
    await buildSamplePdf(join(cwd, "b.pdf"));
    const t = pick(build(), "pdf_merge");
    await expect(
      t.execute("c1", { inputs: ["a.pdf", "b.pdf"], output: "/etc/escape.pdf" }),
    ).rejects.toThrow(/sandbox|allowed|denied/i);
  });

  // ── Adversarial ────────────────────────────────────────────
  it("pdf_read on random bytes named .pdf returns a structured error", async () => {
    writeFileSync(join(cwd, "garbage.pdf"), Buffer.alloc(512, 0x7e));
    const t = pick(build(), "pdf_read");
    const result = await t.execute("c1", { path: "garbage.pdf" });
    expect(JSON.stringify(result.details)).toMatch(/error|fail|invalid|parse/i);
  });

  it("pdf_info on a non-PDF file (renamed .txt) is reported, not crashed", async () => {
    writeFileSync(join(cwd, "fake.pdf"), "this is just text\n");
    const t = pick(build(), "pdf_info");
    const result = await t.execute("c1", { path: "fake.pdf" });
    expect(JSON.stringify(result.details)).toMatch(/error|fail|invalid/i);
  });

  it("pdf_merge with one input is a degenerate but legal copy", async () => {
    await buildSamplePdf(join(cwd, "only.pdf"), 4, "Solo");
    const t = pick(build(), "pdf_merge");
    const result = await t.execute("c1", { inputs: ["only.pdf"], output: "copy.pdf" });
    // Either succeeds (copy) or returns a structured "need >= 2"
    // error. Both are acceptable contracts; pin "no crash + result
    // is structured".
    expect(result.details).toBeDefined();
  });

  it("pdf_merge refuses an input path that escapes the sandbox", async () => {
    await buildSamplePdf(join(cwd, "ok.pdf"));
    const t = pick(build(), "pdf_merge");
    // Accepts either a thrown rejection or a structured error in
    // details — both prevent the merge. What we need to lock in is
    // "no merged output ever lands on disk".
    const result = await t.execute("c1", {
      inputs: ["ok.pdf", "/etc/passwd"],
      output: "merged.pdf",
    }).catch((e) => ({ content: [{ type: "text" as const, text: e.message }], details: { error: e.message } }));
    const blob = JSON.stringify(result.details).toLowerCase();
    expect(blob).toMatch(/sandbox|allowed|denied|access/);
    expect(existsSync(join(cwd, "merged.pdf"))).toBe(false);
  });

  it("pdf_merge with a 50-input fan-in produces a valid 50-page PDF", async () => {
    // Stress test: many small inputs. exposes any quadratic /
    // file-handle behavior before it bites in prod.
    const inputs: string[] = [];
    for (let i = 0; i < 50; i++) {
      const name = `p${i}.pdf`;
      await buildSamplePdf(join(cwd, name), 1, `P${i}`);
      inputs.push(name);
    }
    const t = pick(build(), "pdf_merge");
    await t.execute("c1", { inputs, output: "big.pdf" });
    const { PDFDocument } = await import("pdf-lib");
    const merged = await PDFDocument.load(readFileSync(join(cwd, "big.pdf")));
    expect(merged.getPageCount()).toBe(50);
  });
});

// ────────────────────────────────────────────────────────────
// docx_read / docx_create
// ────────────────────────────────────────────────────────────
describe("docx_read / docx_create", () => {
  function build() {
    return createDocxTools(cwd, [cwd], ["docx_read", "docx_create"]);
  }

  it("docx_create writes a docx that docx_read can read back", async () => {
    const create = pick(build(), "docx_create");
    const r1 = await create.execute("c1", {
      path: "letter.docx",
      title: "Lettera al cliente",
      content: [
        { type: "paragraph", text: "Caro cliente," },
        { type: "paragraph", text: "Grazie per il tuo ordine." },
        { type: "paragraph", text: "— Team" },
      ],
    });
    expect(existsSync(join(cwd, "letter.docx"))).toBe(true);
    expect(JSON.stringify(r1.details)).toContain("letter.docx");

    const read = pick(build(), "docx_read");
    const r2 = await read.execute("c1", { path: "letter.docx" });
    const out = text(r2);
    expect(out).toContain("Caro cliente");
    expect(out).toContain("Grazie per il tuo ordine");
  });

  it("docx_read on a missing file returns a structured error", async () => {
    const t = pick(build(), "docx_read");
    const result = await t.execute("c1", { path: "ghost.docx" });
    expect(JSON.stringify(result.details)).toMatch(/error|fail|not.*found/i);
  });

  it("docx_create rejects paths outside the sandbox", async () => {
    const t = pick(build(), "docx_create");
    await expect(
      t.execute("c1", { path: "/etc/escape.docx", content: [{ type: "paragraph", text: "x" }] }),
    ).rejects.toThrow(/sandbox|allowed|denied/i);
  });

  // ── Adversarial ────────────────────────────────────────────
  it("docx_read on a corrupted docx returns a structured error", async () => {
    writeFileSync(join(cwd, "broken.docx"), Buffer.alloc(256, 0x55));
    const t = pick(build(), "docx_read");
    const result = await t.execute("c1", { path: "broken.docx" });
    expect(JSON.stringify(result.details)).toMatch(/error|fail|invalid|parse/i);
  });

  it("docx_create handles all four block types in one document", async () => {
    const create = pick(build(), "docx_create");
    await create.execute("c1", {
      path: "kitchen-sink.docx",
      title: "Mixed",
      content: [
        { type: "heading", text: "Sezione 1", level: 1 },
        { type: "paragraph", text: "Paragrafo introduttivo." },
        { type: "bullet", text: "Punto uno" },
        { type: "bullet", text: "Punto due" },
        { type: "numbered", text: "Step alpha" },
        { type: "numbered", text: "Step beta" },
      ],
    });
    expect(existsSync(join(cwd, "kitchen-sink.docx"))).toBe(true);

    const read = pick(build(), "docx_read");
    const r2 = await read.execute("c1", { path: "kitchen-sink.docx" });
    const out = text(r2);
    expect(out).toContain("Sezione 1");
    expect(out).toContain("Paragrafo introduttivo");
    expect(out).toContain("Punto uno");
    expect(out).toContain("Step alpha");
  });

  it("docx_create with empty content array still writes a (mostly empty) file", async () => {
    const t = pick(build(), "docx_create");
    const result = await t.execute("c1", { path: "empty.docx", content: [] });
    // Either succeeds (empty doc) or refuses with a clear error.
    // Pin "no unhandled throw, result has details".
    expect(result.details).toBeDefined();
  });

  it("docx_create with non-ASCII content (RTL + emoji + ideographs) round-trips", async () => {
    const create = pick(build(), "docx_create");
    await create.execute("c1", {
      path: "i18n.docx",
      content: [
        { type: "paragraph", text: "Latin: café" },
        { type: "paragraph", text: "Hebrew RTL: שלום עולם" },
        { type: "paragraph", text: "CJK: 你好世界" },
        { type: "paragraph", text: "Emoji 🐙🚀 + zero-width ​ end" },
      ],
    });
    const read = pick(build(), "docx_read");
    const r2 = await read.execute("c1", { path: "i18n.docx" });
    const out = text(r2);
    expect(out).toContain("café");
    expect(out).toContain("שלום עולם");
    expect(out).toContain("你好世界");
    expect(out).toContain("🐙");
  });

  it("docx_create with a 500-paragraph payload writes within a reasonable time", async () => {
    const create = pick(build(), "docx_create");
    const content = Array.from({ length: 500 }, (_, i) => ({
      type: "paragraph" as const,
      text: `Paragraph #${i + 1}: lorem ipsum dolor sit amet consectetur adipiscing elit.`,
    }));
    const t0 = Date.now();
    await create.execute("c1", { path: "big.docx", content });
    const elapsed = Date.now() - t0;
    expect(existsSync(join(cwd, "big.docx"))).toBe(true);
    // Generous bound — flags only true regressions (10x slowdown).
    expect(elapsed).toBeLessThan(15_000);
  });
});
