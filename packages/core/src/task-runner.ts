import { nanoid } from "nanoid";
import type { OrchestratorContext } from "./orchestrator-context.js";
import { resolveMissionStore, resolveMissionForTask } from "./mission-store.js";
import type { Task, TaskResult, RunnerConfig } from "./types.js";
import { agentMemoryScope } from "./memory-store.js";
import { resolveExecutionMode } from "./execution-mode.js";
import { resolveRuntimeSandboxOptions } from "./runtime-sandbox.js";
import type { RunRecord } from "./run-store.js";
import type { LoopResumeState } from "./loop/run-store.js";
import { resolveConfiguredModelSelection } from "./model-profiles.js";
import { normalizeModelPolicy } from "./model-policy.js";
import {
  createRuntimePromptContextSegment,
  resolveRuntimeContext,
  type RuntimeContextResolution,
  type RuntimePromptContextSegment,
} from "./runtime-context/index.js";
import {
  createExecutionRouteResolvedEvent,
  resolveTaskExecutionRoute,
  type ResolvedExecutionRoute,
} from "./execution-router.js";

/**
 * Durable turns: max age of a resume checkpoint before orphan recovery
 * ignores it and falls back to retry-from-zero. Crash/deploy restarts are
 * a matter of minutes; beyond this window the sandbox/workdir state the
 * conversation refers to can no longer be trusted.
 */
export const RESUME_CHECKPOINT_MAX_AGE_MS = 60 * 60 * 1000;

/** A checkpoint is resumable, and fresh enough to trust, when it is either:
 *   - a session checkpoint: a completed turn (`turn`) with non-empty history, or
 *   - a pipeline checkpoint: a named pipeline (`pipelineName`) recording the
 *     step position — an in-flight agent step additionally carries turn/history.
 *  The completions human-gate format (no `pipelineName`, no `turn`) is neither
 *  and is deliberately not harvested. */
function usableCheckpoint(state: LoopResumeState | undefined): LoopResumeState | undefined {
  if (!state) return undefined;
  const hasSession =
    typeof state.turn === "number" && state.turn >= 0 &&
    Array.isArray(state.history) && state.history.length > 0;
  const hasPipeline = typeof state.pipelineName === "string" && state.pipelineName.length > 0;
  if (!hasSession && !hasPipeline) return undefined;
  const stamp = state.updatedAt ?? state.createdAt;
  const age = Date.now() - new Date(stamp).getTime();
  if (!Number.isFinite(age) || age > RESUME_CHECKPOINT_MAX_AGE_MS) return undefined;
  return state;
}

// ── Pure path helpers (no node:path dependency) ─────────────────────────

/** Join path segments with '/'. */
function pathJoin(...parts: string[]): string {
  return parts
    .map((p, i) => (i === 0 ? p.replace(/\/+$/, "") : p.replace(/^\/+|\/+$/g, "")))
    .filter(Boolean)
    .join("/");
}

/** Return the directory portion of a path. */
function pathDirname(p: string): string {
  const idx = p.lastIndexOf("/");
  if (idx <= 0) return idx === 0 ? "/" : ".";
  return p.slice(0, idx);
}

/**
 * Spawns, monitors, and collects results from agent runner subprocesses.
 */
export class TaskRunner {
  private staleWarned = new Set<string>();
  /** Last known activity snapshot per taskId, used to diff and emit SSE events */
  private lastActivity = new Map<string, string>();
  /** Tracks files already seen per task to emit incremental file:changed events */
  private knownFiles = new Map<string, Set<string>>();
  /**
   * Durable turns: checkpoints harvested from dead runs during orphan
   * recovery, consumed (one-shot) by the next spawn of the same task so it
   * resumes at turn + 1 instead of retrying from zero. Recovery and the
   * respawning tick happen in the same orchestrator process, so in-memory
   * handoff is sufficient — the durable copy lives on the run record.
   */
  private pendingResume = new Map<string, LoopResumeState>();

  constructor(private ctx: OrchestratorContext) {}

