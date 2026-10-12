/**
 * Deadlock resolution: LLM-powered dependency unblocking.
 *
 * When a plan task fails and blocks downstream dependents, the resolver
 * analyzes the failure and decides whether blocked tasks can proceed
 * (absorb), whether the failed dep should be retried, or whether the
 * chain should be failed.
 */

import type { Task, ModelConfig } from "@polpo-ai/core/types";
import { resolveConfiguredModelSelection } from "@polpo-ai/core";
import type { Orchestrator } from "./orchestrator.js";
import type { DeadlockFacade, DeadlockResolverPort } from "@polpo-ai/core";
import { taskExecutionReference, taskDependencyPreconditions, TaskExecutionError,
  type TaskExecutionPrecondition, type TaskExecutionMutation } from "@polpo-ai/core/task-execution";
import { queryText, resolveModelSpec } from "@polpo-ai/llm";
import { withRetry } from "../llm/retry.js";

/** Inline query helper (replaces deleted query.ts) */
async function queryOrchestratorText(prompt: string, model: string | ModelConfig | undefined) {
  const spec = resolveModelSpec(model);
  return withRetry(async () => {
    const result = await queryText(prompt, spec);
    return { text: result.text, usage: result.usage, model: result.model };
  }, { maxRetries: 2 });
}

// ── Types ─────────────────────────────────────────────

export interface BlockageInfo {
  task: Task;            // the blocked task
  failedDeps: Task[];    // direct or root-cause deps with status "failed"
  missingDeps: string[]; // dep IDs that don't exist in the task list
  preconditions: TaskExecutionPrecondition[]; // graph captured before asynchronous analysis
}

export interface BlockageAnalysis {
  resolvable: BlockageInfo[];   // at least 1 failed dep → LLM can decide
  unresolvable: BlockageInfo[]; // ONLY missing deps → force-fail
}

interface ResolutionDecision {
  action: "absorb" | "retry" | "fail";
  reason: string;
  absorbedDescription?: string;
}

/** Resolution ownership belongs to one engine, never the whole Node process. */
export function createDeadlockResolver(): DeadlockResolverPort {
  let resolving = false;
  return {
    isResolving: () => resolving,
    analyzeBlockedTasks,
    resolveDeadlock: async (analysis, facade) => {
      if (resolving) return;
      resolving = true;
      try { await resolveDeadlock(analysis as BlockageAnalysis, facade); }
      finally { resolving = false; }
    },
  };
}

// ── Analysis ──────────────────────────────────────────

/**
 * Classify each pending task's blockage: resolvable (failed deps) vs
 * unresolvable (missing deps). Follows cascade chains to root failures.
 */
export function analyzeBlockedTasks(pending: Task[], allTasks: Task[]): BlockageAnalysis {
  const taskMap = new Map(allTasks.map(t => [t.id, t]));
  const resolvable: BlockageInfo[] = [];
  const unresolvable: BlockageInfo[] = [];

  for (const task of pending) {
    const failedDeps: Task[] = [];
    const missingDeps: string[] = [];

    for (const depId of task.dependsOn) {
      const dep = taskMap.get(depId);
      if (!dep) {
        missingDeps.push(depId);
        continue;
      }

      if (dep.status === "failed") {
        failedDeps.push(dep);
      } else if (dep.status === "pending") {
        // Cascade: dep is pending but itself blocked — find root cause
        const root = findRootFailure(dep, taskMap, new Set());
        if (root) {
          failedDeps.push(root);
        } else {
          // Pending dep with no root failure found — treat as missing
          missingDeps.push(depId);
        }
      }
      // dep.status === "done" → this dep is fine, skip
    }

    const preconditions = taskDependencyPreconditions(task, allTasks);
    if (failedDeps.length > 0) {
      resolvable.push({ task, failedDeps, missingDeps, preconditions });
    } else if (missingDeps.length > 0) {
      unresolvable.push({ task, failedDeps: [], missingDeps, preconditions });
    }
    // If neither: all deps are done (shouldn't be here) or still running
  }

  return { resolvable, unresolvable };
}

/**
 * Walk the dependency chain to find the root failed task.
 * Returns the first failed ancestor, or null if no failed root found.
 */
function findRootFailure(task: Task, taskMap: Map<string, Task>, visited: Set<string>): Task | null {
  if (visited.has(task.id)) return null; // circular
  visited.add(task.id);

  for (const depId of task.dependsOn) {
    const dep = taskMap.get(depId);
    if (!dep) continue;
    if (dep.status === "failed") return dep;
    if (dep.status === "pending") {
      const root = findRootFailure(dep, taskMap, visited);
      if (root) return root;
    }
  }
  return null;
}

// ── Resolution ────────────────────────────────────────

/**
 * Async deadlock resolution. For each resolvable blockage, calls LLM
 * to decide action (absorb/retry/fail) and applies the decision.
 *
 * Pattern: fire-and-forget from tick(), results committed against captured rows
 * and picked up on next tick.
 */
