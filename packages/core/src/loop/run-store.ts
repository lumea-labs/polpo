import type { ContextBag, LoopLifecycleHook, LoopTraceEvent, ProjectLoopConfig, ProjectLoopPermission, ProjectLoopPolicy, Step } from "./types.js";
import type { SteeringQueueSnapshot } from "../steering.js";

export type ProjectLoopRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "awaiting_approval"
  | "approval_approved"
  | "approval_rejected"
  | "resuming"
  | "cancelled";

export interface LoopApprovedGate {
  type: "policy" | "permission";
  id: string;
  hook: LoopLifecycleHook;
  approvalRequestId?: string;
  resolvedAt?: string;
  resolvedBy?: string;
}

export interface LoopResumeState {
  context: ContextBag;
  steps: Step[];
  previousNode?: string;
  approvedGates?: LoopApprovedGate[];
  runtime?: Record<string, unknown>;
  attempts?: number;
  createdAt: string;
  updatedAt?: string;

  // ── Durable turns (task path) — per-turn conversation checkpoint ──
  // The pipeline fields above describe WHERE a project-loop pipeline
  // stopped; these additive fields describe WHERE a turn-based LLM session
  // stopped. Both live in the same state so the task runner and the
  // completions resume path share one format instead of inventing two.

  /** Name of the loop session this checkpoint belongs to (e.g. "default"). */
  loopName?: string;
  /**
   * Durable pipelines (task path): name of the project-loop pipeline this
   * checkpoint belongs to. When set, `steps`/`context`/`previousNode` above
   * carry the pipeline position — the SAME remaining-steps semantics the
   * human-gate resume already replays — and the turn fields below, when
   * present, describe the agent step that was in flight (its loop name in
   * `loopName`, its session history in `history`). Absent on single-session
   * checkpoints and on pre-existing gate resume states (compat).
   */
  pipelineName?: string;
  /** Index of the last COMPLETED turn (0-based). Resume starts at turn + 1. */
  turn?: number;
  /**
   * Serialized conversation history (AI SDK ModelMessage[]) including
   * tool-call and tool-result parts — always post-compaction, since the
   * checkpoint is taken at end-of-turn and compaction rewrites the history
   * at the start of a model step. A resumed run replays completed
   * side-effects from these recorded results; it never re-executes them.
   */
  history?: unknown[];
  /** Assistant text accumulated across completed turns. */
  accumText?: string;
  /** Undelivered run-scoped steering messages and recent idempotency ids. */
  steering?: SteeringQueueSnapshot;
}

export interface LoopApprovalSnapshot {
  type?: "policy" | "permission";
  policyId: string;
  permissionId?: string;
  hook: LoopLifecycleHook;
  message?: string;
  payload: Record<string, unknown>;
  context: ContextBag;
  status?: "pending" | "approved" | "rejected";
  resolvedAt?: string;
  resolvedBy?: string;
  note?: string;
}

export interface LoopRunRecord {
  id: string;
  loopName: string;
  agentName?: string;
  sessionId?: string;
  user?: string;
  status: ProjectLoopRunStatus;
  context: ContextBag;
  trace: LoopTraceEvent[];
  error?: string;
  approvalRequestId?: string;
  approval?: LoopApprovalSnapshot;
  resume?: LoopResumeState;
  metadata?: Record<string, unknown>;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface CreateLoopRunInput {
  id: string;
  loop: Pick<ProjectLoopConfig, "name" | "description" | "metadata">;
  agentName?: string;
  sessionId?: string;
  user?: string;
  context?: ContextBag;
  metadata?: Record<string, unknown>;
}

export interface LoopRunListFilter {
  loopName?: string;
  agentName?: string;
  sessionId?: string;
  user?: string;
  status?: ProjectLoopRunStatus;
  limit?: number;
}

export interface LoopRunStore {
  createRun(input: CreateLoopRunInput): Promise<LoopRunRecord>;
  getRun(id: string): Promise<LoopRunRecord | undefined>;
  listRuns(filter?: LoopRunListFilter): Promise<LoopRunRecord[]>;
  appendTrace(runId: string, event: LoopTraceEvent): Promise<void>;
  updateRun(runId: string, patch: Partial<Omit<LoopRunRecord, "id" | "startedAt">>): Promise<LoopRunRecord | undefined>;
  close?(): Promise<void> | void;
}

export class MemoryLoopRunStore implements LoopRunStore {
  private readonly runs = new Map<string, LoopRunRecord>();

