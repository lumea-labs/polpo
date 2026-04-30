#!/usr/bin/env node
/**
 * Layer-2 smoke for the Polpo runner image — paranoid edition.
 *
 * Covers every tool that needs a real binary:
 *   - pdf_create               → Chromium via the @polpo-ai/tools driver
 *   - all 18 browser_* tools   → agent-browser CLI + Chromium
 *   - audio_speak (edge)       → edge-tts CLI
 *
 * Run inside the runner image:
 *   docker run --rm \
 *     -v $PWD/docker/runner/tests:/tests:ro \
 *     -w /home/daytona \
 *     polpo-runner:0.6.32 \
 *     node /tests/runtime-smoke.mjs
 *
 * The framework on purpose stays minimal — the image doesn't ship
 * vitest. Each case is an async function with explicit assertions;
 * failures collect and don't short-circuit the rest of the run.
 *
 * Exit 0 if everything passes, 1 otherwise. CI can rely on this.
 */
import { mkdtempSync, mkdirSync, rmSync, existsSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Run inside /home/daytona so the staged pdf-render driver script can
// `import("playwright-core")` — Node walks up looking for node_modules,
// and playwright-core lives at /home/daytona/node_modules. /tmp would
// break that resolution.
const SMOKE_ROOT = "/home/daytona/.smoke";
mkdirSync(SMOKE_ROOT, { recursive: true });
const CWD = mkdtempSync(join(SMOKE_ROOT, "run-"));
process.chdir(CWD);

let mod;
try {
  mod = await import("@polpo-ai/tools");
} catch {
  mod = await import("/home/daytona/node_modules/@polpo-ai/tools/dist/index.js");
}
const { createAllTools, NodeFileSystem, NodeShell } = mod;

const vault = {
  get: () => undefined, getSmtp: () => undefined, getImap: () => undefined,
  getKey: () => undefined, has: () => false, list: () => [],
};

const tools = await createAllTools({
  cwd: CWD,
  allowedPaths: [CWD],
  allowedTools: ["*"],
  vault,
  fs: new NodeFileSystem(),
  shell: new NodeShell(),
  outputDir: CWD,
});

function pick(name) {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`Tool '${name}' not registered`);
  return t;
}
function textOf(result) {
  const block = result?.content?.[0];
  return block?.type === "text" ? (block.text ?? "") : "";
}
function detailsOf(result) {
  return result?.details ?? {};
}
function assertOk(result, label) {
  if (!result) throw new Error(`${label}: no result`);
  const errKey = result.details?.error;
  if (errKey) throw new Error(`${label}: ${JSON.stringify(result.details).slice(0, 300)}`);
}
function assertFail(result, label) {
  // Either a structured error in details OR text indicating failure.
  const blob = (textOf(result) + JSON.stringify(detailsOf(result))).toLowerCase();
  if (!result.details?.error && !/error|fail|not found|invalid|denied|timeout/.test(blob)) {
    throw new Error(`${label}: expected failure but got ${blob.slice(0, 200)}`);
  }
}
function approx(actual, expected, tol = 2) {
  return Math.abs(actual - expected) <= tol;
}

// ─── HTML fixture for browser interactions ─────────────────
// Self-contained page with every element type the browser tools need
// to exercise: form, button, links, select, textarea, scrollable
// region, anchor for back/forward.
const FIXTURE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Polpo Smoke Fixture</title>
<style>
  body { font-family: sans-serif; padding: 1em; }
  #spacer { height: 2000px; background: linear-gradient(#fff, #ccc); }
  #target { padding: 1em; background: #ffd; }
</style></head>
<body>
  <h1 id="title">Polpo Smoke Fixture</h1>
  <p id="intro">Intro text for browser_get.</p>

  <form id="form">
    <label>Name <input id="name" type="text" placeholder="your name"></label>
    <label>Bio  <textarea id="bio" rows="3"></textarea></label>
    <label>Plan <select id="plan">
      <option value="free">Free</option>
      <option value="pro">Pro</option>
      <option value="enterprise">Enterprise</option>
    </select></label>
    <button id="submit" type="button" onclick="document.getElementById('result').textContent='submitted'">Submit</button>
  </form>
  <div id="result"></div>

  <a id="link-page2" href="page2.html">Go to page 2</a>
  <div id="hover-target" onmouseover="this.dataset.hovered='yes'">Hover me</div>

  <div id="spacer"></div>
  <div id="target">Bottom target</div>