  private async resolveTaskExecutionRoute(
    task: Task,
    agent: RunnerConfig["agent"],
  ): Promise<ResolvedExecutionRoute | undefined> {
    const route = await resolveTaskExecutionRoute({ task, agent }, {
      getProjectLoop: this.ctx.getProjectLoop,
      resolveClassifier: this.ctx.resolveExecutionRouteClassifier,
    });
    if (!route) return undefined;
    this.ctx.emitter.emit(
      "runtime:execution-route",
      createExecutionRouteResolvedEvent(route),
    );
    return route;
  }

  /**
   * Collect results from terminal runs and pass them to the callback.
   * The callback is typically the assessment pipeline (handleResult).
   */
  async collectResults(
    onResult: (taskId: string, result: TaskResult) => Promise<void> | void,
  ): Promise<void> {
    const terminalRuns = await this.ctx.runStore.getTerminalRuns();
    for (const run of terminalRuns) {
      // Persist sessionId on the task before acknowledging the run.
      const sid = run.sessionId ?? run.activity.sessionId;
      if (sid) {
        try { await this.ctx.taskStore.updateTask(run.taskId, { sessionId: sid }); } catch { /* task may already be gone */ }
      }
      // Persist auto-collected outcomes on the task.
      // REPLACE (not append) — each execution produces its own definitive outcomes.
      // Appending caused "exponential outcome" accumulation across retries/fix cycles.
      if (run.outcomes && run.outcomes.length > 0) {
        try {
          await this.ctx.taskStore.updateTask(run.taskId, { outcomes: run.outcomes });
        } catch { /* task may already be gone */ }
      }
      const result = run.result ?? {
        exitCode: 1,
        stdout: "",
        stderr: `Run ${run.id} ended with status ${run.status} without a result`,
        duration: Math.max(0, Date.now() - new Date(run.startedAt).getTime()),
      };
      {
        // A killed run must never be treated as successful — force exitCode=1
        // even if the adapter resolved cleanly before the kill took effect.
        if (run.status === "killed" && result.exitCode === 0) {
          result.exitCode = 1;
          result.stderr = (result.stderr ? result.stderr + "\n" : "") + "Run was killed (timeout or shutdown)";
        }
        // For killed runs, build a diagnosis from the activity log so the retry
        // prompt tells the agent exactly what went wrong (e.g. "you got stuck
        // running `python3 server.py &` for 120s").
        if (run.status === "killed") {
          const diagnosis = this.buildTimeoutDiagnosis(run);
          if (diagnosis) {
            result.stderr = (result.stderr ? result.stderr + "\n" : "") + diagnosis;
          }
        }
        await onResult(run.taskId, result);
      }
      // Keep terminal Runs as durable history. Older/custom stores can keep
      // their previous consume-and-delete behavior until they implement ack.
      if (this.ctx.runStore.markRunCollected) {
        await this.ctx.runStore.markRunCollected(run.id);
      } else {
        await this.ctx.runStore.deleteRun(run.id);
      }
      this.staleWarned.delete(run.taskId);
    }
  }

