#!/usr/bin/env node
/**
 * bench/run.mjs — runtime-agnostic Polpo task benchmark runner.
 *
 * Usage:
 *   node bench/run.mjs [--label <label>] [--only <names,csv>]
 *                      [--mock-port 8377] [--port 8378]
 *                      [--target <url>] [--mock-url <url>]
 *                      [--keep]
 *
 * Local mode (default, no --target):
 *   1. creates a throwaway Polpo project (polpo.json + agents.json) in a temp dir
 *   2. starts the mock LLM (bench/mock-llm.mjs) on --mock-port
 *   3. starts a PolpoServer from <repo>/dist on --port pointing at the temp project
 *   4. runs every scenario through the public task API, checking invariants
 *   5. writes bench/results/<ISO-ts>-<gitsha7>-<label>.json and tears everything down
 *
 * Target mode (--target http://host:port):
 *   Uses an already-running Polpo server whose project is configured with the
 *   bench provider override pointing at a reachable mock (--mock-url, default
 *   http://127.0.0.1:8377). This is how the same suite runs against a sandbox
 *   or a different runtime branch.
 *
 * Only talks to public contracts: the task REST API + the mock's /bench/stats.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir, hostname } from "node:os";
import { join, dirname, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import { createMockLlm } from "./mock-llm.mjs";
import { scenarios as allScenarios, selectScenarios } from "./scenarios.mjs";
import { buildDirective, genSid } from "./lib/directive.mjs";
import { PolpoClient, MockClient } from "./lib/client.mjs";

const BENCH_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(BENCH_DIR, "..");

// ─── Args ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { label: "run", mockPort: 8377, port: 8378, target: null, mockUrl: null, only: null, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--label") args.label = argv[++i];
    else if (a === "--mock-port") args.mockPort = Number(argv[++i]);
    else if (a === "--port") args.port = Number(argv[++i]);
    else if (a === "--target") args.target = argv[++i];
    else if (a === "--mock-url") args.mockUrl = argv[++i];
    else if (a === "--only") args.only = argv[++i];
    else if (a === "--keep") args.keep = true;
    else if (a === "--help" || a === "-h") {
      console.log("Usage: node bench/run.mjs [--label <label>] [--target <url>] [--mock-port 8377] [--port 8378] [--only <names,csv>] [--keep]");
      process.exit(0);
    }
  }
  return args;
}

// ─── Local environment setup ──────────────────────────────────────────────────

function writeProject(dir, mockPort) {
  const polpoDir = join(dir, ".polpo");
  mkdirSync(polpoDir, { recursive: true });
  writeFileSync(
    join(polpoDir, "polpo.json"),
    JSON.stringify(
      {
        project: "polpo-bench",
        settings: {
          storage: "file",
          maxRetries: 0, // failures must be terminal — no silent retries mid-benchmark
          workDir: ".",
          logLevel: "quiet",
        },
        // NOTE: the provider is named "openai" (with a baseUrl override) instead
        // of a dedicated "bench" provider because the runtime's pre-spawn
        // validation (validateProviderKeys) only accepts providers present in
        // the static PROVIDER_ENV_MAP — unknown custom providers can never
        // spawn task agents. See bench/README.md, "Runtime findings".
        providers: {
          openai: { baseUrl: `http://127.0.0.1:${mockPort}/v1` },
        },
      },
      null,
      2,
    ),
  );
  // FileAgentStore format: [{ agent: AgentConfig, teamName }]
  writeFileSync(
    join(polpoDir, "agents.json"),
    JSON.stringify(
      [
        {
          agent: { name: "bench-agent", role: "developer", model: "openai/mock-1", maxTurns: 250 },
          teamName: "bench",
        },
        {
          agent: { name: "bench-capped", role: "developer", model: "openai/mock-1", maxTurns: 15 },
          teamName: "bench",
        },
      ],
      null,
      2,
    ),
  );
}

/**
 * Provider-override glue for runner subprocesses — see lib/preload-providers.mjs.
 * Harmless no-op on runtimes that propagate polpo.json providers themselves.
 */
function injectRunnerEnv(mockPort) {
  const preload = pathToFileURL(join(BENCH_DIR, "lib", "preload-providers.mjs")).href;
  // Dummy key: satisfies the runtime's env-var key validation AND shields the
  // benchmark from ever hitting the real OpenAI API by accident.
  process.env.OPENAI_API_KEY = "bench-mock-key";
  process.env.POLPO_BENCH_PROVIDERS = JSON.stringify({
    openai: { baseUrl: `http://127.0.0.1:${mockPort}/v1` },
  });
  process.env.POLPO_BENCH_LLM_DIST = join(REPO_ROOT, "dist", "llm", "pi-client.js");
  const existing = process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : "";
  process.env.NODE_OPTIONS = `${existing}--import ${preload}`;
}

