import type { ScheduleRunStatus, ScheduleStatus } from "./types.js";

export const SCHEDULE_STATUS_TRANSITIONS: Readonly<
  Record<ScheduleStatus, readonly ScheduleStatus[]>
> = Object.freeze({
  active: ["paused", "completed", "deleted"] as const,
  paused: ["active", "completed", "deleted"] as const,
  completed: ["deleted"] as const,
  deleted: [] as const,
});

export const SCHEDULE_RUN_STATUS_TRANSITIONS: Readonly<
  Record<ScheduleRunStatus, readonly ScheduleRunStatus[]>
> = Object.freeze({
  pending: ["claimed", "skipped", "cancelled"] as const,
  claimed: ["pending", "running", "failed", "skipped", "cancelled"] as const,
  running: ["claimed", "pending", "succeeded", "failed", "cancelled"] as const,
  succeeded: [] as const,
  failed: [] as const,
  skipped: [] as const,
  cancelled: [] as const,
});

export function isScheduleStatusTransitionAllowed(
  from: ScheduleStatus,
  to: ScheduleStatus,
): boolean {
  return from === to || SCHEDULE_STATUS_TRANSITIONS[from].includes(to);
}

export function assertScheduleStatusTransition(
  from: ScheduleStatus,
  to: ScheduleStatus,
): void {
  if (!isScheduleStatusTransitionAllowed(from, to)) {
    throw new Error(`Invalid schedule status transition: ${from} -> ${to}`);
  }
}

export function isScheduleRunStatusTransitionAllowed(
  from: ScheduleRunStatus,
  to: ScheduleRunStatus,
): boolean {
  return from === to || SCHEDULE_RUN_STATUS_TRANSITIONS[from].includes(to);
}

export function assertScheduleRunStatusTransition(
  from: ScheduleRunStatus,
  to: ScheduleRunStatus,
): void {
  if (!isScheduleRunStatusTransitionAllowed(from, to)) {
    throw new Error(`Invalid schedule run status transition: ${from} -> ${to}`);
  }
}

export const TERMINAL_SCHEDULE_RUN_STATUSES: ReadonlySet<ScheduleRunStatus> =
  new Set(["succeeded", "failed", "skipped", "cancelled"]);

export function isTerminalScheduleRunStatus(status: ScheduleRunStatus): boolean {
  return TERMINAL_SCHEDULE_RUN_STATUSES.has(status);
}