  /**
   * Read the JSONL activity log for a killed run and produce a human-readable
   * diagnosis of what the agent was doing when it timed out.
   * This gets appended to stderr so buildRetryPrompt includes it automatically.
   */
  private buildTimeoutDiagnosis(run: RunRecord): string | null {
    try {
      // Use the context port to read log content (shell provides the implementation)
      const content = this.ctx.readRunLog?.(run.id);
      if (!content) return null;

      const lines = content.trim().split("\n");
      // Parse last N entries (skip header)
      const entries: Array<Record<string, unknown>> = [];
      for (const line of lines) {
        try { entries.push(JSON.parse(line)); } catch { /* skip malformed */ }
      }
      if (entries.length === 0) return null;

      // Gather stats
      const toolUses = entries.filter(e => e.type === "tool_use");
      const toolResults = entries.filter(e => e.type === "tool_result");
      const assistantMsgs = entries.filter(e => e.type === "assistant");
      const activitySnaps = entries.filter(e => e.event === "activity");

      // Find the last tool_use (likely the one that blocked)
      const lastToolUse = toolUses[toolUses.length - 1];
      const lastToolResult = toolResults[toolResults.length - 1];

      // Check if last tool_use has no matching result (= it was the blocking call)
      const lastToolId = lastToolUse?.toolId as string | undefined;
      const lastResultId = lastToolResult?.toolId as string | undefined;
      const wasBlocking = lastToolId && lastToolId !== lastResultId;

      // Get activity stats from last snapshot
      const lastSnap = activitySnaps[activitySnaps.length - 1];
      const snapData = lastSnap?.data as Record<string, unknown> | undefined;

      const parts = [
        ``,
        `TIMEOUT DIAGNOSIS:`,
        `- Total tool calls attempted: ${toolUses.length}`,
        `- Total tool results received: ${toolResults.length}`,
        `- Files created: ${(snapData?.filesCreated as string[] | undefined)?.length ?? 0}`,
        `- Files edited: ${(snapData?.filesEdited as string[] | undefined)?.length ?? 0}`,
      ];

      if (wasBlocking && lastToolUse) {
        const tool = lastToolUse.tool as string;
        const input = lastToolUse.input as Record<string, unknown> | undefined;
        parts.push(
          ``,
          `BLOCKED ON: tool="${tool}"`,
        );
        if (tool === "bash" && input?.command) {
          const cmd = String(input.command);
          parts.push(
            `Command that hung: ${cmd.slice(0, 500)}`,
            ``,
            `DO NOT repeat this command. It blocks forever.`,
            `If you need to start a server, use: nohup <cmd> > /tmp/server.log 2>&1 & echo "PID=$!"`,
            `Then verify with a SEPARATE bash call: curl --max-time 5 http://127.0.0.1:<port>/`,
            `NEVER combine server start + verification in one command.`,
            `NEVER use lsof or netstat to check servers — use curl.`,
          );
        } else {
          parts.push(`Input: ${JSON.stringify(input ?? {}).slice(0, 500)}`);
        }
      } else {
        // Last tool completed — agent might have been in a loop or LLM was slow
        const lastAssistant = assistantMsgs[assistantMsgs.length - 1];
        if (lastAssistant?.text) {
          parts.push(`Last agent message: ${String(lastAssistant.text).slice(0, 300)}`);
        }
        if (lastToolUse) {
          parts.push(`Last completed tool: ${lastToolUse.tool}`);
        }
      }

      // List files created so agent knows what's already done
      const filesCreated = (snapData?.filesCreated as string[] | undefined) ?? [];
      const filesEdited = (snapData?.filesEdited as string[] | undefined) ?? [];
      if (filesCreated.length > 0 || filesEdited.length > 0) {
        parts.push(``, `WORK ALREADY DONE (do not redo):`);
        if (filesCreated.length > 0) parts.push(`Created: ${filesCreated.join(", ")}`);
        if (filesEdited.length > 0) parts.push(`Edited: ${filesEdited.join(", ")}`);
      }

      return parts.join("\n");
    } catch {
      return null;
    }
  }

