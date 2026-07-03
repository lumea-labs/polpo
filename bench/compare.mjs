#!/usr/bin/env node
/**
 * bench/compare.mjs — diff two benchmark result files + project sandbox costs.
 *
 * Usage:
 *   node bench/compare.mjs bench/results/<a>.json bench/results/<b>.json
 *
 * Prints:
 *   1. Per-scenario deltas (wall, overhead, loop) — A → B, absolute and %.
 *   2. Cost projections from bench/pricing.json under two execution models:
 *        A) sandbox-alive-per-task — the sandbox is billed for the FULL task
 *           wall time (today's runner-in-sandbox model).
 *        B) ProxyTool — the LLM loop lives in the server; the sandbox is only
 *           billed for the tool/harness part (overhead_ms, i.e. wall − llm).
 *      Projected at 1k / 10k / 100k tasks per month, per provider.
 *
 * Pricing is a declarative layer (bench/pricing.json) — edit rates there.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const BENCH_DIR = dirname(fileURLToPath(import.meta.url));

// ─── Load inputs ──────────────────────────────────────────────────────────────

const [fileA, fileB] = process.argv.slice(2);
if (!fileA || !fileB) {
  console.error("Usage: node bench/compare.mjs <a.json> <b.json>");
  process.exit(1);
}

const load = (p) => JSON.parse(readFileSync(p, "utf-8"));
const a = load(fileA);
const b = load(fileB);
const pricing = load(join(BENCH_DIR, "pricing.json"));

const label = (r) => `${r.meta.label} (${r.meta.sha}, ${r.meta.ts})`;
console.log(`\nA: ${label(a)}`);
console.log(`B: ${label(b)}\n`);

// ─── Per-scenario deltas ──────────────────────────────────────────────────────

const byName = (run) => new Map(run.scenarios.map((s) => [s.name, s]));
const mapA = byName(a);
const mapB = byName(b);
const common = [...mapA.keys()].filter((n) => mapB.has(n));

function metric(s, key) {
  const v = s?.metrics?.[key];
  return typeof v === "number" ? v : null;
}

function delta(va, vb) {
  if (va === null || vb === null) return "-";
  const d = vb - va;
  const pct = va !== 0 ? ` (${d >= 0 ? "+" : ""}${((d / va) * 100).toFixed(1)}%)` : "";
  return `${d >= 0 ? "+" : ""}${Math.round(d)}ms${pct}`;
}

const fmtMs = (v) => (v === null ? "-" : `${Math.round(v)}`);

const cols = ["scenario", "wall A", "wall B", "Δ wall", "ovh A", "ovh B", "Δ ovh", "loop A", "loop B", "Δ loop", "pass"];
const rows = [];
for (const name of common) {
  const sa = mapA.get(name);
  const sb = mapB.get(name);
  const wallA = metric(sa, "wall_ms") ?? metric(sa, "makespan_ms");
  const wallB = metric(sb, "wall_ms") ?? metric(sb, "makespan_ms");
  const ovhA = metric(sa, "overhead_ms");
  const ovhB = metric(sb, "overhead_ms");
  const loopA = metric(sa, "loop_ms");
  const loopB = metric(sb, "loop_ms");
  rows.push([
    name,
    fmtMs(wallA),
    fmtMs(wallB),
    delta(wallA, wallB),
    fmtMs(ovhA),
    fmtMs(ovhB),
    delta(ovhA, ovhB),
    fmtMs(loopA),
    fmtMs(loopB),
    delta(loopA, loopB),
    `${sa.pass ? "A✓" : "A✗"}${sb.pass ? "B✓" : "B✗"}`,
  ]);
}
const widths = cols.map((c, i) => Math.max(c.length, ...rows.map((r) => String(r[i]).length)));
const line = (cells) => "  " + cells.map((c, i) => String(c).padEnd(widths[i])).join("  ");
console.log(line(cols));
console.log("  " + widths.map((w) => "-".repeat(w)).join("  "));
for (const r of rows) console.log(line(r));

const missing = [...mapB.keys()].filter((n) => !mapA.has(n));
if (missing.length) console.log(`\n  (only in B: ${missing.join(", ")})`);

// ─── Cost projections ─────────────────────────────────────────────────────────
//
// Uses run B's numbers (the "candidate" runtime). Mean across the comparable
// single-task scenarios that passed in B (concurrency/makespan excluded —
// it measures fan-out, not per-task cost).

const costScenarios = b.scenarios.filter(
  (s) => !s.concurrency && typeof s.metrics?.wall_ms === "number" && typeof s.metrics?.overhead_ms === "number",
);
if (costScenarios.length === 0) {
  console.log("\nNo cost-comparable scenarios in B — skipping cost projection.");
  process.exit(0);
}

const mean = (arr) => arr.reduce((x, y) => x + y, 0) / arr.length;
const meanWallMs = mean(costScenarios.map((s) => s.metrics.wall_ms));
const meanOverheadMs = mean(costScenarios.map((s) => s.metrics.overhead_ms));

const { vcpu, ramGib } = pricing.referenceSandbox;

/** $ for one task billed `billedMs` on a full sandbox (cpu+ram always on). */
function fullSandboxCost(p, billedMs) {
  const seconds = p.granularity === "second" ? Math.ceil(billedMs / 1000) : billedMs / 1000;
  const hourly = vcpu * p.vcpuHour + ramGib * p.ramGibHour;
  return (seconds / 3600) * hourly;
}