// ─── Scenario execution ───────────────────────────────────────────────────────

function checkInvariants(scenario, outcome) {
  const inv = scenario.invariants ?? {};
  const checks = [];
  const push = (name, pass, detail) => checks.push({ name, pass, detail });

  if (outcome.timedOut) {
    push("terminal_reached", false, `no terminal state within ${scenario.timeoutMs}ms (last: ${outcome.task?.status})`);
    return checks;
  }
  push("terminal_reached", true, outcome.task.status);

  if (inv.terminal) {
    push(
      "terminal_status",
      inv.terminal.includes(outcome.task.status),
      `expected one of [${inv.terminal.join(", ")}], got "${outcome.task.status}"`,
    );
  }
  const stats = outcome.mockStats?.stats;
  if (inv.turnsServed !== undefined && stats) {
    const t = stats.turnsServed;
    const pass =
      typeof inv.turnsServed === "number"
        ? t === inv.turnsServed
        : t >= (inv.turnsServed.min ?? 0) && t <= (inv.turnsServed.max ?? Infinity);
    push("turns_served", pass, `expected ${JSON.stringify(inv.turnsServed)}, mock served ${t}`);
  }
  if (inv.toolCalls !== undefined && stats) {
    push("tool_calls", stats.toolCallsEmitted === inv.toolCalls, `expected ${inv.toolCalls}, mock emitted ${stats.toolCallsEmitted}`);
  }
  if (inv.outcomes !== undefined) {
    const n = Array.isArray(outcome.task.outcomes) ? outcome.task.outcomes.length : 0;
    push("outcomes", n === inv.outcomes, `expected ${inv.outcomes}, task record has ${n}`);
  }
  if (inv.maxWallMs !== undefined) {
    push("max_wall", outcome.wallMs <= inv.maxWallMs, `wall ${outcome.wallMs}ms vs max ${inv.maxWallMs}ms`);
  }
  return checks;
}

async function runSingleTask(polpo, mock, scenario, sid, pollIntervalMs) {
  const created = await createScenarioTask(polpo, scenario, sid);
  const polled = await polpo.pollTask(created.taskId, created.createdAtMs, {
    timeoutMs: scenario.timeoutMs,
    intervalMs: pollIntervalMs,
  });
  if (polled.timedOut) await polpo.killTask(created.taskId);
  const mockStats = await mock.stats(sid);
  return { ...created, mockStats, ...polled };
}

async function createScenarioTask(polpo, scenario, sid, taskIndex = 0) {
  const directive = buildDirective(sid, scenario.directive);
  const description =
    `${directive}\n\n` +
    `Benchmark task — the model behavior is fully scripted by the directive above. ` +
    `Execute the requested tool calls and finish.`;
  const createdAtMs = Date.now();
  const task = await polpo.createTask({
    title: `bench:${scenario.name}${scenario.concurrency ? `#${taskIndex}` : ""}`,
    description,
    assignTo: scenario.agent,
    expectations: [],
    ...(scenario.taskOpts ?? {}),
  });
  return { sid, taskId: task.id, createdAtMs, postMs: Date.now() - createdAtMs };
}

