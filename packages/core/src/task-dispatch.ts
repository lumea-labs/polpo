import type { ApprovalManager } from "./approval-manager.js";
import { AgentIdentityError, type AgentIdentity } from "./agent-store.js";
import type { OrchestratorContext } from "./orchestrator-context.js";
import type { AgentConfig, Task } from "./types.js";
import type { RunRecord } from "./run-store.js";
import { normalizeRuntimeMetadata } from "./runtime-metadata.js";
import { resolveRuntimeSandboxOptions } from "./runtime-sandbox.js";
import { isTaskExecutionStore, taskExecutionReference, TaskExecutionError,
  type TaskDispatchClaim, type TaskDispatchOverrides } from "./task-execution.js";

export type TaskDispatchContext = Pick<OrchestratorContext, "taskStore" | "runStore" | "hooks" | "config">;
type Approvals = Pick<ApprovalManager, "claimTask" | "checkTask">;
export interface TaskDispatchInvocation {
  task: Task;
  agent: AgentConfig;
  agentIdentity?: AgentIdentity;
  overrides?: TaskDispatchOverrides;
}

function requireApprovals(ctx: TaskDispatchContext, task: Task, approvals?: Approvals): void {
  if (!approvals && (task.approvalState || ctx.config.settings.approvalGates?.some(gate => gate.hook === "task:spawn"))) {
    throw new TaskExecutionError("task_execution_unsupported", "Task approval coordinator is required");
  }
}

/** Claim before any provider, routing or sandbox preparation. The host must own
 * the allocated runId and this promise before calling: a late write cannot be
 * abandoned by a timeout/abort race. The returned Task is authoritative. */
export async function claimTaskDispatch(ctx: TaskDispatchContext, task: Task, runId: string,
  approvals?: Approvals): Promise<TaskDispatchClaim> {
  requireApprovals(ctx, task, approvals);
  if (!isTaskExecutionStore(ctx.taskStore)) {
    throw new TaskExecutionError("task_execution_unsupported", "Task execution persistence is required");
  }
  return approvals ? approvals.claimTask(task, runId)
    : ctx.taskStore.claimTaskExecution(taskExecutionReference(task), runId);
}

/** Withdraw an uncertain claim using the Task transaction, not Run absence.
 * Advancing an unchanged source revision prevents a late database commit from
 * publishing the abandoned attempt. If our claim already won, requeue only its
 * still-running Run. A competing owner or completed result remains untouched.
 * Hosts register this cleanup before claiming and retry it if storage fails. */
export async function fenceTaskDispatch(ctx: Pick<TaskDispatchContext, "taskStore" | "runStore">,
  source: Task, runId: string): Promise<void> {
  if (!isTaskExecutionStore(ctx.taskStore)) {
    throw new TaskExecutionError("task_execution_unsupported", "Task execution persistence is required");
  }
  const expected = taskExecutionReference(source);
  for (let attempt = 0; attempt < 8; attempt++) {
    const current = await ctx.taskStore.getTask(source.id);
    if (!current) return;
    const ref = taskExecutionReference(current);
    const unclaimed = ref.revision === expected.revision && ref.runId === expected.runId
      && current.status === "pending" && current.activeRunId === undefined;
    const ours = current.activeRunId === runId;
    if (!unclaimed && !ours) return;
    if (ours) {
      const run = await ctx.runStore.getRun(runId);
      if (!run) throw new TaskExecutionError("task_execution_conflict", "Task dispatch Run is unavailable; retry cleanup");
      if (run.status !== "running") return;
    }
    try {
      await ctx.taskStore.mutateTaskExecution(ref, { type: "requeue", countRetry: false,
        reason: "Task dispatch interrupted", ...(ours ? { onlyIfRunRunning: true } : {}) });
      return;
    } catch (error) {
      if (!(error instanceof TaskExecutionError && error.code === "task_execution_conflict")) throw error;
    }
  }
  throw new TaskExecutionError("task_execution_conflict", "Task dispatch cleanup requires a retry");
}

export async function isTaskDispatchActive(ctx: Pick<TaskDispatchContext, "taskStore" | "runStore">,
  task: Task, run: RunRecord): Promise<boolean> {
  const current = await ctx.taskStore.getTask(task.id);
  return !!current && current.executionRevision === task.executionRevision && current.activeRunId === run.id
    && (await ctx.runStore.getRun(run.id))?.status === "running";
}