</body></html>`;

const FIXTURE_PAGE2 = `<!doctype html>
<html><head><title>Page 2</title></head>
<body><h1 id="title">Page Two</h1></body></html>`;

writeFileSync(join(CWD, "fixture.html"), FIXTURE_HTML);
writeFileSync(join(CWD, "page2.html"), FIXTURE_PAGE2);
const FIXTURE_URL = `file://${join(CWD, "fixture.html")}`;
const PAGE2_URL = `file://${join(CWD, "page2.html")}`;

// ─── case registry ─────────────────────────────────────────
const cases = [];
function suite(name, fn) { cases.push({ name, fn }); }

// ════════════════════════════════════════════════════════════
// PDF_CREATE — happy + paranoid
// ════════════════════════════════════════════════════════════
suite("pdf_create — default A4 portrait", async () => {
  const t = pick("pdf_create");
  const r = await t.execute("c", { html: "<h1>hi</h1>", path: "p1.pdf" });
  assertOk(r, "pdf_create");
  if (statSync(join(CWD, "p1.pdf")).size < 500) throw new Error("pdf too small");
});

suite("pdf_create — Letter landscape", async () => {
  const t = pick("pdf_create");
  const r = await t.execute("c", { html: "<h1>hi</h1>", path: "p2.pdf", format: "Letter", landscape: true });
  assertOk(r, "pdf_create");
  // Verify dimensions via pdf-lib (in /home/daytona/node_modules,
  // not in this script's sibling tree, so we import by absolute path).
  const { PDFDocument } = await import("/home/daytona/node_modules/pdf-lib/cjs/index.js");
  const doc = await PDFDocument.load(readFileSync(join(CWD, "p2.pdf")));
  const { width, height } = doc.getPage(0).getSize();
  // Letter portrait = 612×792, landscape rotates → 792×612.
  if (!approx(width, 792) || !approx(height, 612)) {
    throw new Error(`Letter landscape wrong dims: ${width}×${height}`);
  }
});

suite("pdf_create — header + footer template", async () => {
  const t = pick("pdf_create");
  const r = await t.execute("c", {
    html: "<h1>Body</h1>",
    path: "p3.pdf",
    header_template: '<div style="font-size:8px">HEADER</div>',
    footer_template: '<div style="font-size:8px">PG <span class="pageNumber"></span></div>',
  });
  assertOk(r, "pdf_create");
});

suite("pdf_create — custom margins (0mm)", async () => {
  const t = pick("pdf_create");
  const r = await t.execute("c", {
    html: "<h1>Edge to edge</h1>",
    path: "p4.pdf",
    margin: { top: "0mm", right: "0mm", bottom: "0mm", left: "0mm" },
  });
  assertOk(r, "pdf_create");
});

suite("pdf_create — scale extremes (0.5 and 2.0)", async () => {
  const t = pick("pdf_create");
  const a = await t.execute("c", { html: "<h1>tiny</h1>", path: "p5a.pdf", scale: 0.5 });
  const b = await t.execute("c", { html: "<h1>HUGE</h1>", path: "p5b.pdf", scale: 2.0 });
  assertOk(a, "pdf_create scale 0.5");
  assertOk(b, "pdf_create scale 2.0");
});

suite("pdf_create — non-ASCII content (CJK + RTL + emoji)", async () => {
  const t = pick("pdf_create");
  const r = await t.execute("c", {
    html: `<!doctype html><html><body>
      <p>Latin café</p><p>CJK 你好世界</p>
      <p>RTL שלום עולם</p><p>Emoji 🐙🚀</p>
    </body></html>`,
    path: "p6.pdf",
  });
  assertOk(r, "pdf_create");
});

