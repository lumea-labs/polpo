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

export class EphemeralRunStore implements RunStore {
  private readonly runs = new Map<string, RunRecord>();

  async upsertRun(run: RunRecord): Promise<void> {
    this.runs.set(run.id, { ...run });
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

  async completeRun(runId: string, status: RunStatus, result: TaskResult): Promise<void> {
    const run = this.runs.get(runId);
    if (run) {
      run.status = status;
      run.result = result;
      run.updatedAt = new Date().toISOString();
    }
  }

  async getRun(runId: string): Promise<RunRecord | undefined> {
    return this.runs.get(runId);
  }

  async getRunByTaskId(taskId: string): Promise<RunRecord | undefined> {
    for (const run of this.runs.values()) if (run.taskId === taskId) return run;
    return undefined;
  }

  async getActiveRuns(): Promise<RunRecord[]> {
    return [...this.runs.values()].filter((r) => r.status === "running");
  }

  async getTerminalRuns(): Promise<RunRecord[]> {
    return [...this.runs.values()].filter((r) => r.status !== "running");
  }

  async deleteRun(runId: string): Promise<void> {
    this.runs.delete(runId);
  }

  close(): void {
    this.runs.clear();
  }
}
