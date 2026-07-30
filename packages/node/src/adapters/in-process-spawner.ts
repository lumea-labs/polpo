/**
 * In-process Spawner — runs the agent lifecycle inside the orchestrator
 * process (no fork). First building block of the proxy execution model
 * (ProxyTool): the LLM loop lives in the server process; tools still run
 * locally through the injected fs/shell (sandbox tool proxying arrives in
 * later phases).
 *
 * Same lifecycle as the subprocess runner — both hosts call executeRun()
 * (core/run-lifecycle.ts). What differs is captured entirely in the deps:
 *
 *   - stores are the orchestrator's own (no second store/DB connection);
 *   - pid is a synthetic NEGATIVE id: never a real OS pid (positive) and
 *     never 0 (the "untracked" sandbox convention). isAlive()/kill()
 *     resolve against the in-memory active-run map;
 *   - kill() aborts via AbortController → engine abort → run "killed",
 *     mirroring the subprocess SIGTERM path (no SIGKILL escalation: the
 *     abort is the only lever; a run that ignores it is reaped by the
 *     orchestrator's stale/timeout health checks, same as a wedged
 *     subprocess);
 *   - SpawnResult.onExit fires when the run promise settles, so the
 *     reactive tick (run:exited wake event) works identically.
 *
 * A failing run can NEVER crash the orchestrator: executeRun persists all
 * run-level failures itself, and a last-resort catch here absorbs anything
 * thrown before the run record exists (degrading to the same stale-kill
 * fallback a subprocess that died pre-persist would get).
 */
import { mkdirSync, existsSync } from "node:fs";
import type { Spawner, SpawnResult } from "@polpo-ai/core/spawner";
import type { RunnerConfig } from "@polpo-ai/core/types";
import type { RunStore } from "@polpo-ai/core/run-store";
import type { VaultStore } from "@polpo-ai/core/vault-store";
import type { MemoryStore } from "@polpo-ai/core/memory-store";
import type { FileSystem } from "@polpo-ai/core/filesystem";
import type { Shell } from "@polpo-ai/core/shell";
import type { RunToolMiddleware } from "@polpo-ai/core/guardrails";
import { executeRun, errorResult, type TranscriptSession } from "../core/run-lifecycle.js";

/**
 * Stores and ports the in-process lifecycle runs against — the
 * orchestrator's own instances (see ExecuteRunDeps for per-field
 * semantics). createLogSession must open a DEDICATED LogStore
 * session per run: sharing the orchestrator's log-sink instance would
 * hijack its current session.
 */
export interface InProcessSpawnerDeps {
  runStore: RunStore;
  createLogSession?: () => Promise<TranscriptSession>;
  vaultStore?: VaultStore;
  memoryStore?: MemoryStore;
  fs?: FileSystem;
  shell?: Shell;
  /** Optional host-resolved guardrail middleware. */
  runToolMiddleware?: RunToolMiddleware;
  /** Per-tenant LLM gateway config — the in-process loop runs in a shared
   *  process with no per-tenant env, so the host must inject it here. */
  gatewayConfig?: unknown;
}

export class InProcessSpawner implements Spawner {
  /** Synthetic pid sequence: -1, -2, … (see module header). */
  private pidSeq = 0;
  /** Active in-process runs, keyed by synthetic pid. */
  private active = new Map<number, AbortController>();

  /**
   * Deps are resolved lazily at spawn() time: the orchestrator constructs
   * the spawner during init before some stores exist (e.g. the vault), and
   * per-run resolution keeps the spawner correct across hot-reloads.
   */
  constructor(private getDeps: () => InProcessSpawnerDeps) {}

  async spawn(config: RunnerConfig): Promise<SpawnResult> {
    const deps = this.getDeps();

    // Parity with NodeSpawner for local execution. When a host injects a
    // remote filesystem (for example a sandbox proxy), config.outputDir is a
    // path in that filesystem and must never be touched through node:fs. The
    // file-producing tools create parent directories through the injected FS
    // on first use, preserving lazy sandbox acquisition for tool-free runs.
    if (!deps.fs && !existsSync(config.outputDir)) {
      mkdirSync(config.outputDir, { recursive: true });
    }

    const pid = --this.pidSeq;
    const abort = new AbortController();
    this.active.set(pid, abort);

    // Nothing is written to disk — the config only lives on the run record
    // (TaskRunner persists it right after spawn, as with every spawner).
    const configPath = `memory://run-${config.runId}`;
    let exited = false;
    const exitCallbacks: Array<() => void> = [];

    // Fire-and-forget: spawn() returns immediately, like a fork would.
    void executeRun(config, { ...deps, pid, configPath, signal: abort.signal })
      .catch(async (err) => {
        // executeRun persists every run-level failure itself; this is the
        // last resort (e.g. the initial upsertRun threw). Never let a run
        // error escape into the orchestrator process.
        try {
          await deps.runStore.completeRun(config.runId, "failed", errorResult(err));
        } catch { /* store is gone too — health checks will reap the run */ }
      })
      .finally(() => {
        exited = true;
        this.active.delete(pid);
        for (const cb of exitCallbacks.splice(0)) cb();
      });

    return {
      pid,
      configPath,
      onExit: (cb: () => void) => {
        if (exited) cb();
        else exitCallbacks.push(cb);
      },
    };
  }

  isAlive(pid: number): boolean {
    return this.active.has(pid);
  }

  kill(pid: number): void {
    this.active.get(pid)?.abort();
  }
}
