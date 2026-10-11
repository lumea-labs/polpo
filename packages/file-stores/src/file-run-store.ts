import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { withProjectFileTransaction, type ProjectFileTransaction } from "./project-file-transaction.js";
import type { AgentActivity, TaskResult, TaskOutcome } from "@polpo-ai/core/types";
import type { RunStore, RunRecord, RunStatus } from "@polpo-ai/core/run-store";
import type { LoopResumeState } from "@polpo-ai/core/loop-run-store";
import type { LoopTraceEvent } from "@polpo-ai/core";

/** Run JSON files participate in the project coordinator: the orchestrator,
 * runner and cancellation controller can all write the same record. Every
 * read/modify/write must hold the cross-process lock, including activity/trace
 * updates, so none can restore a stale running state after cancellation. */
export class FileRunStore implements RunStore {
  constructor(private readonly polpoDir: string) {
    mkdirSync(join(polpoDir, "runs"), { recursive: true });
  }

  private transaction<T>(work: (tx: ProjectFileTransaction) => T): T {
    return withProjectFileTransaction(this.polpoDir, work);
  }
  private runPath(id: string): string {
    if (typeof id !== "string" || !id || /[\\/\x00]/.test(id)) throw new Error("Invalid stored run identifier");
    return `runs/${id}.json`;
  }
  private readRun(tx: ProjectFileTransaction, id: string): RunRecord | undefined {
    const raw = tx.read(this.runPath(id));
    if (raw === null) return undefined;
    let run: RunRecord;
    try { run = JSON.parse(raw); } catch { throw new Error("Invalid stored run record"); }
    if (!run || run.id !== id || !["running", "completed", "failed", "killed"].includes(run.status)) {
      throw new Error("Invalid stored run record");
    }
    return run;
  }
  private writeRun(tx: ProjectFileTransaction, run: RunRecord): void {
    tx.write(this.runPath(run.id), JSON.stringify(run, null, 2));
  }
  private allRuns(tx: ProjectFileTransaction): RunRecord[] {
    return tx.list("runs").filter(name => name.endsWith(".json") && !name.endsWith(".tmp"))
      .map(name => this.readRun(tx, name.slice(0, -5))).filter((run): run is RunRecord => !!run);
  }

  async upsertRun(run: RunRecord): Promise<void> {
    return this.transaction(tx => {
      const existing = this.readRun(tx, run.id);
      if (existing && existing.status !== "running") return;
      this.writeRun(tx, existing ? {
        ...existing,
        ...run,
        config: run.config ?? existing.config,
        executionMode: run.executionMode ?? existing.executionMode,
        engine: run.engine ?? existing.engine,
        delivery: run.delivery ?? existing.delivery,
        trace: run.trace ?? existing.trace,
        resumeState: run.resumeState ?? existing.resumeState,
        completedAt: run.completedAt ?? existing.completedAt,
        collectedAt: run.collectedAt ?? existing.collectedAt,
      } : run);
    });
  }

  async updateActivity(runId: string, activity: AgentActivity): Promise<void> {
    return this.transaction(tx => {
      const run = this.readRun(tx, runId);
      if (!run) return;
      run.activity = activity;
      if (activity.sessionId) run.sessionId = activity.sessionId;
      run.updatedAt = new Date().toISOString();
      this.writeRun(tx, run);
    });
  }

  async updateOutcomes(runId: string, outcomes: TaskOutcome[]): Promise<void> {
    return this.transaction(tx => {
      const run = this.readRun(tx, runId);
      if (!run) return;
      run.outcomes = outcomes;
      run.updatedAt = new Date().toISOString();
      this.writeRun(tx, run);
    });
  }

  async updateResumeState(runId: string, state: LoopResumeState): Promise<void> {
    return this.transaction(tx => {
      const run = this.readRun(tx, runId);
      if (!run) return;
      run.resumeState = state;
      run.updatedAt = new Date().toISOString();
      this.writeRun(tx, run);
    });
  }

  async updateSpawnInfo(runId: string, pid: number, configPath: string): Promise<void> {
    return this.transaction(tx => {
      const run = this.readRun(tx, runId);
      if (!run) return;
      run.pid = pid;
      run.configPath = configPath;
      run.updatedAt = new Date().toISOString();
      this.writeRun(tx, run);
    });
  }

  async completeRun(runId: string, status: RunStatus, result: TaskResult): Promise<void> {
    return this.transaction(tx => {
      const run = this.readRun(tx, runId);
      if (!run) return;
      // Don't let a later write overwrite a run already in terminal state.
      // This prevents the runner process from clobbering the orchestrator's
      // "killed" status with a stale "completed" result (race condition).
      const terminal: RunStatus[] = ["completed", "failed", "killed"];
      if (terminal.includes(run.status)) return;
      run.status = status;
      run.result = result;
      run.updatedAt = new Date().toISOString();
      run.completedAt = run.updatedAt;
      this.writeRun(tx, run);
    });
  }

  async markRunCollected(runId: string): Promise<void> {
    return this.transaction(tx => {
      const run = this.readRun(tx, runId);
      if (!run) return;
      run.collectedAt = new Date().toISOString();
      run.updatedAt = run.collectedAt;
      this.writeRun(tx, run);
    });
  }

  async appendTrace(runId: string, event: LoopTraceEvent): Promise<void> {
    return this.transaction(tx => {
      const run = this.readRun(tx, runId);
      if (!run) return;
      if (run.trace?.some((candidate) => candidate.id === event.id)) return;
      run.trace = [...(run.trace ?? []), event];
      run.updatedAt = new Date().toISOString();
      this.writeRun(tx, run);
    });
  }

  async getRun(runId: string): Promise<RunRecord | undefined> {
    return this.transaction(tx => {
      return this.readRun(tx, runId);
    });
  }

  async getRunByTaskId(taskId: string): Promise<RunRecord | undefined> {
    return this.transaction(tx => {
      return this.allRuns(tx)
        .filter((run) => run.taskId === taskId)
        .sort((a, b) =>
          Number(Boolean(a.collectedAt)) - Number(Boolean(b.collectedAt)) ||
          b.startedAt.localeCompare(a.startedAt) ||
          b.updatedAt.localeCompare(a.updatedAt)
        )[0];
    });
  }

  async getRunsBySessionId(sessionId: string, limit = 100): Promise<RunRecord[]> {
    return this.transaction(tx => {
      const safeLimit = Math.max(1, Math.min(Math.trunc(limit) || 100, 500));
      return this.allRuns(tx)
        .filter((run) => run.sessionId === sessionId)
        .sort((a, b) =>
          b.startedAt.localeCompare(a.startedAt) ||
          b.updatedAt.localeCompare(a.updatedAt)
        )
        .slice(0, safeLimit);
    });
  }

  async getActiveRuns(): Promise<RunRecord[]> {
    return this.transaction(tx => this.allRuns(tx).filter(r =>
      r.status === "running" && r.engine !== "graph" && r.delivery !== "stream"
    ));
  }

  async getTerminalRuns(): Promise<RunRecord[]> {
    return this.transaction(tx => this.allRuns(tx).filter(r =>
      !r.collectedAt && r.engine !== "graph" && r.delivery !== "stream" &&
      (r.status === "completed" || r.status === "failed" || r.status === "killed")
    ));
  }

  async deleteRun(runId: string): Promise<void> {
    this.transaction(tx => tx.write(this.runPath(runId), null));
  }

  async close(): Promise<void> {
    // No-op for filesystem store
  }
}