async function runScenario(polpo, mock, scenario, pollIntervalMs) {
  const startedAt = Date.now();

  if (scenario.concurrency && scenario.concurrency > 1) {
    // Fire all creations together, then poll them all with ONE shared
    // GET /tasks loop (rate-limit friendly, identical precision).
    const created = await Promise.all(
      Array.from({ length: scenario.concurrency }, (_, i) => createScenarioTask(polpo, scenario, genSid(), i)),
    );
    const polled = await polpo.pollMany(created, { timeoutMs: scenario.timeoutMs, intervalMs: pollIntervalMs * 2 });
    const runs = [];
    for (let i = 0; i < created.length; i++) {
      const c = created[i];
      const p = polled[i];
      if (p.timedOut) await polpo.killTask(c.taskId);
      const mockStats = await mock.stats(c.sid);
      runs.push({ ...c, ...p, mockStats });
    }
    const makespanMs = Math.max(...runs.map((r) => r.wallMs));
    const walls = runs.map((r) => r.wallMs).sort((a, b) => a - b);
    const llmMs = runs.reduce((sum, r) => sum + (r.mockStats?.stats?.llmBusyMs ?? 0), 0);
    const perTaskChecks = runs.map((r) => checkInvariants(scenario, r));
    const failing = perTaskChecks.flat().filter((c) => !c.pass);
    const checks = [
      { name: "all_tasks_pass", pass: failing.length === 0, detail: failing.length ? `${failing.length} failing sub-checks` : `${runs.length}/${runs.length} tasks green` },
    ];
    for (const r of runs) await polpo.deleteTask(r.taskId);
    return {
      name: scenario.name,
      description: scenario.description,
      params: scenario.directive,
      concurrency: scenario.concurrency,
      pass: failing.length === 0,
      terminal: runs.map((r) => r.task?.status),
      metrics: {
        makespan_ms: makespanMs,
        wall_ms_min: walls[0],
        wall_ms_median: walls[Math.floor(walls.length / 2)],
        wall_ms_max: walls[walls.length - 1],
        llm_ms_total: llmMs,
        spawn_ms_min: Math.min(...runs.map((r) => r.spawnMs ?? Infinity)),
        spawn_ms_max: Math.max(...runs.map((r) => r.spawnMs ?? 0)),
      },
      checks,
      tasks: runs.map((r) => ({
        sid: r.sid,
        wall_ms: r.wallMs,
        spawn_ms: r.spawnMs,
        terminal: r.task?.status,
        llm_ms: r.mockStats?.stats?.llmBusyMs ?? null,
        turns: r.mockStats?.stats?.turnsServed ?? null,
      })),
      elapsed_ms: Date.now() - startedAt,
    };
  }

  const run = await runSingleTask(polpo, mock, scenario, genSid(), pollIntervalMs);
  const checks = checkInvariants(scenario, run);
  const stats = run.mockStats?.stats;
  const llmMs = stats?.llmBusyMs ?? null;
  // Engine-loop duration seen from the model's side (first→last LLM request).
  // Unlike wall_ms this is NOT quantized by the orchestrator tick, so it is
  // the most precise cross-runtime comparison of the agent loop itself.
  const loopMs =
    stats?.firstRequestAt && stats?.lastRequestAt
      ? new Date(stats.lastRequestAt).getTime() - new Date(stats.firstRequestAt).getTime()
      : null;
  await polpo.deleteTask(run.taskId);

  return {
    name: scenario.name,
    description: scenario.description,
    params: scenario.directive,
    sid: run.sid,
    pass: checks.every((c) => c.pass),
    terminal: run.task?.status ?? null,
    metrics: {
      wall_ms: run.wallMs,
      spawn_ms: run.spawnMs,
      llm_ms: llmMs,
      overhead_ms: llmMs !== null ? run.wallMs - llmMs : null,
      loop_ms: loopMs,
      loop_overhead_ms: loopMs !== null && llmMs !== null ? Math.max(0, loopMs - llmMs) : null,
      turns: stats?.turnsServed ?? null,
      llm_requests: stats?.requests ?? null,
      tool_calls: stats?.toolCallsEmitted ?? null,
      outcome_calls: stats?.outcomeCallsEmitted ?? null,
      summarize_calls: stats?.summarizeCalls ?? null,
      post_ms: run.postMs,
    },
    timeline: run.timeline,
    checks,
    elapsed_ms: Date.now() - startedAt,
  };
}

// ─── Reporting ────────────────────────────────────────────────────────────────

function gitSha() {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: REPO_ROOT, encoding: "utf-8" }).trim();
  } catch {
    return "nosha";
  }
}

function fmt(v) {
  return v === null || v === undefined ? "-" : typeof v === "number" ? String(Math.round(v)) : String(v);
}

