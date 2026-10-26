import type { MissionAbortOptions, MissionAbortResult, MissionExecutionOptions } from "@polpo-ai/core/mission-store";
/**
 * Route dependency interfaces.
 *
 * Each route factory accepts a `() => XxxDeps` thunk that is evaluated
 * at request time (after orchestrator init).  This decouples routes from
 * the Orchestrator god-object so consumers can wire stores directly.
 */

import type { TaskStore } from "@polpo-ai/core/task-store";
import type { RunStore } from "@polpo-ai/core/run-store";
import type { LoopRunStore } from "@polpo-ai/core/loop-run-store";
import type { LogStore } from "@polpo-ai/core/log-store";
import type { VaultStore } from "@polpo-ai/core/vault-store";
import type { PlaybookStore } from "@polpo-ai/core/playbook-store";
import type { SessionStore } from "@polpo-ai/core/session-store";
import type { SessionContinuationScope } from "@polpo-ai/core/session-continuation";
import type { ConnectService } from "@polpo-ai/connect-server";
import type {
  MemoryExtractionCandidateStore,
  MemoryExtractionReviewer,
  MemoryItemStore,
  MemoryStoreContext,
  MemoryUsageEvent,
} from "@polpo-ai/core";
import type { ScheduleService } from "./services/schedules.js";
import type {
  ChannelManagementScope,
  ChannelManagementService,
} from "@polpo-ai/channels";

// ── Store-centric deps ───────────────────────────────────────────────

export interface VaultRouteDeps {
  vaultStore?: VaultStore;
}

export interface ChatRouteDeps {
  emit?: (event: string, data: unknown) => void;
  sessionStore?: SessionStore;
  runStore?: RunStore;
  /**
   * Trusted host partition for client-tool resolution. Public request data can
   * never declare or widen this scope.
   */
  resolveClientToolResolutionScope?: (
    requestContext: unknown,
  ) => SessionContinuationScope | undefined | Promise<SessionContinuationScope | undefined>;
  /**
   * Host-owned write gate. Omit it to keep settlement-only writes disabled.
   * Returning false denies the write; returning true authorizes only the
   * already-authenticated agent/user and host-resolved scope.
   */
  authorizeClientToolSettlement?: (
    input: {
      sessionId: string;
      toolCallId: string;
      agent?: string;
      user?: string;
      requestContext: unknown;
    },
  ) => boolean | Promise<boolean>;
  /** Optional read-only host lookup used to enrich accepted continuations. */
  resolveClientToolContinuationRunStatus?: (
    input: {
      sessionId: string;
      toolCallId: string;
      runId: string;
      requestContext: unknown;
    },
  ) => ClientToolContinuationRunStatus | undefined | Promise<ClientToolContinuationRunStatus | undefined>;
  /**
   * Tail-latency policy for read-only Session history requests.
   * One hedge is shared by all concurrent callers for the same store/session;
   * the response deadline never cancels or replays mutations.
   */
  sessionHistoryReadPolicy?: {
    hedgeAfterMs?: number;
    responseTimeoutMs?: number;
  };
}

export type ClientToolContinuationRunStatus =
  | "accepted"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

export interface LoopRunRouteDeps {
  loopRunStore?: LoopRunStore;
}

export interface ConnectRouteDeps {
  connectService?: ConnectService;
}

export interface ChannelManagementRouteDeps {
  channelManagementService?: ChannelManagementService;
  resolveChannelManagementScope: (
    requestContext: unknown,
  ) => ChannelManagementScope | Promise<ChannelManagementScope>;
}

export interface MemoryRouteDeps {
  /** Omit the store to keep typed Memory unavailable. */
  memoryItemStore?: MemoryItemStore;
  /** Omit the store to keep automatic-learning review unavailable. */
  memoryExtractionStore?: MemoryExtractionCandidateStore;
  /** Host-owned authentication, isolation namespace, and external-user scope. */
  resolveMemoryContext: (
    agentName: string,
    requestContext: unknown,
  ) => MemoryStoreContext | Promise<MemoryStoreContext>;
  /** Host-authenticated reviewer identity; request bodies cannot override it. */
  resolveMemoryReviewer?: (
    agentName: string,
    requestContext: unknown,
  ) => MemoryExtractionReviewer | Promise<MemoryExtractionReviewer>;
  createId?: () => string;
  createUsageId?: () => string;
  now?: () => Date | string;
  /** Usage telemetry is best-effort and must not change operation semantics. */
  onUsageError?: (
    error: unknown,
    event: MemoryUsageEvent,
  ) => void | Promise<void>;
}

