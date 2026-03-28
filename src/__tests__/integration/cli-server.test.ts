import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, mkdir, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";

import type { Orchestrator } from "../../core/orchestrator.js";
import type { SSEBridge } from "../../server/sse-bridge.js";

const execFileAsync = promisify(execFile);

/**
 * CLI ↔ Local Server integration tests.
 *
 * Runs the **real compiled binary** (`node dist/cli/index.js`) against
 * a live Polpo HTTP server.  No mocks, no Commander imports — the full
 * CLI binary is exercised end-to-end.
 *
 * Requires `pnpm build` to have been run first (tests the compiled output).
 */

// ── Path to the built CLI binary ─────────────────────────────────────
const __dirname_test = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname_test, "..", "..", "..", "dist", "cli", "index.js");
const ROOT = resolve(__dirname_test, "..", "..", "..");

// ── Helper: run the CLI binary and capture output ────────────────────

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Execute the polpo CLI binary via `node dist/cli/index.js`.
 * Returns stdout, stderr, and the exit code.
 */
async function run(args: string[], opts?: { cwd?: string; timeout?: number }): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync("node", [CLI, ...args], {
      cwd: opts?.cwd ?? ROOT,
      timeout: opts?.timeout ?? 30_000,
      env: {
        ...process.env,
        FORCE_COLOR: "0",              // no ANSI escape codes
        NO_COLOR: "1",                 // respected by chalk + disables update checker
        NODE_NO_WARNINGS: "1",        // suppress experimental warnings
        POLPO_NO_UPDATE_CHECK: "1",   // explicitly skip npm update check
      },
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err: any) {
    // execFile rejects on non-zero exit. err still has stdout/stderr.
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      exitCode: typeof err.code === "number" ? err.code : 1,
    };
  }
}

// ── Config shared by server + CLI ────────────────────────────────────

const POLPO_CONFIG = JSON.stringify({
  project: "cli-integration",
  team: {
    name: "test-team",
    agents: [
      { name: "agent-1", role: "Test agent" },
    ],
  },
  settings: { maxRetries: 2, logLevel: "quiet" },
}, null, 2);

// ── Shared state ─────────────────────────────────────────────────────

let tmpDir: string;
let orchestrator: Orchestrator;
let sseBridge: SSEBridge;
let server: ReturnType<typeof import("@hono/node-server").serve>;
let port: number;

// =====================================================================
// 1. Standalone CLI commands (no server needed)
// =====================================================================