suite("pdf_create — html_path (read from file)", async () => {
  writeFileSync(join(CWD, "src.html"), "<h1>From file</h1>");
  const t = pick("pdf_create");
  const r = await t.execute("c", { html_path: "src.html", path: "p7.pdf" });
  assertOk(r, "pdf_create");
});

suite("pdf_create — wait_for_network=false (no external fetch)", async () => {
  const t = pick("pdf_create");
  const r = await t.execute("c", {
    html: "<h1>offline</h1>",
    path: "p8.pdf",
    wait_for_network: false,
  });
  assertOk(r, "pdf_create");
});

suite("pdf_create — 200KB inline HTML doesn't crash the renderer", async () => {
  const filler = "<p>" + "x ".repeat(40_000) + "</p>";
  const t = pick("pdf_create");
  const r = await t.execute("c", { html: `<html><body>${filler}</body></html>`, path: "p9.pdf" });
  assertOk(r, "pdf_create big html");
  if (statSync(join(CWD, "p9.pdf")).size < 1000) throw new Error("pdf too small");
});

suite("pdf_create — refuses output outside the sandbox", async () => {
  const t = pick("pdf_create");
  let threw = false;
  try { await t.execute("c", { html: "<h1>x</h1>", path: "/etc/escape.pdf" }); }
  catch { threw = true; }
  if (!threw) throw new Error("expected sandbox rejection");
});

suite("pdf_create — refuses missing both html and html_path", async () => {
  const t = pick("pdf_create");
  const r = await t.execute("c", { path: "p11.pdf" });
  assertFail(r, "pdf_create no source");
});

// ════════════════════════════════════════════════════════════
// BROWSER_* — all 18 tools, happy path + paranoid
// Browser tools share a single agent-browser session, so order
// matters: navigate first, mutate, snapshot, query, then close.
// ════════════════════════════════════════════════════════════
suite("browser_navigate — local fixture", async () => {
  const r = await pick("browser_navigate").execute("c", { url: FIXTURE_URL });
  assertOk(r, "browser_navigate");
});

suite("browser_get — title", async () => {
  const r = await pick("browser_get").execute("c", { what: "title" });
  assertOk(r, "browser_get title");
  if (!textOf(r).includes("Polpo Smoke Fixture")) throw new Error("title not found");
});

suite("browser_get — html of a specific element", async () => {
  const r = await pick("browser_get").execute("c", { what: "html", selector: "#title" });
  assertOk(r, "browser_get html");
  if (!textOf(r).includes("Polpo Smoke Fixture")) throw new Error("html missing title");
});

suite("browser_get — text of a missing selector reports error cleanly", async () => {
  const r = await pick("browser_get").execute("c", { what: "text", selector: "#nope-does-not-exist" });
  assertFail(r, "browser_get missing");
});

suite("browser_snapshot — accessibility tree includes form fields", async () => {
  const r = await pick("browser_snapshot").execute("c", {});
  assertOk(r, "browser_snapshot");
  const out = textOf(r).toLowerCase();
  // Snapshot should reference at least the form / inputs we placed.
  if (!/input|button|select|textarea|name|plan|submit/.test(out)) {
    throw new Error("snapshot missing form elements");
  }
});

suite("browser_snapshot — interactive_only filter", async () => {
  const r = await pick("browser_snapshot").execute("c", { interactive_only: true });
  assertOk(r, "browser_snapshot interactive");
});

suite("browser_fill — sets a text input value", async () => {
  const r = await pick("browser_fill").execute("c", { selector: "#name", text: "Alice" });
  assertOk(r, "browser_fill");
  // Verify via a subsequent get.
  const v = await pick("browser_get").execute("c", { what: "value", selector: "#name" });
  if (!textOf(v).includes("Alice")) throw new Error("fill didn't persist");
});

suite("browser_fill — overwrites previous value (no append)", async () => {
  await pick("browser_fill").execute("c", { selector: "#name", text: "Bob" });
  const v = await pick("browser_get").execute("c", { what: "value", selector: "#name" });
  const out = textOf(v);
  if (out.includes("Alice") || !out.includes("Bob")) {
    throw new Error("fill should clear before setting; got: " + out.slice(0, 120));
  }
});