// ── Task deps ────────────────────────────────────────────────────────

export interface TaskRouteDeps {
  taskStore: TaskStore;
  createTask: (...args: any[]) => Promise<any>;
  deleteTask: (...args: any[]) => Promise<any>;
  retryTask: (...args: any[]) => Promise<any>;
  killTask: (...args: any[]) => Promise<any>;
  reassessTask: (...args: any[]) => Promise<any>;
  forceFailTask: (...args: any[]) => Promise<any>;
  updateTaskDescription: (...args: any[]) => Promise<any>;
  updateTaskAssignment: (...args: any[]) => Promise<any>;
  updateTaskExpectations: (...args: any[]) => Promise<any>;
}

// ── Agent deps ───────────────────────────────────────────────────────

export interface AgentRouteDeps {
  getAgents: () => Promise<any[]>;
  addAgent: (...args: any[]) => Promise<any>;
  removeAgent: (...args: any[]) => Promise<any>;
  updateAgent: (...args: any[]) => Promise<any>;
  getAgentSnapshot?: import("@polpo-ai/core/agent-store").VersionedAgentStore["getAgentSnapshot"];
  compareAndSwapAgent?: import("@polpo-ai/core/agent-store").VersionedAgentStore["compareAndSwapAgent"];
  getTeams: () => Promise<any[]>;
  getTeam: (name?: string) => Promise<any>;
  addTeam: (...args: any[]) => Promise<any>;
  updateTeam: (name: string, updates: { description?: string }) => Promise<any>;
  removeTeam: (...args: any[]) => Promise<any>;
  renameTeam: (oldName: string, newName: string) => Promise<any>;
  getStore: () => TaskStore;
  getRunStore: () => RunStore;
  getPolpoDir: () => string;
}

// ── Mission deps ─────────────────────────────────────────────────────

export interface MissionRouteDeps {
  listMissions: () => Promise<any[]>;
  getResumableMissions: () => Promise<any[]>;
  getMission: (missionId: string) => Promise<any>;
  createMission: (...args: any[]) => Promise<any>;
  updateMission: (missionId: string, updates: any) => Promise<any>;
  deleteMission: (missionId: string) => Promise<any>;
  executeMission: (missionId: string, options?: MissionExecutionOptions) => Promise<any>;
  resumeMission: (missionId: string, opts?: any) => Promise<any>;
  abortMission: (missionId: string, options?: MissionAbortOptions) => Promise<MissionAbortResult>;
  getActiveCheckpoints: () => any[] | Promise<any[]>;
  resumeCheckpointByMissionId: (missionId: string, checkpointName: string) => Promise<any>;
  getActiveDelays: () => any[] | Promise<any[]>;
  addMissionTask: (missionId: string, task: any) => Promise<any>;
  updateMissionTask: (missionId: string, taskTitle: string, updates: any) => Promise<any>;
  removeMissionTask: (missionId: string, taskTitle: string) => Promise<any>;
  reorderMissionTasks: (missionId: string, titles: string[]) => Promise<any>;
  addMissionCheckpoint: (missionId: string, checkpoint: any) => Promise<any>;
  updateMissionCheckpoint: (missionId: string, checkpointName: string, updates: any) => Promise<any>;
  removeMissionCheckpoint: (missionId: string, checkpointName: string) => Promise<any>;
  addMissionDelay: (missionId: string, delay: any) => Promise<any>;
  updateMissionDelay: (missionId: string, delayName: string, updates: any) => Promise<any>;
  removeMissionDelay: (missionId: string, delayName: string) => Promise<any>;
  addMissionQualityGate: (missionId: string, gate: any) => Promise<any>;
  updateMissionQualityGate: (missionId: string, gateName: string, updates: any) => Promise<any>;
  removeMissionQualityGate: (missionId: string, gateName: string) => Promise<any>;
  addMissionTeamMember: (missionId: string, member: any) => Promise<any>;
  updateMissionTeamMember: (missionId: string, memberName: string, updates: any) => Promise<any>;
  removeMissionTeamMember: (missionId: string, memberName: string) => Promise<any>;
  updateMissionNotifications: (missionId: string, notifications: any) => Promise<any>;
}