function printTable(results) {
  const cols = ["scenario", "pass", "terminal", "wall_ms", "spawn_ms", "llm_ms", "overhead_ms", "loop_ms", "turns", "tool_calls"];
  const rows = results.map((r) => [
    r.name,
    r.pass ? "PASS" : "FAIL",
    Array.isArray(r.terminal) ? r.terminal.join(",").slice(0, 20) : fmt(r.terminal),
    fmt(r.metrics.wall_ms ?? r.metrics.makespan_ms),
    fmt(r.metrics.spawn_ms ?? r.metrics.spawn_ms_max),
    fmt(r.metrics.llm_ms ?? r.metrics.llm_ms_total),
    fmt(r.metrics.overhead_ms),
    fmt(r.metrics.loop_ms),
    fmt(r.metrics.turns),
    fmt(r.metrics.tool_calls),
  ]);
  const widths = cols.map((c, i) => Math.max(c.length, ...rows.map((row) => row[i].length)));
  const line = (cells) => "  " + cells.map((c, i) => c.padEnd(widths[i])).join("  ");
  console.log("\n" + line(cols));
  console.log("  " + widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) console.log(line(row));
  console.log();
  for (const r of results) {
    for (const c of r.checks.filter((c) => !c.pass)) {
      console.log(`  ! ${r.name} :: ${c.name}: ${c.detail}`);
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const selected = selectScenarios(args.only);

  let mockHandle = null;
  let polpoServer = null;
  let projectDir = null;

  const mockUrl = args.mockUrl ?? `http://127.0.0.1:${args.mockPort}`;
  const targetUrl = args.target ?? `http://127.0.0.1:${args.port}`;

  const cleanup = async () => {
    try {
      await polpoServer?.stop();
    } catch { /* already down */ }
    try {
      await mockHandle?.stop();
    } catch { /* already down */ }
    if (projectDir && !args.keep) {
      try {
        rmSync(projectDir, { recursive: true, force: true });
      } catch { /* best effort */ }
    }
  };

  try {
    if (!args.target) {
      // ── Local mode: temp project + in-repo dist server ──
      const serverEntry = join(REPO_ROOT, "dist", "server", "index.js");
      if (!existsSync(serverEntry)) {
        throw new Error(`dist not built: ${serverEntry} missing. Run pnpm build first.`);
      }
      projectDir = mkdtempSync(join(tmpdir(), "polpo-bench-"));
      writeProject(projectDir, args.mockPort);
      injectRunnerEnv(args.mockPort);

      mockHandle = createMockLlm({ port: args.mockPort, quiet: true });
      await mockHandle.start();

      console.log(`[bench] project: ${projectDir}`);
      console.log(`[bench] mock:    ${mockUrl}`);
      console.log(`[bench] server:  ${targetUrl} (dist @ ${gitSha()})`);

      const { PolpoServer } = await import(pathToFileURL(serverEntry).href);
      polpoServer = new PolpoServer({ port: args.port, host: "127.0.0.1", workDir: projectDir });
      await polpoServer.start();
    } else {
      console.log(`[bench] target:  ${targetUrl}`);
      console.log(`[bench] mock:    ${mockUrl} (assumed already running & wired into the target project)`);
    }

    const mock = new MockClient(mockUrl);
    await mock.health();

    // Local mode: rotate synthetic x-forwarded-for buckets so 100ms polling
    // doesn't trip the server's 200req/60s per-IP limiter. Target mode: a real
    // proxy owns XFF, so poll gently instead.
    const isLocal = !args.target;
    const pollIntervalMs = isLocal ? 100 : 300;
    const polpo = new PolpoClient(targetUrl, { apiKey: process.env.POLPO_API_KEY, xffRotate: isLocal });
    const prefix = await polpo.probe();
    console.log(`[bench] api:     ${targetUrl}${prefix}`);

    const results = [];
    for (const scenario of selected) {
      process.stdout.write(`[bench] ${scenario.name} ... `);
      try {
        const result = await runScenario(polpo, mock, scenario, pollIntervalMs);
        results.push(result);
        console.log(`${result.pass ? "PASS" : "FAIL"} (${Math.round(result.elapsed_ms / 1000)}s)`);
      } catch (err) {
        console.log(`ERROR: ${err.message}`);
        results.push({
          name: scenario.name,
          description: scenario.description,
          params: scenario.directive,
          pass: false,
          terminal: null,
          metrics: {},
          checks: [{ name: "execution", pass: false, detail: err.message }],
          elapsed_ms: 0,
        });
      }
    }

    // ── Persist results ──
    const meta = {
      ts: new Date().toISOString(),
      sha: gitSha(),
      label: args.label,
      node: process.version,
      hostname: hostname(),
      target: args.target ?? "local",
      mode: args.target ? "target" : "local",
    };
    const resultsDir = join(BENCH_DIR, "results");
    mkdirSync(resultsDir, { recursive: true });
    const fileName = `${meta.ts.replace(/[:.]/g, "-")}-${meta.sha}-${meta.label}.json`;
    const outPath = join(resultsDir, fileName);
    writeFileSync(outPath, JSON.stringify({ meta, scenarios: results }, null, 2));

    printTable(results);
    console.log(`[bench] results: ${outPath}`);
    const failed = results.filter((r) => !r.pass);
    console.log(`[bench] ${results.length - failed.length}/${results.length} scenarios green${failed.length ? ` — failing: ${failed.map((f) => f.name).join(", ")}` : ""}`);

    await cleanup();
    process.exit(failed.length > 0 ? 1 : 0);
  } catch (err) {
    console.error(`[bench] fatal: ${err.stack ?? err.message}`);
    await cleanup();
    process.exit(1);
  }
}

main();
