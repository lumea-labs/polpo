/**
 * In-memory RunStore for chat-via-executeRun runs (migration F1c).
 *
 * A chat completion is ephemeral: its durable state lives in sessions/messages,
 * not in the task `runs` table. This store keeps `executeRun`'s bookkeeping
 * (upsert/activity/outcomes/resume/complete) entirely in memory for the life of
 * the request, so chat runs never touch the project's task run store or disk.
 */
import type { RunStore, RunRecord, RunStatus } from "@polpo-ai/core/run-store";
import type { AgentActivity, TaskResult, TaskOutcome } from "@polpo-ai/core/types";
import type { LoopResumeState } from "@polpo-ai/core/loop-run-store";
import type { LoopTraceEvent } from "@polpo-ai/core";

export class EphemeralRunStore implements RunStore {
  private readonly runs = new Map<string, RunRecord>();

  async upsertRun(run: RunRecord): Promise<void> {
    const existing = this.runs.get(run.id);
    this.runs.set(run.id, existing ? {
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
    } : { ...run });
  }

  async updateActivity(runId: string, activity: AgentActivity): Promise<void> {
    const run = this.runs.get(runId);
    if (run) run.activity = activity;
  }

  async updateOutcomes(runId: string, outcomes: TaskOutcome[]): Promise<void> {
    const run = this.runs.get(runId);
    if (run) run.outcomes = outcomes;
  }

  async updateResumeState(runId: string, state: LoopResumeState): Promise<void> {
    const run = this.runs.get(runId);
    if (run) run.resumeState = state;
  }

  async updateSpawnInfo(runId: string, pid: number, configPath: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    run.pid = pid;
    run.configPath = configPath;
    run.updatedAt = new Date().toISOString();
  }

  async completeRun(runId: string, status: RunStatus, result: TaskResult): Promise<void> {
    const run = this.runs.get(runId);
    if (run) {
      run.status = status;
      run.result = result;
      run.updatedAt = new Date().toISOString();
      run.completedAt = run.updatedAt;
    }
  }

  async markRunCollected(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    run.collectedAt = new Date().toISOString();
    run.updatedAt = run.collectedAt;
  }

  async appendTrace(runId: string, event: LoopTraceEvent): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    if (run.trace?.some((candidate) => candidate.id === event.id)) return;
    run.trace = [...(run.trace ?? []), event];
    run.updatedAt = new Date().toISOString();
  }

  async getRun(runId: string): Promise<RunRecord | undefined> {
    return this.runs.get(runId);
  }

  async getRunByTaskId(taskId: string): Promise<RunRecord | undefined> {
    return [...this.runs.values()]
      .filter((run) => run.taskId === taskId)
      .sort((a, b) =>
        Number(Boolean(a.collectedAt)) - Number(Boolean(b.collectedAt)) ||
        b.startedAt.localeCompare(a.startedAt) ||
        b.updatedAt.localeCompare(a.updatedAt)
      )[0];
  }

  async getRunsBySessionId(sessionId: string, limit = 100): Promise<RunRecord[]> {
    const safeLimit = Math.max(1, Math.min(Math.trunc(limit) || 100, 500));
    return [...this.runs.values()]
      .filter((run) => run.sessionId === sessionId)
      .sort((a, b) =>
        b.startedAt.localeCompare(a.startedAt) ||
        b.updatedAt.localeCompare(a.updatedAt)
      )
      .slice(0, safeLimit);
  }

  async getActiveRuns(): Promise<RunRecord[]> {
    return [...this.runs.values()].filter((r) =>
      r.status === "running" && r.engine !== "graph" && r.delivery !== "stream"
    );
  }

  async getTerminalRuns(): Promise<RunRecord[]> {
    return [...this.runs.values()].filter((r) =>
      r.status !== "running" && !r.collectedAt && r.engine !== "graph" && r.delivery !== "stream"
    );
  }

  async deleteRun(runId: string): Promise<void> {
    this.runs.delete(runId);
  }

  close(): void {
    this.runs.clear();
  }
}
