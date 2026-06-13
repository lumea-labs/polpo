import type { ContextBag, LoopLifecycleHook, LoopTraceEvent, ProjectLoopConfig, ProjectLoopPolicy } from "./types.js";

export type ProjectLoopRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "awaiting_approval"
  | "cancelled";

export interface LoopApprovalSnapshot {
  policyId: string;
  hook: LoopLifecycleHook;
  message?: string;
  payload: Record<string, unknown>;
  context: ContextBag;
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

export class LoopApprovalRequiredError extends Error {
  readonly code = "loop_approval_required";
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