let activeResolutions = 0;
/** @deprecated Process-wide diagnostic only; engines use their own resolver port. */
export function isResolving(): boolean { return activeResolutions > 0; }
export async function resolveDeadlock(analysis: BlockageAnalysis, host: DeadlockFacade | Orchestrator): Promise<void> {
  // Preserve the public shell overload while the engine port uses its facade.
  const facade = "engine" in host ? host.engine.getDeadlockFacade() : host;
  activeResolutions++;
  try { await resolveCapturedDeadlock(analysis, facade); }
  finally { activeResolutions--; }
}
async function resolveCapturedDeadlock(analysis: BlockageAnalysis, facade: DeadlockFacade): Promise<void> {
  // Caller-owned snapshots must not change while memory or the model is awaited.
  analysis = structuredClone(analysis);
  const settings = facade.getConfig()?.settings;
  const maxAttempts = settings?.maxResolutionAttempts ?? 2;
  const model = settings?.orchestratorModel
    ? resolveConfiguredModelSelection(settings.orchestratorModel, settings).selection : undefined;
  const memory = await facade.getMemory();
  const allTasks = await facade.getStore().listTasks();
  const retriedDeps = new Set<string>();

  for (const blockage of analysis.resolvable) {
    const task = blockage.task, failedDep = blockage.failedDeps[0];
    // Include completed sibling inputs used by the prompt, without replacing
    // the dependency snapshots captured when the blockage was detected.
    for (const sibling of completedSiblings(task, failedDep, allTasks)) {
      if (!blockage.preconditions.some(condition => condition.taskId === sibling.id)) {
        blockage.preconditions.push({ taskId: sibling.id, snapshot: sibling });
      }
    }
    if ((task.resolutionAttempts ?? 0) >= maxAttempts) {
      await failBlockage(facade, blockage, "max resolution attempts reached");
      continue;
    }
    if (retriedDeps.has(referenceKey(failedDep))) continue;
    facade.emit("deadlock:resolving", { taskId: task.id, failedDepId: failedDep.id });
    let decision: ResolutionDecision;
    try { decision = await classifyBlockage(task, failedDep, allTasks, memory, model); }
    catch {
      await failBlockage(facade, blockage, "LLM analysis failed");
      continue;
    }
    await applyDecision(decision, task, failedDep, blockage, facade, retriedDeps);
  }
  for (const blockage of analysis.unresolvable) {
    await failBlockage(facade, blockage, `missing dependencies: ${blockage.missingDeps.join(", ")}`);
  }
}

function completedSiblings(task: Task, failedDep: Task, tasks: Task[]): Task[] {
  return task.group ? tasks.filter(value => value.group === task.group && value.id !== task.id && value.id !== failedDep.id && value.status === "done").slice(0, 5) : [];
}

// ── LLM Classification ───────────────────────────────

async function classifyBlockage(
  blockedTask: Task,
  failedDep: Task,
  allTasks: Task[],
  memory: string,
  model?: string | ModelConfig,
): Promise<ResolutionDecision> {
  const prompt = buildResolutionPrompt(blockedTask, failedDep, allTasks, memory);
  const response = (await queryOrchestratorText(prompt, model)).text;

  try {
    const cleaned = response.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    const action = parsed.action;
    if (action !== "absorb" && action !== "retry" && action !== "fail") {
      return { action: "fail", reason: "invalid LLM response" };
    }
    return {
      action,
      reason: parsed.reason || "no reason provided",
      absorbedDescription: parsed.absorbedDescription,
    };
  } catch { /* malformed JSON response */
    return { action: "fail", reason: "failed to parse LLM response" };
  }
}

