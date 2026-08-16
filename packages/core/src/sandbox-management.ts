/** Provider-neutral operational management for durable sandbox resources. */

export const SANDBOX_OPERATIONAL_STATES = [
  "provisioning",
  "running",
  "stopped",
  "archived",
  "deleting",
  "deleted",
  "error",
  "unknown",
] as const;

export type SandboxOperationalState =
  (typeof SANDBOX_OPERATIONAL_STATES)[number];

export const SANDBOX_ALLOCATION_STATES = [
  "idle",
  "leased",
  "shared",
  "reserved",
  "untracked",
] as const;

export type SandboxAllocationState =
  (typeof SANDBOX_ALLOCATION_STATES)[number];

export const SANDBOX_HEALTH_STATES = [
  "healthy",
  "degraded",
  "stale",
] as const;

export type SandboxHealth = (typeof SANDBOX_HEALTH_STATES)[number];

export const SANDBOX_ACTIONS = ["start", "stop", "destroy"] as const;
export type SandboxAction = (typeof SANDBOX_ACTIONS)[number];
export type SandboxWorkspaceMode = "local" | "volume-backed";
export type SandboxInventorySourceStatus =
  | "available"
  | "degraded"
  | "unavailable";

export type SandboxManagementDetailValue =
  | string
  | number
  | boolean
  | null;

export interface SandboxActionCapability {
  readonly allowed: boolean;
  readonly reason?: string;
}

export interface SandboxManagementCapabilities {
  readonly inventory: boolean;
  readonly detail: boolean;
  readonly actions: Readonly<Record<SandboxAction, SandboxActionCapability>> & {
    readonly clearIdle: SandboxActionCapability;
  };
}

export interface SandboxWorkspaceSummary {
  readonly mode: SandboxWorkspaceMode;
  readonly volumeCount: number;
  readonly strategies?: readonly ("mounted" | "hydrated")[];
}

export interface SandboxLifecycleSummary {
  /** Omitted when the host cannot determine the configured interval. */
  readonly autoStopMinutes?: number | null;
  /** Omitted when the host cannot determine the configured interval. */
  readonly autoDeleteMinutes?: number | null;
}

export interface SandboxResourceCapacity {
  readonly cpu?: number;
  readonly memoryGiB?: number;
  readonly diskGiB?: number;
  readonly gpu?: number;
}

export interface SandboxRunReference {
  readonly runId: string;
  readonly sessionId?: string;
  readonly agentName?: string;
  readonly surface?: string;
  readonly acquiredAt?: string;
}

export interface SandboxSnapshotSummary {
  readonly id?: string;
  readonly compatible?: boolean;
  readonly reason?: string;
}

export interface SandboxSummary {
  readonly id: string;
  readonly name?: string;
  readonly operationalState: SandboxOperationalState;
  readonly allocationState: SandboxAllocationState;
  readonly health: SandboxHealth;
  /** Bounded provider state for diagnostics; clients do not branch on it. */
  readonly providerState?: string;
  readonly healthReasons?: readonly string[];
  readonly workspace: SandboxWorkspaceSummary;
  readonly lifecycle: SandboxLifecycleSummary;
  readonly capacity?: SandboxResourceCapacity;
  readonly holderCount: number;
  readonly currentRuns?: readonly SandboxRunReference[];
  readonly latestRun?: SandboxRunReference;
  readonly snapshot?: SandboxSnapshotSummary;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly acquiredAt?: string;
  readonly releasedAt?: string;
  readonly lastActivityAt?: string;
  readonly actions: Readonly<Record<SandboxAction, SandboxActionCapability>>;
}

export interface SandboxInventorySummary {
  readonly total: number;
  readonly operational: Partial<Record<SandboxOperationalState, number>>;
  readonly allocation: Partial<Record<SandboxAllocationState, number>>;
}

export interface SandboxInventorySources {
  readonly provider: SandboxInventorySourceStatus;
  readonly coordination: SandboxInventorySourceStatus;
  readonly enrichment: SandboxInventorySourceStatus;
}

