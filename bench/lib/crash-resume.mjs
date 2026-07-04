/**
 * bench/lib/crash-resume.mjs — durable-execution scenario driver.
 *
 * Measures and verifies crash → resume (durable turns, per-turn checkpoints):
 * a multi-turn task is killed mid-run with SIGKILL — server host AND runner —
 * then the server is restarted on the same project dir. Startup orphan
 * recovery (`recoverOrphanedTasks`) must harvest the run record's
 * `resumeState` checkpoint and respawn the task so it RESUMES at
 * checkpoint+1 instead of retrying from zero.
 *
 * Why a dedicated child-hosted server (instead of the shared local server):
 *   - recovery is a STARTUP path — the server process must actually die and
 *     come back (a live orchestrator that sees a dead runner goes through
 *     the stale/retry path, not resume);
 *   - PolpoServer traps SIGTERM/SIGINT into gracefulStop(), which marks
 *     runs killed and DELETES the run records — destroying the checkpoint.
 *     Only SIGKILL simulates a real crash.
 *
 * The kill is timed off mock-side truth: the loop runner awaits the turn-K
 * checkpoint write before issuing the request for turn K+1, so once the
 * mock has served turn `killAfterTurn + 1`, the checkpoint for
 * `killAfterTurn` is durably on disk. Invariants (all from public
 * contracts: task API + mock stats):
 *
 *   (a) the task completes `done` after recovery;
 *   (b) turns ≤ killAfterTurn are NEVER re-requested
 *       (mock `turnRequests[t] === 1`) — Temporal semantics: recorded
 *       turns replay from seeded history, they don't re-execute;
 *   (c) the final result text is byte-identical to a control run of the
 *       same directive without a crash;
 *   (d) the seeded history reached the model: the mock saw call-ids
 *       ≥ killAfterTurn inside an incoming request (`maxHistoryTurn`).
 *
 * Metrics: wall (incl. downtime), control wall, downtime, resumed-from
 * turn, turns saved by the checkpoint, duplicated turns (in-flight at
 * crash — at most the un-checkpointed tail).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { writeProject } from "./project.mjs";
import { buildDirective, genSid } from "./directive.mjs";
import { PolpoClient } from "./client.mjs";

const LIB_DIR = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Child server host ────────────────────────────────────────────────────────

function startHost({ serverEntry, port, projectDir }) {
  const child = spawn(
    process.execPath,
    [join(LIB_DIR, "server-host.mjs"), "--entry", serverEntry, "--port", String(port), "--workdir", projectDir],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderrTail = "";
  child.stderr.on("data", (c) => {
    stderrTail = (stderrTail + c.toString()).slice(-2000);
  });
  return {
    child,
    get pid() { return child.pid; },
    get stderrTail() { return stderrTail; },
    sigkill() {
      try { process.kill(child.pid, "SIGKILL"); } catch { /* already dead */ }
    },
  };
}

async function waitForApi(polpo, host, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await polpo.probe({ timeoutMs: 2_000 });
    } catch (err) {
      if (host.child.exitCode !== null && host.child.exitCode !== undefined && host.child.exitCode !== 0) {
        throw new Error(`server host died (exit ${host.child.exitCode}): ${host.stderrTail.slice(-500)}`);
      }
      if (Date.now() > deadline) {
        throw new Error(`server host not reachable: ${err.message}; stderr: ${host.stderrTail.slice(-500)}`);
      }
    }
  }
}

// ─── Task helpers ─────────────────────────────────────────────────────────────

async function createDirectiveTask(polpo, scenario, sid, titleSuffix, taskExecutionMode) {
  const directive = buildDirective(sid, scenario.directive);
  const description =
    `${directive}\n\n` +
    `Benchmark task — the model behavior is fully scripted by the directive above. ` +
    `Execute the requested tool calls and finish.`;
  const createdAtMs = Date.now();
  const task = await polpo.createTask({
    title: `bench:${scenario.name}${titleSuffix}`,
    description,
    assignTo: scenario.agent,
    expectations: [],
    ...(taskExecutionMode ? { executionMode: taskExecutionMode } : {}),
    ...(scenario.taskOpts ?? {}),
  });
  return { sid, taskId: task.id, createdAtMs };
}

/** turnRequests {turn: count} → sorted list of duplicated turns. */
function duplicatedTurns(turnRequests) {
  return Object.entries(turnRequests ?? {})
    .filter(([, count]) => count > 1)
    .map(([turn, count]) => ({ turn: Number(turn), count }))
    .sort((a, b) => a.turn - b.turn);
}

// ─── Scenario driver ──────────────────────────────────────────────────────────

/**
 * @param {object} scenario   the crash_resume scenario (directive, killAfterTurn, invariants, ...)
 * @param {object} opts
 *   serverEntry        path to dist/server/index.js
 *   mock               MockClient (already health-checked)
 *   mockPort           mock LLM port (written into the throwaway project)
 *   port               dedicated port for the child-hosted server
 *   executionMode      "subprocess" | "in-process" | null — project-wide
 *                      settings.taskExecution for the throwaway project
 *   enforceExecutionMode  when true, assert run records report executionMode
 *   keep               keep the temp project dir
 */