function buildResolutionPrompt(
  blockedTask: Task,
  failedDep: Task,
  allTasks: Task[],
  memory: string,
): string {
  const siblings = completedSiblings(blockedTask, failedDep, allTasks);

  const errorInfo = failedDep.result
    ? (failedDep.result.stderr || `exit code ${failedDep.result.exitCode}`)
    : "unknown error";

  const assessmentInfo = failedDep.result?.assessment
    ? `\nAssessment score: ${failedDep.result.assessment.globalScore?.toFixed(1) ?? "N/A"}/5`
    : "";

  const resultExcerpt = failedDep.result?.stdout
    ? `\nResult output (last 500 chars): ${failedDep.result.stdout.slice(-500)}`
    : "";

  const parts = [
    `You are Polpo, an AI agent orchestration framework, managing a coding plan. A task has FAILED, blocking a downstream task.`,
    `Analyze the situation and decide how to unblock the downstream task.`,
    ``,
    `## Failed Task`,
    `Title: ${failedDep.title}`,
    `Description: ${failedDep.description}`,
    `Error: ${errorInfo}${assessmentInfo}${resultExcerpt}`,
    ``,
    `## Blocked Downstream Task`,
    `Title: ${blockedTask.title}`,
    `Description: ${blockedTask.description}`,
  ];

  if (siblings.length > 0) {
    parts.push(``, `## Completed Siblings (same plan)`);
    for (const s of siblings.slice(0, 5)) {
      const resultBrief = s.result?.stdout ? s.result.stdout.slice(0, 150) : "";
      parts.push(`- [done] ${s.title}${resultBrief ? `: ${resultBrief}` : ""}`);
    }
  }

  if (memory) {
    parts.push(``, `## Shared Memory`, memory.slice(0, 1000));
  }

  parts.push(
    ``,
    `## Decision`,
    `Choose ONE action:`,
    `- "absorb": The blocked task CAN proceed by incorporating the failed task's work into its own scope. Provide a clear updated description that tells the agent what extra work to do.`,
    `- "retry": The failed task should be retried (transient error, environment issue, might succeed on retry).`,
    `- "fail": The blocked task genuinely CANNOT proceed without the dependency. No workaround exists.`,
    ``,
    `Respond with ONLY a JSON object:`,
    `{"action": "absorb|retry|fail", "reason": "brief explanation", "absorbedDescription": "updated description for the blocked task if action is absorb"}`,
  );

  return parts.join("\n");
}

// ── Apply Decision ────────────────────────────────────

async function applyDecision(
  decision: ResolutionDecision,
  blockedTask: Task,
  failedDep: Task,
  blockage: BlockageInfo,
  facade: DeadlockFacade,
  retriedDeps: Set<string>,
): Promise<void> {
  switch (decision.action) {
    case "absorb": {
      // A root failure reached through a pending intermediary cannot be removed
      // from this task's direct dependencies. Resolve the intermediary first.
      if (!blockedTask.dependsOn.includes(failedDep.id)) return;

      // Build absorbed description
      const errorInfo = failedDep.result
        ? (failedDep.result.stderr || `exit code ${failedDep.result.exitCode}`)
        : "unknown error";

      const absorbBlock = [
        `[Dependency Resolution]`,
        `The dependency "${failedDep.title}" could not be completed.`,
        `Original dependency task: ${failedDep.description}`,
        `Error: ${errorInfo}`,
        `You must handle this work as part of your task.`,
        ``,
        decision.absorbedDescription || "",
        ``,
        `---`,
        `EXISTING TASK (including previously absorbed work): ${blockedTask.description}`,
      ].join("\n");

      // Only the classified dependency is absorbed. Other failed work must
      // receive its own decision; removing it here would silently skip work.
      const committed = await commitDecision(facade, blockedTask, {
        type: "requeue", countRetry: false, reason: "Deadlock dependency absorbed", updates: {
          originalDescription: blockedTask.originalDescription || blockedTask.description,
          dependsOn: blockedTask.dependsOn.filter(id => id !== failedDep.id),
          description: absorbBlock,
          resolutionAttempts: (blockedTask.resolutionAttempts ?? 0) + 1,
        },
      }, blockage.preconditions);
      if (!committed) return;

      facade.emit("deadlock:resolved", {
        taskId: blockedTask.id,
        failedDepId: failedDep.id,
        action: "absorb",
        reason: decision.reason,
      });
      break;
    }

    case "retry": {
      const key = referenceKey(failedDep);
      if (retriedDeps.has(key)) return;
      if (failedDep.retries >= failedDep.maxRetries) {
        await failBlockage(facade, blockage, `dependency "${failedDep.title}" has no retries remaining`);
        return;
      }
      if (!await commitDecision(facade, failedDep, {
        type: "requeue", countRetry: true, reason: "Deadlock dependency retry",
      }, blockage.preconditions)) return;
      // Record only committed retries, keyed by the analyzed execution.
      retriedDeps.add(key);
      facade.emit("deadlock:resolved", { taskId: blockedTask.id, failedDepId: failedDep.id, action: "retry", reason: decision.reason });
      break;
    }
    case "fail":
    default:
      await failBlockage(facade, blockage, decision.reason);
  }
}

function referenceKey(task: Task): string { return JSON.stringify(taskExecutionReference(task)); }
async function commitDecision(facade: DeadlockFacade, task: Task, mutation: TaskExecutionMutation,
  preconditions: TaskExecutionPrecondition[]): Promise<boolean> {
  try {
    await facade.applyTaskExecutionDecision(taskExecutionReference(task), mutation, preconditions);
    return true;
  } catch (error) {
    if (error instanceof TaskExecutionError && error.code === "task_execution_conflict") return false;
    throw error;
  }
}
async function failBlockage(facade: DeadlockFacade, blockage: BlockageInfo, reason: string): Promise<void> {
  if (!await commitDecision(facade, blockage.task, { type: "cancel", reason: "Deadlock could not be resolved" }, blockage.preconditions)) return;
  facade.emit("deadlock:unresolvable", { taskId: blockage.task.id, reason });
}
