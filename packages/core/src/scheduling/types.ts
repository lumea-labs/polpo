export type ScheduleJsonPrimitive = string | number | boolean | null;
export type ScheduleJsonValue =
  | ScheduleJsonPrimitive
  | ScheduleJsonValue[]
  | { [key: string]: ScheduleJsonValue };
export type ScheduleMetadata = Record<string, ScheduleJsonValue>;

export type ScheduleStatus = "active" | "paused" | "completed" | "deleted";
export type ScheduleCatchUpPolicy = "skip" | "latest";

export interface ScheduleCronTiming {
  kind: "cron";
  expression: string;
  timezone: string;
}

export interface ScheduleOnceTiming {
  kind: "once";
  /** Absolute ISO 8601 timestamp. */
  at: string;
  /** IANA timezone used for presentation and future calendar operations. */
  timezone: string;
}

export type ScheduleTiming = ScheduleCronTiming | ScheduleOnceTiming;

export interface ScheduleMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ScheduleExecutionOptions {
  loop?: string;
  model?: string;
  sandbox?: RuntimeSandboxOptions;
  guardrails?: {
    mode?: string;
  };
  metadata?: ScheduleMetadata;
}

export interface ScheduleAgentInvocation {
  surface: "agent";
  agentName: string;
  input: {
    prompt?: string;
    messages?: ScheduleMessage[];
  };
  session?: {
    mode: "new" | "reuse";
    sessionId?: string;
    userId?: string;
  };
  execution?: ScheduleExecutionOptions;
}

export interface ScheduleTaskInvocation {
  surface: "task";
  agentName: string;
  title: string;
  prompt: string;
  userId?: string;
  metadata?: ScheduleMetadata;
  execution?: ScheduleExecutionOptions;
}

export interface ScheduleChannelSendInvocation {
  surface: "channel";
  channelId: string;
  routeId?: string;
  externalThreadId?: string;
  mode: "send";
  text: string;
  metadata?: ScheduleMetadata;
}

export interface ScheduleChannelAgentReplyInvocation {
  surface: "channel";
  channelId: string;
  routeId?: string;
  externalThreadId?: string;
  mode: "agent_reply";
  agentName: string;
  prompt: string;
  metadata?: ScheduleMetadata;
  execution?: ScheduleExecutionOptions;
}

export type ScheduleChannelInvocation =
  | ScheduleChannelSendInvocation
  | ScheduleChannelAgentReplyInvocation;

export interface ScheduleWebhookInvocation {
  surface: "webhook";
  webhookId: string;
  payload?: ScheduleMetadata;
}

export interface ScheduleLegacyMissionInvocation {
  surface: "legacy_mission";
  missionId: string;
}

export type ScheduleInvocation =
  | ScheduleAgentInvocation
  | ScheduleTaskInvocation
  | ScheduleChannelInvocation
  | ScheduleWebhookInvocation
  | ScheduleLegacyMissionInvocation;

export interface SchedulePolicy {
  catchUp: ScheduleCatchUpPolicy;
  misfireGraceSeconds: number;
  maxConcurrency: number;
}

export interface ScheduleDriverRegistration {
  kind: string;
  status: "pending" | "registered" | "failed" | "not_required";
  providerId?: string;
  metadata?: ScheduleMetadata;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
  updatedAt: string;
}

export interface Schedule {
  id: string;
  name?: string;
  description?: string;
  timing: ScheduleTiming;
  invocation: ScheduleInvocation;
  status: ScheduleStatus;
  policy: SchedulePolicy;
  metadata: ScheduleMetadata;
  nextOccurrenceAt?: string;
  lastOccurrenceAt?: string;
  driver?: ScheduleDriverRegistration;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface CreateScheduleInput {
  id?: string;
  name?: string;
  description?: string;
  timing: ScheduleTiming;
  invocation: ScheduleInvocation;
  status?: Extract<ScheduleStatus, "active" | "paused">;
  policy?: Partial<SchedulePolicy>;
  metadata?: ScheduleMetadata;
}

export interface NormalizedCreateScheduleInput {
  id?: string;
  name?: string;
  description?: string;
  timing: ScheduleTiming;
  invocation: ScheduleInvocation;
  status: Extract<ScheduleStatus, "active" | "paused">;
  policy: SchedulePolicy;
  metadata: ScheduleMetadata;
}

export interface UpdateScheduleInput {
  name?: string | null;
  description?: string | null;
  timing?: ScheduleTiming;
  invocation?: ScheduleInvocation;
  status?: Extract<ScheduleStatus, "active" | "paused" | "completed">;
  policy?: Partial<SchedulePolicy>;
  metadata?: ScheduleMetadata;
}

export interface LegacyMissionScheduleInput {
  missionId: string;
  expression: string;
  recurring?: boolean;
  endDate?: string;
}

export type ScheduleRunStatus =
  | "pending"
  | "claimed"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled";

export interface ScheduleLease {
  owner: string;
  token: string;
  expiresAt: string;
}

export interface ScheduleRunReferences {
  runtimeId?: string;
  taskId?: string;
  loopRunId?: string;
  sessionId?: string;
  channelEventId?: string;
  providerDeliveryId?: string;
}

export interface ScheduleRunError {
  code: string;
  message: string;
  retryable: boolean;
  metadata?: ScheduleMetadata;
}

export interface ScheduleRun {
  id: string;
  scheduleId: string;
  occurrenceAt: string;
  triggerId: string;
  idempotencyKey: string;
  status: ScheduleRunStatus;
  attempts: number;
  lease?: ScheduleLease;
  references: ScheduleRunReferences;
  result?: ScheduleMetadata;
  error?: ScheduleRunError;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
}
import type { RuntimeSandboxOptions } from "../runtime-sandbox.js";