  /**
   * Enforce task timeouts and detect stale agents via RunStore active runs.
   * - Hard kill at maxDuration (or default taskTimeout)
   * - Warn at staleThreshold, kill at 2x staleThreshold
   */
  async enforceHealthChecks(): Promise<void> {
    const defaultTimeout = this.ctx.config.settings.taskTimeout ?? 30 * 60 * 1000;
    const staleThreshold = this.ctx.config.settings.staleThreshold ?? 5 * 60 * 1000;

    const activeRuns = await this.ctx.runStore.getActiveRuns();
    for (const run of activeRuns) {
      // 1. Task timeout (hard kill)
      const task = await this.ctx.taskStore.getTask(run.taskId);
      const timeout = task?.maxDuration ?? defaultTimeout;
      if (timeout > 0) {
        const elapsed = Date.now() - new Date(run.startedAt).getTime();
        if (elapsed > timeout) {
          this.ctx.emitter.emit("log", { level: "warn", message: `[${run.taskId}] Timed out (${Math.round(elapsed / 1000)}s)` });
          this.ctx.emitter.emit("task:timeout", { taskId: run.taskId, elapsed, timeout });
          // pid 0 = untracked (sandbox spawners); positive = OS subprocess;
          // negative = in-process synthetic pid — both of the latter are
          // killable through the spawner that issued them.
          if (run.pid !== 0) {
            try { this.ctx.spawner.kill(run.pid); } catch { /* already dead */ }
          }
          // Mark run as killed so we don't retry every tick
          await this.ctx.runStore.completeRun(run.id, "killed", {
            exitCode: 1, stdout: "", stderr: `Timed out after ${Math.round(elapsed / 1000)}s`, duration: elapsed,
          });
          this.staleWarned.delete(run.taskId);
          continue;
        }
      }

      // 2. Stale detection (warning at 1x, kill at 2x)
      if (staleThreshold > 0 && run.activity.lastUpdate) {
        const idle = Date.now() - new Date(run.activity.lastUpdate).getTime();

        if (idle > staleThreshold * 2) {
          this.ctx.emitter.emit("log", { level: "error", message: `[${run.taskId}] Agent unresponsive for ${Math.round(idle / 1000)}s — killing` });
          this.ctx.emitter.emit("agent:stale", { taskId: run.taskId, agentName: run.agentName, idleMs: idle, action: "killed" });
          // Same pid convention as the timeout branch above (0 = untracked).
          if (run.pid !== 0) {
            try { this.ctx.spawner.kill(run.pid); } catch { /* already dead */ }
          }
          // Mark run as killed so we don't retry every tick
          await this.ctx.runStore.completeRun(run.id, "killed", {
            exitCode: 1, stdout: "", stderr: `Agent unresponsive for ${Math.round(idle / 1000)}s`, duration: idle,
          });
          this.staleWarned.delete(run.taskId);
        } else if (idle > staleThreshold && !this.staleWarned.has(run.taskId)) {
          this.ctx.emitter.emit("agent:stale", { taskId: run.taskId, agentName: run.agentName, idleMs: idle, action: "warning" });
          this.ctx.emitter.emit("log", { level: "warn", message: `[${run.taskId}] Agent idle for ${Math.round(idle / 1000)}s — may be stuck` });
          this.staleWarned.add(run.taskId);
        }
      }
    }
  }

  /** Sync process list from RunStore into the old processes table for backward compat.
   *  Also emits `agent:activity` SSE events when activity changes (diff-based). */
  async syncProcessesFromRunStore(): Promise<void> {
    const active = await this.ctx.runStore.getActiveRuns();

    // Emit agent:activity for each run whose activity snapshot changed
    const seenTaskIds = new Set<string>();
    for (const r of active) {
      seenTaskIds.add(r.taskId);
      const snapshot = JSON.stringify(r.activity);
      const prev = this.lastActivity.get(r.taskId);
      if (prev !== snapshot) {
        this.lastActivity.set(r.taskId, snapshot);
        this.ctx.emitter.emit("agent:activity", {
          taskId: r.taskId,
          agentName: r.agentName,
          tool: r.activity.lastTool,
          file: r.activity.lastFile,
          summary: r.activity.summary,
        });

        // Emit file:changed for newly created/edited files
        let known = this.knownFiles.get(r.taskId);
        if (!known) { known = new Set(); this.knownFiles.set(r.taskId, known); }
        for (const f of r.activity.filesCreated ?? []) {
          if (!known.has(f)) {
            known.add(f);
            this.ctx.emitter.emit("file:changed", { path: f, dir: pathDirname(f), action: "created", source: "agent" });
          }
        }
        for (const f of r.activity.filesEdited ?? []) {
          if (!known.has(f)) {
            known.add(f);
            this.ctx.emitter.emit("file:changed", { path: f, dir: pathDirname(f), action: "modified", source: "agent" });
          }
        }
      }
    }

    // Cleanup stale entries for tasks no longer active
    for (const taskId of this.lastActivity.keys()) {
      if (!seenTaskIds.has(taskId)) {
        this.lastActivity.delete(taskId);
        this.knownFiles.delete(taskId);
      }
    }

    await this.ctx.taskStore.setState({
      processes: active.map(r => ({
        agentName: r.agentName,
        pid: r.pid,
        taskId: r.taskId,
        startedAt: r.startedAt,
        alive: true,
        activity: r.activity,
      })),
    });
  }