// ── Playbook deps ────────────────────────────────────────────────────

export interface PlaybookRouteDeps {
  playbookStore: PlaybookStore;
  createMission: (...args: any[]) => Promise<any>;
  executeMission: (missionId: string, options?: MissionExecutionOptions) => Promise<any>;
}

// ── Approval deps ────────────────────────────────────────────────────

export interface ApprovalRouteDeps {
  getAllApprovals: (status?: string) => Promise<any[]>;
  getApprovalRequest: (id: string) => Promise<any>;
  approveRequest: (id: string, resolvedBy?: string, note?: string) => Promise<any>;
  rejectRequest: (id: string, feedback: string, resolvedBy?: string) => Promise<any>;
  canRejectRequest: (id: string) => Promise<{ allowed: boolean; rejectionCount?: number; maxRejections?: number }>;
  getPendingApprovals: () => Promise<any[]>;
}

// ── Notification Router (used by config routes for channel testing) ──

export interface NotificationRouterLike {
  getStore: () => any;
  sendDirect: (opts: any) => Promise<any>;
  getRules: () => any[];
  addRule: (rule: any) => void;
  removeRule: (ruleId: string) => boolean;
  getChannelIds: () => string[];
  testChannels: () => Promise<Record<string, boolean>>;
}

// ── Schedule deps ────────────────────────────────────────────────────

export interface SchedulerLike {
  getAllSchedules: () => any[];
  getScheduleByMissionId: (missionId: string) => any;
  registerMission: (mission: any) => any;
  unregisterMission: (missionId: string) => boolean;
}

export interface ScheduleRouteDeps {
  scheduleService?: ScheduleService;
  getScheduler?: () => SchedulerLike | undefined;
  getMission?: (missionId: string) => Promise<any>;
  updateMission?: (missionId: string, updates: any) => Promise<any>;
}

// ── Watcher deps ─────────────────────────────────────────────────────

export interface WatcherManagerLike {
  getAll: () => any[];
  getActive: () => any[];
  create: (opts: any) => any;
  remove: (watcherId: string) => boolean;
}

export interface WatcherRouteDeps {
  getWatcherManager: () => WatcherManagerLike | undefined;
  taskStore: TaskStore;
}

// ── State deps ───────────────────────────────────────────────────────

export interface StateRouteDeps {
  taskStore: TaskStore;
  getConfig: () => any;
  hasMemory: () => Promise<boolean>;
  getMemory: () => Promise<any>;
  saveMemory: (content: any) => Promise<void>;
  hasAgentMemory: (agentName: string) => Promise<boolean>;
  getAgentMemory: (agentName: string) => Promise<any>;
  saveAgentMemory: (agentName: string, content: any) => Promise<void>;
  getLogStore: () => LogStore | undefined;
}

// ── Skill deps ───────────────────────────────────────────────────────

export interface SkillRouteDeps {
  getPolpoDir: () => string;
  getWorkDir: () => string;
  getAgents: () => Promise<any[]>;
}

// ── Config deps ──────────────────────────────────────────────────────

export interface ConfigRouteDeps {
  getConfig: () => any;
  reloadConfig: () => Promise<boolean>;
  getPolpoDir: () => string;
  getNotificationRouter: () => NotificationRouterLike | undefined;
  loadPolpoConfig: (polpoDir: string) => any;
  savePolpoConfig: (polpoDir: string, config: any) => void;
}

// ── Auth deps ────────────────────────────────────────────────────────

export interface AuthRouteDeps {
  getConfig: () => any;
}

// ── File deps ────────────────────────────────────────────────────────

export interface FileRouteDeps {
  getPolpoDir: () => string;
  getWorkDir: () => string;
  getAgentWorkDir: () => string;
  emit: (event: string, data: any) => void;
}
