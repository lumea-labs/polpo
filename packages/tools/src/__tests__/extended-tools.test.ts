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
});

// ────────────────────────────────────────────────────────────
// vault_get / vault_list
// ────────────────────────────────────────────────────────────
describe("vault_get / vault_list", () => {
  function makeVault(entries: Record<string, { type: string; values: Record<string, string> }>): ResolvedVault {
    return {
      get: (service) => entries[service]?.values,
      getSmtp: () => entries["smtp"]?.values,
      getImap: () => entries["imap"]?.values,
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
});