/** $ for one task on Vercel-style billing: active CPU + provisioned memory. */
function vercelCost(p, activeMs, aliveMs) {
  const billedAliveMs = Math.max(aliveMs, p.minBillMs ?? 0);
  const cpuCost = (activeMs / 3600_000) * p.activeCpuHour; // 1 vCPU active during harness work
  const memCost = (billedAliveMs / 3600_000) * ramGib * p.memGbHour;
  return cpuCost + memCost;
}

function perTaskCost(providerName, p, model) {
  // Model A: sandbox alive for the whole task (billed on wall).
  // Model B: ProxyTool — sandbox only does tool/harness work (billed on overhead).
  const billedMs = model === "A" ? meanWallMs : meanOverheadMs;
  if (providerName === "vercel") {
    const activeMs = meanOverheadMs; // LLM wait is I/O — never CPU-active
    return vercelCost(p, activeMs, billedMs);
  }
  return fullSandboxCost(p, billedMs);
}

const volumes = [1_000, 10_000, 100_000];
console.log(
  `\nCost projection (run B, mean over ${costScenarios.length} scenarios: wall=${Math.round(meanWallMs)}ms, overhead=${Math.round(meanOverheadMs)}ms, sandbox ${vcpu}vCPU/${ramGib}GiB):`,
);
console.log("  Model A = sandbox-alive-per-task (billed on wall) | Model B = ProxyTool (billed on overhead only)\n");

const cCols = ["provider", "model", "$/task", ...volumes.map((v) => `$/mo @${v / 1000}k`)];
const cRows = [];
for (const [name, p] of Object.entries(pricing.providers)) {
  for (const model of ["A", "B"]) {
    const per = perTaskCost(name, p, model);
    const monthly = volumes.map((v) => {
      let m = per * v;
      if (p.monthlyFloor) m = Math.max(m, p.monthlyFloor);
      return `$${m.toFixed(m < 100 ? 2 : 0)}`;
    });
    cRows.push([name, model, `$${per.toFixed(6)}`, ...monthly]);
  }
}
const cWidths = cCols.map((c, i) => Math.max(c.length, ...cRows.map((r) => String(r[i]).length)));
const cLine = (cells) => "  " + cells.map((c, i) => String(c).padEnd(cWidths[i])).join("  ");
console.log(cLine(cCols));
console.log("  " + cWidths.map((w) => "-".repeat(w)).join("  "));
for (const r of cRows) console.log(cLine(r));
if (pricing.providers.e2b?.monthlyFloor) {
  console.log(`\n  note: e2b monthly totals floored at $${pricing.providers.e2b.monthlyFloor}/mo (plan minimum).`);
}
console.log();