  async createRun(input: CreateLoopRunInput): Promise<LoopRunRecord> {
    const now = new Date().toISOString();
    const run: LoopRunRecord = {
      id: input.id,
      loopName: input.loop.name,
      agentName: input.agentName,
      sessionId: input.sessionId,
      user: input.user,
      status: "running",
      context: input.context ?? {},
      trace: [],
      metadata: {
        ...input.loop.metadata,
        ...input.metadata,
      },
      startedAt: now,
      updatedAt: now,
    };
    this.runs.set(run.id, run);
    return run;
  }

  async getRun(id: string): Promise<LoopRunRecord | undefined> {
    return this.clone(this.runs.get(id));
  }

  async listRuns(filter: LoopRunListFilter = {}): Promise<LoopRunRecord[]> {
    let runs = Array.from(this.runs.values());
    if (filter.loopName) runs = runs.filter((run) => run.loopName === filter.loopName);
    if (filter.agentName) runs = runs.filter((run) => run.agentName === filter.agentName);
    if (filter.sessionId) runs = runs.filter((run) => run.sessionId === filter.sessionId);
    if (filter.user) runs = runs.filter((run) => run.user === filter.user);
    if (filter.status) runs = runs.filter((run) => run.status === filter.status);
    runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return runs.slice(0, filter.limit ?? runs.length).map((run) => this.clone(run)!);
  }

  async appendTrace(runId: string, event: LoopTraceEvent): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    run.trace = [...run.trace, event];
    run.updatedAt = new Date().toISOString();
  }

  async updateRun(runId: string, patch: Partial<Omit<LoopRunRecord, "id" | "startedAt">>): Promise<LoopRunRecord | undefined> {
    const run = this.runs.get(runId);
    if (!run) return undefined;
    const updated: LoopRunRecord = {
      ...run,
      ...patch,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    };
    this.runs.set(runId, updated);
    return this.clone(updated);
  }

  private clone(run: LoopRunRecord | undefined): LoopRunRecord | undefined {
    if (!run) return undefined;
    return JSON.parse(JSON.stringify(run)) as LoopRunRecord;
  }
}

export class LoopPolicyDeniedError extends Error {
  readonly code = "loop_policy_denied";
  constructor(
    public readonly policy: ProjectLoopPolicy,
    public readonly hook: LoopLifecycleHook,
    public readonly payload: Record<string, unknown>,
    message?: string,
  ) {
    const id = policy.id ?? "anonymous";
    super(message ?? `Loop policy "${id}" denied ${hook}${policy.message ? `: ${policy.message}` : ""}`);
    this.name = "LoopPolicyDeniedError";
  }
}

export interface LoopApprovalContinuation {
  context: ContextBag;
  steps: Step[];
  previousNode?: string;
}

export class LoopApprovalRequiredError extends Error {
  readonly code = "loop_approval_required";
  resume?: LoopApprovalContinuation;
  constructor(
    public readonly policy: ProjectLoopPolicy,
    public readonly hook: LoopLifecycleHook,
    public readonly context: ContextBag,
    public readonly payload: Record<string, unknown>,
    message?: string,
  ) {
    const id = policy.id ?? "anonymous";
    super(message ?? `Loop policy "${id}" requires approval at ${hook}${policy.message ? `: ${policy.message}` : ""}`);
    this.name = "LoopApprovalRequiredError";
  }
}

export class LoopPermissionDeniedError extends Error {
  readonly code = "loop_permission_denied";
  constructor(
    public readonly permission: ProjectLoopPermission,
    public readonly hook: LoopLifecycleHook,
    public readonly payload: Record<string, unknown>,
    message?: string,
  ) {
    const id = permission.id ?? "anonymous";
    super(message ?? `Loop permission "${id}" denied ${hook}${permission.message ? `: ${permission.message}` : ""}`);
    this.name = "LoopPermissionDeniedError";
  }
}

export class LoopPermissionApprovalRequiredError extends Error {
  readonly code = "loop_permission_approval_required";
  resume?: LoopApprovalContinuation;
  constructor(
    public readonly permission: ProjectLoopPermission,
    public readonly hook: LoopLifecycleHook,
    public readonly context: ContextBag,
    public readonly payload: Record<string, unknown>,
    message?: string,
  ) {
    const id = permission.id ?? "anonymous";
    super(message ?? `Loop permission "${id}" requires approval at ${hook}${permission.message ? `: ${permission.message}` : ""}`);
    this.name = "LoopPermissionApprovalRequiredError";
  }
}