export async function runCrashResume(scenario, opts) {
  const { serverEntry, mock, mockPort, port, executionMode = null, enforceExecutionMode = false, keep = false } = opts;
  const startedAt = Date.now();
  const killAfterTurn = scenario.killAfterTurn;
  const totalTurns = scenario.directive.turns;

  const checks = [];
  const push = (name, pass, detail) => checks.push({ name, pass, detail });

  const projectDir = mkdtempSync(join(tmpdir(), "polpo-bench-crash-"));
  writeProject(projectDir, mockPort, { executionMode });

  const polpo = new PolpoClient(`http://127.0.0.1:${port}`, { xffRotate: true });
  let host = startHost({ serverEntry, port, projectDir });

  const metrics = {};
  let crashTaskId = null;
  let controlTaskId = null;

  try {
    await waitForApi(polpo, host);

    // ── 1. Control run: same directive, no crash — ground truth ──
    const control = await createDirectiveTask(polpo, scenario, genSid(), "#control", null);
    controlTaskId = control.taskId;
    const controlPolled = await polpo.pollTask(control.taskId, control.createdAtMs, {
      timeoutMs: scenario.timeoutMs,
      intervalMs: 100,
      captureRun: true,
    });
    if (controlPolled.timedOut) {
      push("control_terminal", false, `control run did not finish within ${scenario.timeoutMs}ms (last: ${controlPolled.task?.status})`);
      return finish();
    }
    push("control_terminal", controlPolled.task.status === "done", `control run: ${controlPolled.task.status}`);
    const controlResultText = controlPolled.task?.result?.stdout ?? null;
    metrics.control_wall_ms = controlPolled.wallMs;

    // ── 2. Crash run ──
    const crash = await createDirectiveTask(polpo, scenario, genSid(), "", null);
    crashTaskId = crash.taskId;
    const sid = crash.sid;

    // Watch task + mock until the kill window: run record captured AND the
    // mock has served turn killAfterTurn+1 (⇒ checkpoint for killAfterTurn
    // is durably written — the engine awaits the checkpoint sink before the
    // next request).
    let runInfo = null;
    let killStats = null;
    const killDeadline = Date.now() + scenario.timeoutMs;
    for (;;) {
      if (Date.now() > killDeadline) {
        push("kill_window", false, "timed out waiting for the kill window");
        return finish();
      }
      const task = await polpo.getTask(crash.taskId);
      if (task.status === "done" || task.status === "failed") {
        push("kill_window", false, `task reached ${task.status} before the kill fired — increase turns/latencyMs`);
        return finish();
      }
      if (runInfo === null && task.status !== "pending") {
        try {
          const activity = await polpo.getTaskActivity(crash.taskId);
          runInfo = PolpoClient.pickRunInfo(activity?.run);
        } catch { /* not up yet */ }
      }
      const s = await mock.stats(sid);
      if (runInfo !== null && (s?.stats?.turnsServed ?? 0) >= killAfterTurn + 1) {
        killStats = s.stats;
        break;
      }
      await sleep(40);
    }
    push("kill_window", true, `killed at mock turn ${killStats.turnsServed} (threshold ${killAfterTurn + 1})`);
    metrics.kill_at_turn = killStats.turnsServed;
    const preKillRequests = killStats.requests;

    // ── 3. CRASH: SIGKILL server host first (nothing left alive to observe
    // the runner death through the live path), then the runner subprocess.
    // In-process runs (negative synthetic pid) die with the host. ──
    const killedAtMs = Date.now();
    host.sigkill();
    if (runInfo.pid > 0) {
      try { process.kill(runInfo.pid, "SIGKILL"); } catch { /* already dead */ }
    }
    await sleep(300); // let the OS reap before restart

    // ── 4. Restart on the same project dir/port. PolpoServer runs orphan
    // recovery inside initInteractive() BEFORE binding HTTP, so a healthy
    // /health implies recovery already harvested the checkpoint. ──
    host = startHost({ serverEntry, port, projectDir });
    await waitForApi(polpo, host);
    metrics.downtime_ms = Date.now() - killedAtMs;

    // ── 5. Poll to terminal (wall includes crash + downtime + resume) ──
    const polled = await polpo.pollTask(crash.taskId, crash.createdAtMs, {
      timeoutMs: scenario.timeoutMs,
      intervalMs: 100,
      captureRun: true,
      tolerateErrors: true,
    });
    if (polled.timedOut) {
      push("terminal_reached", false, `no terminal state within ${scenario.timeoutMs}ms of creation (last: ${polled.task?.status})`);
      await polpo.killTask(crash.taskId);
      return finish();
    }
    push("terminal_reached", true, polled.task.status);
    push(
      "terminal_status",
      (scenario.invariants?.terminal ?? ["done"]).includes(polled.task.status),
      `expected one of [${(scenario.invariants?.terminal ?? ["done"]).join(", ")}], got "${polled.task.status}"`,
    );
    metrics.wall_ms = polled.wallMs;

    // ── 6. Mock-side verification ──
    const finalStats = (await mock.stats(sid))?.stats;
    if (!finalStats) {
      push("mock_stats", false, `mock has no stats for sid ${sid}`);
      return finish();
    }
    const dups = duplicatedTurns(finalStats.turnRequests);
    const resumedFromTurn = dups.length > 0 ? dups[0].turn : killStats.turnsServed + 1;
    const turnsSaved = resumedFromTurn - 1;

    // (b) NON-RE-EXECUTION: every turn whose checkpoint predates the kill
    // must have been requested exactly once. Retry-from-zero re-requests
    // turns 1..killAfterTurn and fails here.
    const reexecuted = dups.filter((d) => d.turn <= killAfterTurn);
    push(
      "resume_no_reexecution",
      reexecuted.length === 0,
      reexecuted.length === 0
        ? `turns 1..${killAfterTurn} requested exactly once — resumed from turn ${resumedFromTurn} (${turnsSaved} turns saved)`
        : `turns re-executed after resume: ${reexecuted.map((d) => `${d.turn}(x${d.count})`).join(", ")} — checkpoint was not used`,
    );
    // Only the un-checkpointed in-flight tail may replay, and at most once.
    push(
      "resume_duplicates_bounded",
      dups.length <= 2 && dups.every((d) => d.count === 2),
      `duplicated turns: ${dups.length ? dups.map((d) => `${d.turn}(x${d.count})`).join(", ") : "none"} (allowed: ≤2 turns, ≤2 requests each)`,
    );
    // (d) seeded history reached the model wire-side after the restart.
    push(
      "history_seeded",
      (finalStats.maxHistoryTurn ?? 0) >= killAfterTurn,
      `max bench call-id turn seen in an incoming request: ${finalStats.maxHistoryTurn} (need ≥ ${killAfterTurn})`,
    );
    // All scripted turns served exactly to completion.
    push(
      "turns_served",
      finalStats.turnsServed === totalTurns + 1,
      `expected ${totalTurns + 1} (=${totalTurns} tool turns + final), mock served ${finalStats.turnsServed}`,
    );
    push("finals", finalStats.finals === 1, `expected exactly 1 final response, got ${finalStats.finals}`);

    // (c) result identical to the no-crash control run.
    const crashResultText = polled.task?.result?.stdout ?? null;
    push(
      "final_result_identical",
      controlResultText !== null && crashResultText === controlResultText,
      crashResultText === controlResultText
        ? `result text identical to control (${controlResultText?.length ?? 0} bytes)`
        : `crash-run result differs from control (control: ${JSON.stringify(controlResultText)?.slice(0, 120)}, crash: ${JSON.stringify(crashResultText)?.slice(0, 120)})`,
    );

    // Execution-mode invariant (pre-crash run + post-resume run).
    if (enforceExecutionMode && executionMode) {
      const runs = [
        ["pre-crash", runInfo],
        ["post-resume", polled.run],
      ];
      for (const [phase, r] of runs) {
        const pidOk = r ? (executionMode === "in-process" ? r.pid < 0 : r.pid > 0) : false;
        push(
          `execution_mode_${phase.replace("-", "_")}`,
          r?.executionMode === executionMode && pidOk,
          r
            ? `${phase} run: executionMode=${r.executionMode}, pid=${r.pid} (expected ${executionMode})`
            : `${phase} run record never observed`,
        );
      }
    }

    metrics.resumed_from_turn = resumedFromTurn;
    metrics.turns_saved = turnsSaved;
    metrics.duplicated_turns = dups.length;
    metrics.llm_ms = finalStats.llmBusyMs;
    metrics.turns = finalStats.turnsServed;
    metrics.llm_requests = finalStats.requests;
    metrics.requests_pre_crash = preKillRequests;
    metrics.requests_post_crash = finalStats.requests - preKillRequests;
    metrics.tool_calls = finalStats.toolCallsEmitted;

    return finish(polled);
  } catch (err) {
    push("execution", false, err.message);
    return finish();
  } finally {
    // Best-effort teardown (host may already be dead).
    try {
      if (crashTaskId) await polpo.deleteTask(crashTaskId);
      if (controlTaskId) await polpo.deleteTask(controlTaskId);
    } catch { /* server gone */ }
    host.sigkill();
    if (!keep) {
      try { rmSync(projectDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }

  function finish(polled = null) {
    return {
      name: scenario.name,
      description: scenario.description,
      params: scenario.directive,
      killAfterTurn,
      executionMode,
      pass: checks.every((c) => c.pass),
      terminal: polled?.task?.status ?? null,
      metrics,
      timeline: polled?.timeline,
      checks,
      elapsed_ms: Date.now() - startedAt,
    };
  }
}