/** Run before-hooks and authorize the final invocation using the separate,
 * unchanged durable source. prepare resolves host policy (model/loop/sandbox)
 * before consent; callers must use the returned invocation without re-routing.
 * Omitting run is reserved for legacy stores without execution persistence. */
export async function authorizeTaskDispatch(ctx: TaskDispatchContext, input: {
  source: Task;
  run?: RunRecord;
  invocation: TaskDispatchInvocation;
  prepare?: (invocation: TaskDispatchInvocation) => Promise<TaskDispatchInvocation>;
}, approvals?: Approvals): Promise<TaskDispatchInvocation & { allowed: boolean; reason?: string }> {
  const source = structuredClone(input.source);
  requireApprovals(ctx, source, approvals);
  if (isTaskExecutionStore(ctx.taskStore) && (!input.run || input.run.id !== source.activeRunId
    || input.run.taskId !== source.id || input.run.taskExecutionRevision !== source.executionRevision)) {
    throw new TaskExecutionError("task_execution_conflict", "Task dispatch requires its claimed Run");
  }
  const identity = input.invocation.agentIdentity ? structuredClone(input.invocation.agentIdentity) : undefined;
  let overrides = input.invocation.overrides ? structuredClone(input.invocation.overrides) : undefined;
  const bind = (invocation: TaskDispatchInvocation): TaskDispatchInvocation => {
    if (invocation.agent.name !== source.assignTo || (identity && identity.name !== source.assignTo)) throw new AgentIdentityError();
    return { task: { ...invocation.task, id: source.id, assignTo: source.assignTo,
      user: source.user, metadata: normalizeRuntimeMetadata(source.metadata),
      status: source.status, executionRevision: source.executionRevision, activeRunId: source.activeRunId,
      approvalState: source.approvalState ? structuredClone(source.approvalState) : undefined },
      agent: invocation.agent, ...(identity ? { agentIdentity: structuredClone(identity) } : {}),
      ...(overrides ? { overrides: structuredClone(overrides) } : {}) };
  };
  let invocation = bind(structuredClone(input.invocation));
  if (overrides) invocation = bind({ ...invocation,
    agent: overrides.model === undefined ? invocation.agent : { ...invocation.agent, model: structuredClone(overrides.model) },
    task: { ...invocation.task,
      // Request preferences are a further policy tier; replacing the Task
      // policy would discard its narrower volume grants.
      ...(overrides.sandbox === undefined ? {} : {
        sandbox: resolveRuntimeSandboxOptions(invocation.task, overrides),
      }),
      ...(overrides.routing === undefined ? {} : { routing: structuredClone(overrides.routing) }),
      ...(overrides.loop === undefined ? {} : { loop: overrides.loop }) } });
  if (input.run && !await isTaskDispatchActive(ctx, source, input.run)) return { ...invocation, allowed: false };
  const hook = await ctx.hooks.runBefore("task:spawn", { task: invocation.task, agent: invocation.agent });
  invocation = bind({ ...invocation, ...hook.data });
  if (!hook.cancelled && input.prepare) {
    const prepared = await input.prepare(invocation);
    // Trusted host policy may freeze a selected model/loop as replay preferences.
    // Before-hooks cannot change these; consent records the final host decision.
    if (prepared.overrides) overrides = structuredClone(prepared.overrides);
    invocation = bind(prepared);
  }
  // Hooks and host preparation may retain their argument references. Detach
  // the exact effective invocation before any asynchronous consent/CAS work.
  invocation = structuredClone(invocation);
  if (input.run && !await isTaskDispatchActive(ctx, source, input.run)) return { ...invocation, allowed: false };
  const allowed = !hook.cancelled && (!approvals || await approvals.checkTask("task:spawn", source, invocation));
  if (!allowed && input.run && isTaskExecutionStore(ctx.taskStore)) {
    const current = await ctx.taskStore.getTask(source.id);
    // Human consent already suspends its attempt atomically. A generic veto
    // requeues only this still-running attempt, never a completed result.
    if (current && current.activeRunId === source.activeRunId && current.executionRevision === source.executionRevision) {
      try {
        await ctx.taskStore.mutateTaskExecution(taskExecutionReference(source), {
          type: "requeue", countRetry: false, reason: "Spawn blocked by hook", onlyIfRunRunning: true,
        });
      } catch (error) {
        if (!(error instanceof TaskExecutionError && error.code === "task_execution_conflict")) throw error;
      }
    }
  }
  return { ...invocation, allowed, ...(hook.cancelReason ? { reason: hook.cancelReason } : {}) };
}