  /**
   * Recover tasks left in limbo from a previous crash.
   * Resets orphaned tasks to pending WITHOUT burning retry count.
   */
  async recoverOrphanedTasks(): Promise<number> {
    // Check RunStore active runs first
    const activeRuns = await this.ctx.runStore.getActiveRuns();
    for (const run of activeRuns) {
      if (this.isProcessAlive(run.pid)) {
        // Runner still alive — leave it running, work is NOT lost!
        this.ctx.emitter.emit("log", { level: "info", message: `Runner PID ${run.pid} still alive for task ${run.taskId} — reconnecting` });
      } else {
        // Runner died — harvest its durable-turns checkpoint (if fresh)
        // so the respawn resumes at turn + 1 instead of starting over.
        const checkpoint = usableCheckpoint(run.resumeState);
        if (checkpoint) {
          this.pendingResume.set(run.taskId, checkpoint);
          this.ctx.emitter.emit("log", {
            level: "info",
            message: `[${run.taskId}] Runner died mid-run — checkpoint at turn ${checkpoint.turn! + 1} saved for resume`,
          });
        }
        // A crash/deploy interruption is not a task failure. Keep the Run for
        // diagnostics but acknowledge it so restart recovery does not burn a
        // retry by collecting it as a normal execution result.
        await this.ctx.runStore.completeRun(run.id, "failed", {
          exitCode: 1, stdout: "", stderr: "Runner process died", duration: 0,
        });
        if (this.ctx.runStore.markRunCollected) {
          await this.ctx.runStore.markRunCollected(run.id);
        } else {
          await this.ctx.runStore.deleteRun(run.id);
        }
      }
    }

    // Backward compat: kill orphan OS processes from old processes table
    const state = await this.ctx.taskStore.getState();
    for (const proc of state.processes) {
      if (proc.pid > 0 && proc.alive) {
        this.killOrphanProcess(proc.pid, proc.agentName);
      }
    }

    const tasks = await this.ctx.taskStore.listTasks();
    const orphanStates: Set<string> = new Set(["assigned", "in_progress", "review"]);
    let recovered = 0;

    for (const task of tasks) {
      if (!orphanStates.has(task.status)) continue;

      // Check if there's a live runner for this task
      const run = await this.ctx.runStore.getRunByTaskId(task.id);
      if (run && run.status === "running" && this.isProcessAlive(run.pid)) {
        // Runner still working — skip recovery for this task
        continue;
      }

      // Recover: reset to pending WITHOUT incrementing retries.
      // Shutdown interrupts are not real failures — unsafeSetStatus bypasses
      // transition(failed → pending) which would burn a retry.
      this.ctx.emitter.emit("task:recovered", { taskId: task.id, title: task.title, previousStatus: task.status });
      await this.ctx.taskStore.unsafeSetStatus(task.id, "pending", "orphan recovery — shutdown interrupt");
      recovered++;
    }

    // Clear stale process list
    if (recovered > 0 || tasks.some(t => orphanStates.has(t.status))) {
      await this.ctx.taskStore.setState({ processes: [] });
    }

    // Drop harvested checkpoints whose task did NOT end up pending (task
    // already done/failed, or still owned by a live runner) — a leaked
    // entry would wrongly resume a future, unrelated execution.
    for (const taskId of [...this.pendingResume.keys()]) {
      const task = await this.ctx.taskStore.getTask(taskId);
      if (!task || task.status !== "pending") this.pendingResume.delete(taskId);
    }

    return recovered;
  }

  isProcessAlive(pid: number): boolean {
    return this.ctx.spawner.isAlive(pid);
  }

