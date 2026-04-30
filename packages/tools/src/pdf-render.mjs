#!/usr/bin/env node
/**
 * HTML → PDF driver, called by `pdf_create` via Shell.
 *
 * Stays inside the sandbox where Chromium lives. Reuses the single
 * Chromium binary owned by agent-browser (no separate Playwright
 * install) by passing `executablePath` to `chromium.launch()`.
 *
 * Invocation:
 *   node pdf-render.mjs <params-json> <output-path>
 *
 * Params shape (matches the LLM-facing pdf_create schema):
 *   {
 *     html?: string,                // inline HTML
 *     htmlPath?: string,            // OR a file path (one of the two)
 *     format?: "A4" | "Letter" | ... (default A4)
 *     landscape?: boolean,
 *     printBackground?: boolean,
 *     scale?: number,
 *     margin?: { top?, right?, bottom?, left? },
 *     headerTemplate?: string,
 *     footerTemplate?: string,
 *     waitForNetwork?: boolean,     // default true
 *   }
 *
 * Result: prints `{"success":true,"path":"...","bytes":N}` to stdout
 * on success, `{"success":false,"error":"..."}` on failure. Exits 0
 * on success, 1 on failure.
 */
import { chromium } from "playwright-core";
import { readFileSync, readdirSync, statSync } from "node:fs";

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_MARGIN = { top: "20mm", right: "15mm", bottom: "25mm", left: "15mm" };

function findAgentBrowserChromium() {
  // agent-browser install drops Chromium into ~/.agent-browser/browsers/chrome-<version>/chrome
  const home = process.env.HOME ?? "/root";
  const dir = `${home}/.agent-browser/browsers`;
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (err) {
    throw new Error(`agent-browser Chromium directory not found at ${dir}. Run \`agent-browser install\`.`);
  }
  const chromeDirs = entries.filter((d) => d.startsWith("chrome-"));
  if (chromeDirs.length === 0) {
    throw new Error(`No chrome-* subdir under ${dir}. Run \`agent-browser install\`.`);
  }
  // Prefer the highest version when multiple are present.
  chromeDirs.sort().reverse();
  const candidate = `${dir}/${chromeDirs[0]}/chrome`;
  // Sanity: it should be an executable file.
  try {
    const st = statSync(candidate);
    if (!st.isFile()) throw new Error("not a regular file");
  } catch (err) {
    throw new Error(`Chromium binary missing at ${candidate}: ${err.message}`);
  }
  return candidate;
}

async function main() {
  const [, , paramsJson, outputPath] = process.argv;
  if (!paramsJson || !outputPath) {
    throw new Error("Usage: node pdf-render.mjs <params-json> <output-path>");
  }

  const params = JSON.parse(paramsJson);

  const html = params.html ?? (params.htmlPath ? readFileSync(params.htmlPath, "utf8") : null);
  if (!html) throw new Error("Either 'html' or 'htmlPath' must be provided");

  const executablePath = process.env.AGENT_BROWSER_CHROME_PATH || findAgentBrowserChromium();

  const browser = await chromium.launch({
    headless: true,
    executablePath,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage();
    const waitUntil = params.waitForNetwork === false ? "domcontentloaded" : "networkidle";
    await page.setContent(html, { waitUntil, timeout: DEFAULT_TIMEOUT });

    const margin = params.margin ? { ...DEFAULT_MARGIN, ...params.margin } : DEFAULT_MARGIN;
    const hasHeaderFooter = !!(params.headerTemplate || params.footerTemplate);

    await page.pdf({
      path: outputPath,
      format: params.format ?? "A4",
      landscape: params.landscape ?? false,
      printBackground: params.printBackground ?? true,
      scale: Math.max(0.1, Math.min(2, params.scale ?? 1)),
      margin,
      displayHeaderFooter: hasHeaderFooter,
      ...(hasHeaderFooter ? {
        headerTemplate: params.headerTemplate ?? "<div></div>",
        footerTemplate: params.footerTemplate ?? "<div></div>",
      } : {}),
    });

    const bytes = statSync(outputPath).size;
    process.stdout.write(JSON.stringify({ success: true, path: outputPath, bytes }) + "\n");
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((err) => {
  process.stderr.write(JSON.stringify({ success: false, error: err.message ?? String(err) }) + "\n");
  process.exit(1);
});