export interface SandboxInventoryPage {
  readonly items: readonly SandboxSummary[];
  readonly nextCursor: string | null;
  readonly summary: SandboxInventorySummary;
  readonly observedAt: string;
  readonly sources: SandboxInventorySources;
  readonly capabilities: SandboxManagementCapabilities;
}

export interface SandboxInventoryQuery {
  readonly operationalStates?: readonly SandboxOperationalState[];
  readonly allocationStates?: readonly SandboxAllocationState[];
  readonly workspaceModes?: readonly SandboxWorkspaceMode[];
  readonly search?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface SandboxMutationOptions {
  readonly operationId?: string;
  readonly expectedState?: SandboxOperationalState;
}

export interface SandboxClearIdleOptions {
  readonly operationId?: string;
  readonly limit?: number;
}

export interface SandboxManagementContext {
  readonly projectId: string;
  readonly actorId?: string;
  readonly requestId?: string;
}

export interface SandboxMutationContext extends SandboxManagementContext {
  readonly sandboxId: string;
  readonly operationId: string;
  readonly expectedState?: SandboxOperationalState;
  readonly signal?: AbortSignal;
}

export interface SandboxClearIdleContext extends SandboxManagementContext {
  readonly operationId: string;
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

export type SandboxMutationOutcome = "applied" | "already_satisfied";

export interface SandboxMutationResult {
  readonly sandboxId: string;
  readonly operationId: string;
  readonly outcome: SandboxMutationOutcome;
  readonly sandbox?: SandboxSummary;
}

export interface SandboxClearIdleFailure {
  readonly sandboxId: string;
  readonly code: SandboxManagementErrorCode;
}

export interface SandboxClearIdleResult {
  readonly operationId: string;
  readonly inspected: number;
  readonly destroyed: number;
  readonly skipped: number;
  readonly failed: number;
  readonly failures: readonly SandboxClearIdleFailure[];
}

export interface SandboxManager {
  capabilities(
    context: SandboxManagementContext,
  ): Promise<SandboxManagementCapabilities>;
  list(
    context: SandboxManagementContext,
    query: SandboxInventoryQuery,
  ): Promise<SandboxInventoryPage>;
  get(
    context: SandboxManagementContext,
    sandboxId: string,
  ): Promise<SandboxSummary | null>;
  start(context: SandboxMutationContext): Promise<SandboxMutationResult>;
  stop(context: SandboxMutationContext): Promise<SandboxMutationResult>;
  destroy(context: SandboxMutationContext): Promise<SandboxMutationResult>;
  clearIdle(context: SandboxClearIdleContext): Promise<SandboxClearIdleResult>;
}

export const SANDBOX_MANAGEMENT_ERROR_CODES = [
  "SANDBOX_MANAGEMENT_UNAVAILABLE",
  "SANDBOX_INVALID_REQUEST",
  "SANDBOX_INVALID_RESPONSE",
  "SANDBOX_FORBIDDEN",
  "SANDBOX_NOT_FOUND",
  "SANDBOX_BUSY",
  "SANDBOX_STATE_CONFLICT",
  "SANDBOX_PROVIDER_UNAVAILABLE",
  "SANDBOX_COORDINATION_UNAVAILABLE",
  "SANDBOX_ACTION_TIMEOUT",
  "SANDBOX_ACTION_UNSUPPORTED",
  "SANDBOX_INTERNAL_ERROR",
] as const;

export type SandboxManagementErrorCode =
  (typeof SANDBOX_MANAGEMENT_ERROR_CODES)[number];

export interface SandboxManagementErrorOptions {
  readonly retryable?: boolean;
  readonly details?: Readonly<
    Record<string, SandboxManagementDetailValue>
  >;
  readonly cause?: unknown;
}

export class SandboxManagementError extends Error {
  readonly code: SandboxManagementErrorCode;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, SandboxManagementDetailValue>>;

  constructor(
    code: SandboxManagementErrorCode,
    message: string,
    options: SandboxManagementErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : {
      cause: options.cause,
    });
    this.name = "SandboxManagementError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export function isSandboxManagementError(
  value: unknown,
): value is SandboxManagementError {
  return value instanceof SandboxManagementError;
}