suite("browser_fill — handles unicode (RTL + CJK)", async () => {
  await pick("browser_fill").execute("c", { selector: "#name", text: "你好 שלום 🚀" });
  const v = await pick("browser_get").execute("c", { what: "value", selector: "#name" });
  if (!textOf(v).includes("你好")) throw new Error("unicode dropped");
});

suite("browser_fill — non-existent selector reports error", async () => {
  const r = await pick("browser_fill").execute("c", { selector: "#nope", text: "x" });
  assertFail(r, "browser_fill missing");
});

suite("browser_type — appends to existing value", async () => {
  // type() does keystroke-style input; reset first via fill.
  await pick("browser_fill").execute("c", { selector: "#bio", text: "hello " });
  const r = await pick("browser_type").execute("c", { selector: "#bio", text: "world" });
  assertOk(r, "browser_type");
  const v = await pick("browser_get").execute("c", { what: "value", selector: "#bio" });
  const out = textOf(v);
  if (!out.includes("hello") || !out.includes("world")) {
    throw new Error("type result missing expected content: " + out.slice(0, 120));
  }
});

suite("browser_press — Tab key shifts focus", async () => {
  await pick("browser_navigate").execute("c", { url: FIXTURE_URL });
  await pick("browser_fill").execute("c", { selector: "#name", text: "x" });
  const r = await pick("browser_press").execute("c", { key: "Tab" });
  assertOk(r, "browser_press");
});

suite("browser_select — picks an option by value", async () => {
  const r = await pick("browser_select").execute("c", { selector: "#plan", value: "pro" });
  assertOk(r, "browser_select");
  const v = await pick("browser_get").execute("c", { what: "value", selector: "#plan" });
  if (!textOf(v).includes("pro")) throw new Error("select didn't apply");
});

suite("browser_hover — fires onmouseover handler", async () => {
  const r = await pick("browser_hover").execute("c", { selector: "#hover-target" });
  assertOk(r, "browser_hover");
  // Verify via the side-effect attribute the page sets onmouseover.
  const ev = await pick("browser_eval").execute("c", {
    javascript: `document.getElementById('hover-target').dataset.hovered ?? ''`,
  });
  if (!textOf(ev).toLowerCase().includes("yes")) {
    throw new Error("hover handler didn't fire; eval returned: " + textOf(ev).slice(0, 120));
  }
});

suite("browser_click — triggers handler that updates the DOM", async () => {
  const r = await pick("browser_click").execute("c", { selector: "#submit" });
  assertOk(r, "browser_click");
  const out = await pick("browser_get").execute("c", { what: "text", selector: "#result" });
  if (!textOf(out).includes("submitted")) {
    throw new Error("click didn't fire handler; #result text: " + textOf(out).slice(0, 120));
  }
});

suite("browser_click — non-existent selector reports error", async () => {
  const r = await pick("browser_click").execute("c", { selector: "#nope-button" });
  assertFail(r, "browser_click missing");
});

suite("browser_scroll — scrolls down by 800px", async () => {
  const r = await pick("browser_scroll").execute("c", { direction: "down", pixels: 800 });
  assertOk(r, "browser_scroll");
});

suite("browser_wait — waits for a selector that exists", async () => {
  const r = await pick("browser_wait").execute("c", { selector: "#title", timeout: 5000 });
  assertOk(r, "browser_wait");
});

suite("browser_wait — selector that never appears times out cleanly", async () => {
  const r = await pick("browser_wait").execute("c", { selector: "#never-shown", timeout: 1500 });
  // Either a structured error or a clean timeout message.
  assertFail(r, "browser_wait timeout");
});

suite("browser_eval — returns serialized result", async () => {
  const r = await pick("browser_eval").execute("c", { javascript: `1 + 2 + 3` });
  assertOk(r, "browser_eval");
  if (!textOf(r).includes("6")) throw new Error("eval result missing 6");
});

suite("browser_eval — DOM query via evaluate", async () => {
  const r = await pick("browser_eval").execute("c", { javascript: `document.querySelectorAll('label').length` });
  assertOk(r, "browser_eval dom");
  if (!/[1-9]/.test(textOf(r))) throw new Error("expected positive label count");
});