describe("CLI standalone (no server)", () => {
  it("polpo --version — prints version and exits 0", async () => {
    const r = await run(["--version"]);
    expect(r.exitCode).toBe(0);
    // Version string should be a semver-like pattern (e.g. "0.4.0")
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("polpo --help — prints help text", async () => {
    const r = await run(["--help"]);
    expect(r.exitCode).toBe(0);
    const out = r.stdout + r.stderr;
    expect(out).toContain("polpo-ai");
    expect(out).toContain("task");
    expect(out).toContain("memory");
  });

  it("polpo models list --json — exits 0, outputs JSON array", async () => {
    const r = await run(["models", "list", "--json"]);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout.trim());
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    // Each model should have at least id and provider
    expect(parsed[0]).toHaveProperty("id");
    expect(parsed[0]).toHaveProperty("provider");
  });

  it("polpo init --dir <new-dir> — creates .polpo/ directory", async () => {
    const initDir = await mkdtemp(join(tmpdir(), "polpo-cli-init-"));
    try {
      // init launches a setup wizard interactively — pipe stdin to avoid hang.
      // We use execFile with stdin closed so it falls through to the non-interactive fallback.
      const r = await run(["init", "--dir", initDir], { timeout: 15_000 });
      // init may exit 0 or may error if it requires interactive input.
      // Either way, it should have created the .polpo directory.
      const entries = await readdir(join(initDir, ".polpo")).catch(() => [] as string[]);
      expect(entries.length).toBeGreaterThanOrEqual(0);
      // The .polpo directory itself should exist
      const polpoDirExists = await readdir(initDir).then(e => e.includes(".polpo"));
      expect(polpoDirExists).toBe(true);
    } finally {
      await rm(initDir, { recursive: true, force: true });
    }
  });
});

// =====================================================================
// 2. Project-scoped CLI commands (need a project dir + server)
// =====================================================================

describe("CLI with project directory", () => {
  beforeAll(async () => {
    // 1. Create a temp workspace with a valid polpo config
    tmpDir = await mkdtemp(join(tmpdir(), "polpo-cli-integration-"));
    await mkdir(join(tmpDir, ".polpo"), { recursive: true });
    await writeFile(join(tmpDir, ".polpo", "polpo.json"), POLPO_CONFIG);

    // Seed teams.json and agents.json (required by FileTeamStore/FileAgentStore)
    await writeFile(
      join(tmpDir, ".polpo", "teams.json"),
      JSON.stringify([{ name: "test-team", agents: [] }], null, 2),
    );
    await writeFile(
      join(tmpDir, ".polpo", "agents.json"),
      JSON.stringify([{ agent: { name: "agent-1", role: "Test agent" }, teamName: "test-team" }], null, 2),
    );

    // 2. Boot orchestrator + SSE bridge + Hono server
    const { Orchestrator: OrchestratorClass } = await import("../../core/orchestrator.js");
    const { SSEBridge: SSEBridgeClass } = await import("../../server/sse-bridge.js");
    const { createApp } = await import("../../server/app.js");
    const { serve } = await import("@hono/node-server");

    orchestrator = new OrchestratorClass(tmpDir);
    await orchestrator.initInteractive("cli-integration", {
      name: "test-team",
      agents: [{ name: "agent-1", role: "Test agent" }],
    });

    sseBridge = new SSEBridgeClass(orchestrator);
    sseBridge.start();

    const app = createApp(orchestrator, sseBridge, { workDir: tmpDir });

    const listening = new Promise<number>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0 }, (info: AddressInfo) => {
        resolve(info.port);
      });
    });

    port = await listening;
  }, 30_000);

  afterAll(async () => {
    server?.close();
    sseBridge?.dispose();
    if (orchestrator?.isInitialized) {
      await orchestrator.gracefulStop();
    }
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  // ── Task lifecycle: add → list → show → delete ────────────────────

  let createdTaskId: string;

  it("polpo task add --no-prep — creates a task", async () => {
    const r = await run([
      "task", "add", "--no-prep", "-d", tmpDir, "-a", "agent-1",
      "CLI integration test task",
    ]);
    expect(r.exitCode).toBe(0);
    const out = r.stdout + r.stderr;
    expect(out).toContain("Task created");
    expect(out).toContain("CLI integration test task");

    // Extract task ID from output (format: "ID:    <id>" with possible ANSI/spacing)
    const idMatch = out.match(/ID:\s*([a-zA-Z0-9_-]{10,})/);
    expect(idMatch).toBeTruthy();
    createdTaskId = idMatch![1];
    expect(createdTaskId).toBeTruthy();
  });

  it("polpo task list — shows the created task", async () => {
    const r = await run(["task", "list", "-d", tmpDir]);
    expect(r.exitCode).toBe(0);
    const out = r.stdout + r.stderr;
    expect(out).toContain("CLI integration test task");
    expect(out).toContain("agent-1");
  });

  it("polpo task show <id> — displays task details", async () => {
    // Ensure we have a valid task ID from the add test
    if (!createdTaskId) {
      // Create one inline if the previous test didn't set it
      const add = await run(["task", "add", "--no-prep", "-d", tmpDir, "-a", "agent-1", "show test task"]);
      const m = (add.stdout + add.stderr).match(/ID:\s*(\S+)/);
      createdTaskId = m?.[1] ?? "";
    }
    expect(createdTaskId).toBeTruthy();
    const r = await run(["task", "show", createdTaskId, "-d", tmpDir]);
    expect(r.exitCode).toBe(0);
    const out = r.stdout + r.stderr;
    expect(out).toContain("Status:");
  });

  it("polpo task show <bogus> — fails for unknown task", async () => {
    const r = await run(["task", "show", "nonexistent-id-12345", "-d", tmpDir]);
    expect(r.exitCode).not.toBe(0);
    const out = r.stdout + r.stderr;
    expect(out).toContain("Task not found");
  });

  it("polpo task add — error when agent not found", async () => {
    const r = await run([
      "task", "add", "--no-prep", "-d", tmpDir, "-a", "ghost-agent",
      "Should fail",
    ]);
    expect(r.exitCode).not.toBe(0);
    const out = r.stdout + r.stderr;
    expect(out).toContain("Agent not found");
  });

  it("polpo task delete <id> — removes the task", { timeout: 30_000 }, async () => {
    // Create a fresh task to delete (independent of previous tests)
    const add = await run(["task", "add", "--no-prep", "-d", tmpDir, "-a", "agent-1", "delete me"]);
    expect(add.exitCode).toBe(0);
    const addOut = add.stdout + add.stderr;
    expect(addOut).toContain("Task created");

    // Extract task ID — try the "ID: <id>" format, fall back to any word after "ID:"
    const m = addOut.match(/ID:\s*([a-zA-Z0-9_-]{10,})/) ?? addOut.match(/ID:\s*(\S+)/);
    expect(m).toBeTruthy();
    const deleteId = m![1];
    expect(deleteId).toBeTruthy();

    const r = await run(["task", "delete", deleteId, "-d", tmpDir]);
    expect(r.exitCode).toBe(0);
    const out = r.stdout + r.stderr;
    expect(out).toContain("deleted");

    // Verify the deleted task is gone
    const listR = await run(["task", "list", "-d", tmpDir]);
    expect(listR.stdout + listR.stderr).not.toContain("delete me");
  });

  it("polpo task list --status done — filters (no done tasks)", async () => {
    const r = await run(["task", "list", "-d", tmpDir, "--status", "done"]);
    expect(r.exitCode).toBe(0);
    const out = r.stdout + r.stderr;
    expect(out).toContain("No tasks");
  });

  // ── Status ─────────────────────────────────────────────────────────

  it("polpo status — exits gracefully", async () => {
    const r = await run(["status", "-d", tmpDir]);
    // status exits 0 whether there are tasks or not
    expect(r.exitCode).toBe(0);
    // Should produce some output (logo, status, or "No tasks")
    const out = r.stdout + r.stderr;
    expect(out.length).toBeGreaterThan(0);
  });

  // ── Memory ─────────────────────────────────────────────────────────

  it("polpo memory show — empty initially", async () => {
    const r = await run(["memory", "show", "-d", tmpDir]);
    expect(r.exitCode).toBe(0);
    const out = r.stdout + r.stderr;
    expect(out).toContain("No shared memory");
  });

  it("polpo memory set — saves memory content", async () => {
    const r = await run(["memory", "set", "-d", tmpDir, "Architecture", "decisions", "from", "CLI"]);
    expect(r.exitCode).toBe(0);
    const out = r.stdout + r.stderr;
    expect(out).toContain("Shared memory saved");
  });

  it("polpo memory show — displays saved memory", async () => {
    const r = await run(["memory", "show", "-d", tmpDir]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Architecture decisions from CLI");
  });

  it("polpo memory append — adds to existing memory", async () => {
    const r = await run(["memory", "append", "-d", tmpDir, "New insight appended"]);
    expect(r.exitCode).toBe(0);
    const out = r.stdout + r.stderr;
    expect(out).toContain("Shared memory updated");
  });

  it("polpo memory show — shows both original and appended content", async () => {
    const r = await run(["memory", "show", "-d", tmpDir]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Architecture decisions from CLI");
    expect(r.stdout).toContain("New insight appended");
  });

  // ── Team ───────────────────────────────────────────────────────────

  it("polpo team list — shows initial agents", async () => {
    const r = await run(["team", "list", "-d", tmpDir]);
    expect(r.exitCode).toBe(0);
    const out = r.stdout + r.stderr;
    expect(out).toContain("test-team");
    expect(out).toContain("agent-1");
  });

  // ── Config ─────────────────────────────────────────────────────────

  it("polpo config show — displays project config", async () => {
    const r = await run(["config", "show", "-d", tmpDir]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("cli-integration");
  });

  it("polpo config validate — succeeds with valid config", async () => {
    const r = await run(["config", "validate", "-d", tmpDir]);
    // Should indicate success (exit 0 or contain valid/ok)
    const out = (r.stdout + r.stderr).toLowerCase();
    expect(out).toMatch(/valid|ok|✓/);
  });

  // ── Logs ───────────────────────────────────────────────────────────

  it("polpo logs list — shows sessions or empty message", async () => {
    const r = await run(["logs", "list", "-d", tmpDir]);
    expect(r.exitCode).toBe(0);
    const out = r.stdout + r.stderr;
    // Should produce some output (session rows or "No sessions")
    expect(out.length).toBeGreaterThan(0);
  });

  // ── Schedule ───────────────────────────────────────────────────────

  it("polpo schedule list — shows empty or unavailable", async () => {
    const r = await run(["schedule", "list", "-d", tmpDir]);
    expect(r.exitCode).toBe(0);
    const out = (r.stdout + r.stderr).toLowerCase();
    expect(out).toMatch(/no schedules|scheduler/i);
  });
});