  /** Persist failures that happen before a host process/sandbox can start. */
  private async failBeforeSpawn(task: Task, message: string): Promise<void> {
    await this.ctx.taskStore.transition(task.id, "assigned");
    await this.ctx.taskStore.transition(task.id, "in_progress");
    await this.ctx.taskStore.updateTask(task.id, { phase: "execution" });

    const runId = nanoid();
    const now = new Date().toISOString();
    await this.ctx.runStore.upsertRun({
      id: runId,
      taskId: task.id,
      pid: 0,
      agentName: task.assignTo,
      status: "running",
      startedAt: now,
      updatedAt: now,
      activity: {
        filesCreated: [], filesEdited: [], toolCalls: 0, totalTokens: 0, lastUpdate: now,
      },
      configPath: `preflight://${runId}`,
      user: task.user,
      engine: "agent",
      delivery: "background",
    });
    await this.ctx.runStore.completeRun(runId, "failed", {
      exitCode: 1,
      stdout: "",
      stderr: message,
      duration: 0,
    });
  }

  async spawnForTask(task: Task): Promise<void> {
    const agent = await this.ctx.agentStore.getAgent(task.assignTo);
    if (!agent) {
      const message = `No agent "${task.assignTo}" for task "${task.title}"`;
      this.ctx.emitter.emit("log", { level: "error", message });
      await this.failBeforeSpawn(task, message);
      return;
    }

    // Fail fast if the agent's model provider has no API key
    if (agent.model && this.ctx.validateProviderKeys) {
      const resolved = resolveConfiguredModelSelection(
        agent.model,
        this.ctx.config.settings,
        agent.allowedModelProfiles,
      );
      const missing = this.ctx.validateProviderKeys([...resolved.policy.candidates]);
      if (missing.length > 0) {
        const detail = missing.map(m => `${m.provider} (${m.modelSpec})`).join(", ");
        this.ctx.emitter.emit("log", {
          level: "error",
          message: `[${task.id}] Missing API key for ${detail} — cannot spawn agent "${agent.name}"`,
        });
        await this.failBeforeSpawn(task, `Missing API key for ${detail}`);
        return;
      }
    }

    // Run before:task:spawn hook (sync — tick loop is synchronous)
    const hookResult = this.ctx.hooks.runBeforeSync("task:spawn", { task, agent });
    if (hookResult.cancelled) {
      this.ctx.emitter.emit("log", {
        level: "info",
        message: `[${task.id}] Spawn blocked by hook: ${hookResult.cancelReason ?? "no reason"}`,
      });
      return;  // task stays pending — will be re-evaluated next tick
    }

    await this.ctx.taskStore.transition(task.id, "assigned");
    await this.ctx.taskStore.transition(task.id, "in_progress");

    // Set phase if not already set (new tasks start in execution phase)
    if (!task.phase) {
      await this.ctx.taskStore.updateTask(task.id, { phase: "execution" });
    }

    const runId = nanoid();

    // Create per-task output directory for deliverables
    const outputDir = pathJoin(this.ctx.polpoDir, "output", task.id);

    // Establish the durable Run before memory, mission context, storage or
    // sandbox preparation. Any subsequent failure is therefore inspectable.
    const startedAt = new Date().toISOString();
    const initialRun: RunRecord = {
      id: runId,
      taskId: task.id,
      pid: 0,
      agentName: agent.name,
      status: "running",
      startedAt,
      updatedAt: startedAt,
      activity: {
        filesCreated: [], filesEdited: [], toolCalls: 0, totalTokens: 0, lastUpdate: startedAt,
      },
      configPath: `pending://${runId}`,
      user: task.user,
      engine: "agent",
      delivery: "background",
    };
    await this.ctx.runStore.upsertRun(initialRun);

    try {
      let runtimeContext: RuntimeContextResolution | undefined;
      try {
        runtimeContext = await resolveRuntimeContext(this.ctx.runtimeContext, {
          agentName: agent.name,
          query: `${task.title}\n\n${task.description}`,
          surface: "task",
          source: "task",
          ...(task.user ? { externalUserId: task.user } : {}),
          runId,
        });
      } catch {
        throw new Error("Runtime context retrieval failed");
      }
      const executionRoute = await this.resolveTaskExecutionRoute(task, agent);

      const contextTrust = this.ctx.config.settings.contextTrust === "enforce"
        ? "enforce"
        : "off";
      // Build both representations during the opt-in window. Enforced runs keep
      // metadata structural; disabled runs preserve the historical task prompt.
      const promptContextSegments: RuntimePromptContextSegment[] = [];
      const legacyContextParts: string[] = [];
      const taskWithContext = {
        ...task,
        ...(executionRoute?.mode === "loop"
          ? { loop: executionRoute.loop }
          : {}),
      };

    // 1. Shared memory (persistent cross-session knowledge, visible to all agents)
    const sharedMemory = (await this.ctx.memoryStore?.get()) ?? "";
    if (sharedMemory) {
      legacyContextParts.push(`<shared-memory>\n${sharedMemory}\n</shared-memory>`);
      if (contextTrust === "enforce") {
        promptContextSegments.push(createRuntimePromptContextSegment({
          kind: "memory.shared",
          sourceId: "project",
          trust: "untrusted",
          content: sharedMemory,
        }));
      }
    }

    // 1b. Agent-specific memory (private knowledge for the assigned agent)
    if (task.assignTo) {
      const agentMem = (await this.ctx.memoryStore?.get(agentMemoryScope(task.assignTo))) ?? "";
      if (agentMem) {
        legacyContextParts.push(`<agent-memory agent="${task.assignTo}">\n${agentMem}\n</agent-memory>`);
        if (contextTrust === "enforce") {
          promptContextSegments.push(createRuntimePromptContextSegment({
            kind: "memory.agent",
            sourceId: task.assignTo,
            trust: "untrusted",
            content: agentMem,
          }));
        }
      }
    }

    // 2. Mission context — if this task belongs to a mission, include the mission goal and sibling tasks
    if (task.group) {
      try {
        // Resolve mission via direct ID (preferred) or group name (legacy fallback)
        const mission = await resolveMissionForTask(resolveMissionStore(this.ctx), task);
        const legacyMissionParts: string[] = [];
        // Original user prompt that generated this mission (the "why")
        if (mission?.prompt) {
          legacyMissionParts.push(`Mission goal: ${mission.prompt}`);
          if (contextTrust === "enforce") {
            promptContextSegments.push(createRuntimePromptContextSegment({
              kind: "mission.goal",
              sourceId: mission.id,
              trust: "user",
              content: mission.prompt,
            }));
          }
        }

        // Sibling tasks — just titles and statuses for awareness, not full descriptions
        const allTasks = await this.ctx.taskStore.listTasks();
        const siblings = allTasks.filter(t => t.group === task.group && t.id !== task.id);
        if (siblings.length > 0) {
          const missionParts = [`Other tasks in this mission:`];
          for (const s of siblings) {
            const marker = s.status === "done" ? "[done]"
              : s.status === "in_progress" ? "[in progress]"
              : s.status === "failed" ? "[failed]"
              : "[pending]";
            missionParts.push(`  ${marker} "${s.title}" → ${s.assignTo}`);
          }
          legacyMissionParts.push(...missionParts);
          if (contextTrust === "enforce") {
            promptContextSegments.push(createRuntimePromptContextSegment({
              kind: "mission.status",
              sourceId: mission?.id ?? task.group,
              trust: "untrusted",
              content: missionParts.join("\n"),
            }));
          }
        }
        if (legacyMissionParts.length > 0) {
          legacyContextParts.push(`<mission-context>\n${legacyMissionParts.join("\n")}\n</mission-context>`);
        }
      } catch { /* best effort — mission may have been deleted */ }
    }

    const taskForRun = contextTrust === "enforce" || legacyContextParts.length === 0
      ? taskWithContext
      : {
          ...taskWithContext,
          description: `${legacyContextParts.join("\n\n")}\n\n${task.description}`,
        };

    // Durable turns: consume (one-shot) a checkpoint harvested by orphan
    // recovery — the runner resumes the conversation at turn + 1 instead
    // of redoing completed work. Absent checkpoint = spawn from zero.
    const resumeState = this.pendingResume.get(task.id);
    if (resumeState) {
      this.pendingResume.delete(task.id);
      const from = resumeState.pipelineName
        ? `pipeline "${resumeState.pipelineName}" (${resumeState.steps?.length ?? 0} steps left)`
        : `turn ${(resumeState.turn ?? -1) + 1}`;
      this.ctx.emitter.emit("log", {
        level: "info",
        message: `[${task.id}] Resuming from checkpoint (${from}) instead of retrying from zero`,
      });
    }

    // Adaptive isolation: resolve WHERE this run executes (task > agent > settings)
    const executionMode = resolveExecutionMode(task, agent, this.ctx.config.settings);
    const sandbox = resolveRuntimeSandboxOptions(this.ctx.config.settings, agent, task);

    const runnerConfig: RunnerConfig = {
      runId,
      taskId: task.id,
      executionMode,
      sandbox,
      ...(contextTrust === "enforce"
        ? { contextTrust, promptContextSegments }
        : {}),
      guardrails: this.ctx.config.settings.guardrails,
      runtimeContext,
      executionRoute,
      agent,
      task: taskForRun,
      polpoDir: this.ctx.polpoDir,
      cwd: this.ctx.agentWorkDir,
      outputDir,
      storage: this.ctx.config.settings.storage,
      databaseUrl: this.ctx.config.settings.databaseUrl,
      notifySocket: this.ctx.notifySocketPath,
      emailAllowedDomains: agent.emailAllowedDomains ?? this.ctx.config.settings.emailAllowedDomains,
      reasoning: this.ctx.config.settings.reasoning,
      modelProfiles: this.ctx.config.settings.modelProfiles,
      modelAllowlist: this.ctx.config.settings.modelAllowlist,
      providers: this.ctx.config.providers,
      resumeState,
    };

      // Persist the complete input before handing control to the host. This is
      // also the recovery/debug snapshot when host acquisition fails.
      await this.ctx.runStore.upsertRun({
        ...initialRun,
        executionMode,
        config: runnerConfig,
        updatedAt: new Date().toISOString(),
      });

      const spawnResult = await this.ctx.spawner.spawn(runnerConfig);

      // Never upsert the whole record here: an in-process runner can complete
      // before spawn() returns. Updating only spawn metadata cannot resurrect
      // that terminal Run back to "running".
      if (this.ctx.runStore.updateSpawnInfo) {
        await this.ctx.runStore.updateSpawnInfo(runId, spawnResult.pid, spawnResult.configPath);
      } else {
        const current = await this.ctx.runStore.getRun(runId);
        if (current?.status === "running") {
          await this.ctx.runStore.upsertRun({
            ...current,
            pid: spawnResult.pid,
            configPath: spawnResult.configPath,
            updatedAt: new Date().toISOString(),
          });
        }
      }

      // Wake the supervisor as soon as the runner process exits so results
      // are collected immediately (poll interval remains the safety net for
      // spawners that don't track process lifecycle).
      spawnResult.onExit?.(() => {
        this.ctx.emitter.emit("run:exited", { taskId: task.id, runId, pid: spawnResult.pid });
      });

      this.ctx.emitter.emit("agent:spawned", {
        taskId: task.id,
        agentName: agent.name,
        taskTitle: task.title,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.ctx.emitter.emit("log", { level: "error", message: `[${task.id}] Failed to spawn runner: ${message}` });
      await this.ctx.runStore.completeRun(runId, "failed", {
        exitCode: 1,
        stdout: "",
        stderr: `Failed to prepare or spawn runner: ${message}`,
        duration: Math.max(0, Date.now() - new Date(startedAt).getTime()),
      });
    }
  }

  private killOrphanProcess(pid: number, agentName: string): void {
    if (!this.ctx.spawner.isAlive(pid)) return;
    this.ctx.emitter.emit("log", { level: "warn", message: `Killing orphan process PID ${pid} (${agentName})` });
    this.ctx.spawner.kill(pid);
  }
}