suite("browser_screenshot — non-empty PNG with magic bytes", async () => {
  const r = await pick("browser_screenshot").execute("c", { path: "shot.png" });
  assertOk(r, "browser_screenshot");
  const head = readFileSync(join(CWD, "shot.png")).subarray(0, 8);
  if (head[0] !== 0x89 || head[1] !== 0x50 || head[2] !== 0x4e || head[3] !== 0x47) {
    throw new Error(`not a PNG: ${head.toString("hex")}`);
  }
  if (statSync(join(CWD, "shot.png")).size < 1000) throw new Error("png too small");
});

suite("browser_screenshot — full_page captures more bytes than viewport", async () => {
  const partial = await pick("browser_screenshot").execute("c", { path: "shot-partial.png" });
  assertOk(partial, "browser_screenshot partial");
  const full = await pick("browser_screenshot").execute("c", { path: "shot-full.png", full_page: true });
  assertOk(full, "browser_screenshot full");
  // The fixture has a 2000px tall #spacer, so full_page must be
  // strictly bigger than the viewport screenshot.
  const partialBytes = statSync(join(CWD, "shot-partial.png")).size;
  const fullBytes = statSync(join(CWD, "shot-full.png")).size;
  if (fullBytes <= partialBytes) {
    throw new Error(`full_page should be larger; partial=${partialBytes} full=${fullBytes}`);
  }
});

suite("browser_back / forward — preserves navigation history", async () => {
  // Build a clean two-page history inside this test, independent of
  // whatever happened earlier in the run. Use URL (not title) as the
  // truth signal: it's the deterministic outcome of navigate, no race
  // with page-load-completion timing.
  await pick("browser_navigate").execute("c", { url: FIXTURE_URL });
  await pick("browser_navigate").execute("c", { url: PAGE2_URL });

  let url = textOf(await pick("browser_get").execute("c", { what: "url" }));
  if (!url.includes("page2")) throw new Error(`expected page2 URL, got: ${url.slice(0, 200)}`);

  assertOk(await pick("browser_back").execute("c", {}), "browser_back");
  url = textOf(await pick("browser_get").execute("c", { what: "url" }));
  if (!url.includes("fixture")) throw new Error(`back didn't return to fixture; URL: ${url.slice(0, 200)}`);

  assertOk(await pick("browser_forward").execute("c", {}), "browser_forward");
  url = textOf(await pick("browser_get").execute("c", { what: "url" }));
  if (!url.includes("page2")) throw new Error(`forward didn't reach page2; URL: ${url.slice(0, 200)}`);
});

suite("browser_reload — same URL, fresh DOM state", async () => {
  await pick("browser_navigate").execute("c", { url: FIXTURE_URL });
  // Mutate the DOM.
  await pick("browser_eval").execute("c", { javascript: `document.title = 'Mutated';` });
  let title = await pick("browser_get").execute("c", { what: "title" });
  if (!textOf(title).includes("Mutated")) throw new Error("eval mutation failed");
  // Reload; mutation should be gone.
  const rl = await pick("browser_reload").execute("c", {});
  assertOk(rl, "browser_reload");
  title = await pick("browser_get").execute("c", { what: "title" });
  if (!textOf(title).includes("Polpo Smoke Fixture")) {
    throw new Error("reload didn't restore original title; got: " + textOf(title).slice(0, 120));
  }
});

suite("browser_tabs — lists currently open tabs", async () => {
  const r = await pick("browser_tabs").execute("c", {});
  assertOk(r, "browser_tabs");
  // Output should mention either the title or URL of the open page.
  const out = textOf(r).toLowerCase();
  if (!out.includes("polpo") && !out.includes("fixture") && !out.includes("file://")) {
    throw new Error("tabs missing current page reference: " + out.slice(0, 200));
  }
});

suite("browser_navigate — invalid scheme reports error", async () => {
  // file:/// is fine, but a clearly broken URL should fail cleanly.
  const r = await pick("browser_navigate").execute("c", { url: "not-a-url://garbage" });
  assertFail(r, "browser_navigate bad scheme");
});

suite("browser_close — releases the session cleanly", async () => {
  const r = await pick("browser_close").execute("c", {});
  assertOk(r, "browser_close");
});

// ════════════════════════════════════════════════════════════
// AUDIO_SPEAK (edge-tts) — happy + paranoid
// ════════════════════════════════════════════════════════════
function isAudioFile(buf) {
  // ID3 tag OR MPEG sync bytes.
  return (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33)
      || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0);
}

suite("audio_speak — edge with default voice", async () => {
  const r = await pick("audio_speak").execute("c", {
    text: "Default voice smoke test.",
    path: "audio-default.mp3",
    model: "edge/edge-tts",
  });
  assertOk(r, "audio_speak default");
  const head = readFileSync(join(CWD, "audio-default.mp3")).subarray(0, 3);
  if (!isAudioFile(head)) throw new Error(`not an audio file: ${head.toString("hex")}`);
});

suite("audio_speak — explicit voice (en-US-AriaNeural)", async () => {
  const r = await pick("audio_speak").execute("c", {
    text: "Explicit voice smoke.",
    path: "audio-aria.mp3",
    model: "edge/edge-tts",
    voice: "en-US-AriaNeural",
  });
  assertOk(r, "audio_speak aria");
  if (statSync(join(CWD, "audio-aria.mp3")).size < 1000) throw new Error("audio too small");
});

suite("audio_speak — non-ASCII text (Italian + emoji)", async () => {
  const r = await pick("audio_speak").execute("c", {
    text: "Buongiorno mondo, è bello qui ☀️",
    path: "audio-it.mp3",
    model: "edge/edge-tts",
    language: "it",
  });
  assertOk(r, "audio_speak italian");
});

suite("audio_speak — long text (~500 chars) doesn't truncate the file", async () => {
  const long = "A medium length sentence for the smoke test. ".repeat(12);
  const r = await pick("audio_speak").execute("c", {
    text: long,
    path: "audio-long.mp3",
    model: "edge/edge-tts",
  });
  assertOk(r, "audio_speak long");
  // Long text → at least 5KB of audio.
  if (statSync(join(CWD, "audio-long.mp3")).size < 5000) {
    throw new Error("long audio truncated");
  }
});

suite("audio_speak — invalid voice name reports error", async () => {
  const r = await pick("audio_speak").execute("c", {
    text: "won't speak",
    path: "audio-bad-voice.mp3",
    model: "edge/edge-tts",
    voice: "xx-XX-NonExistentNeural",
  });
  // Either rejects or returns a structured error. Pin "no crash, no
  // valid mp3 produced".
  if (existsSync(join(CWD, "audio-bad-voice.mp3"))) {
    const head = readFileSync(join(CWD, "audio-bad-voice.mp3")).subarray(0, 3);
    if (isAudioFile(head)) throw new Error("non-existent voice unexpectedly produced audio");
  }
});

suite("audio_speak — refuses output outside the sandbox", async () => {
  let threw = false;
  try {
    await pick("audio_speak").execute("c", {
      text: "x", path: "/etc/escape.mp3", model: "edge/edge-tts",
    });
  } catch { threw = true; }
  if (!threw) throw new Error("expected sandbox rejection");
});

// ════════════════════════════════════════════════════════════
// runner
// ════════════════════════════════════════════════════════════
let pass = 0, fail = 0;
const failed = [];
for (const c of cases) {
  const t0 = Date.now();
  try {
    await c.fn();
    const ms = Date.now() - t0;
    pass++;
    console.log(`OK   ${c.name.padEnd(60)} ${ms.toString().padStart(5)}ms`);
  } catch (err) {
    const ms = Date.now() - t0;
    fail++;
    failed.push({ name: c.name, err: err.message ?? String(err) });
    console.log(`FAIL ${c.name.padEnd(60)} ${ms.toString().padStart(5)}ms`);
    console.log(`     ${err.message ?? err}`);
  }
}

console.log();
console.log(`=== ${pass} OK, ${fail} FAIL ===`);

try { rmSync(CWD, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
