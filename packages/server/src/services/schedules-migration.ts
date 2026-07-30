import {
  ScheduleConflictError,
  ScheduleNotFoundError,
  translateLegacyMissionSchedule,
  type Schedule,
} from "@polpo-ai/core/scheduling";
import type { ScheduleService } from "./schedules.js";

const LEGACY_MISSION_STATUSES = new Set([
  "draft",
  "scheduled",
  "recurring",
  "active",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);
const INACTIVE_MISSION_STATUSES = new Set([
  "draft",
  "completed",
  "cancelled",
]);

export interface LegacyMissionScheduleRecord {
  id: string;
  status: string;
  schedule?: string;
  endDate?: string;
  recurring?: boolean;
}

export type LegacyMissionMigrationStatus =
  | "created"
  | "existing"
  | "skipped"
  | "failed";

export type LegacyMissionMigrationCode =
  | "CREATED"
  | "ALREADY_MIGRATED"
  | "DRY_RUN"
  | "NO_SCHEDULE"
  | "INACTIVE_MISSION"
  | "INVALID_MISSION"
  | "INVALID_LEGACY_SCHEDULE"
  | "AMBIGUOUS_RECURRENCE"
  | "READ_FAILED"
  | "ID_CONFLICT"
  | "DEFINITION_CONFLICT"
  | "CREATE_FAILED";

export interface LegacyMissionMigrationItem {
  missionId: string;
  scheduleId?: string;
  status: LegacyMissionMigrationStatus;
  code: LegacyMissionMigrationCode;
  message?: string;
}

export interface LegacyMissionMigrationResult {
  scanned: number;
  eligible: number;
  created: number;
  existing: number;
  skipped: number;
  failed: number;
  items: LegacyMissionMigrationItem[];
}

export interface LegacyMissionMigrationOptions {
  service: ScheduleService;
  missions: Iterable<unknown> | AsyncIterable<unknown>;
  now?: Date | string;
  timezone?: string;
  dryRun?: boolean;
}

/**
 * Import Mission-backed schedules into the v2 store.
 *
 * The deterministic id makes repeated runs safe. A collision is accepted only
 * when the existing definition belongs to the same legacy Mission; unrelated
 * schedules are never overwritten. Failures are bounded and do not expose
 * Mission payloads.
 */
export async function migrateLegacyMissionSchedules(
  options: LegacyMissionMigrationOptions,
): Promise<LegacyMissionMigrationResult> {
  if (!options?.service) {
    throw new Error("Legacy schedule migration requires a schedule service");
  }
  if (!options.missions) {
    throw new Error("Legacy schedule migration requires a mission source");
  }

  const result: LegacyMissionMigrationResult = {
    scanned: 0,
    eligible: 0,
    created: 0,
    existing: 0,
    skipped: 0,
    failed: 0,
    items: [],
  };

  for await (const value of options.missions) {
    result.scanned += 1;
    const mission = parseMission(value);
    if (!mission) {
      append(result, {
        missionId: "<invalid>",
        status: "failed",
        code: "INVALID_MISSION",
        message: "Legacy mission record is invalid",
      });
      continue;
    }

    const scheduleId = legacyMissionScheduleId(mission.id);
    if (mission.schedule === undefined) {
      append(result, {
        missionId: mission.id,
        scheduleId,
        status: "skipped",
        code: "NO_SCHEDULE",
      });
      continue;
    }
    if (INACTIVE_MISSION_STATUSES.has(mission.status)) {
      append(result, {
        missionId: mission.id,
        scheduleId,
        status: "skipped",
        code: "INACTIVE_MISSION",
      });
      continue;
    }

    result.eligible += 1;
    const recurring = legacyRecurrence(mission);
    if (recurring === null) {
      append(result, {
        missionId: mission.id,
        scheduleId,
        status: "failed",
        code: "AMBIGUOUS_RECURRENCE",
        message: "Legacy mission recurrence cannot be inferred safely",
      });
      continue;
    }
    let translated;
    try {
      translated = translateLegacyMissionSchedule({
        missionId: mission.id,
        expression: mission.schedule,
        recurring,
        ...(mission.endDate === undefined
          ? {}
          : { endDate: mission.endDate }),
      }, {
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.timezone === undefined
          ? {}
          : { timezone: options.timezone }),
      });
    } catch {
      append(result, {
        missionId: mission.id,
        scheduleId,
        status: "failed",
        code: "INVALID_LEGACY_SCHEDULE",
        message: "Legacy mission schedule is invalid",
      });
      continue;
    }

    let existing: Schedule | null;
    try {
      existing = await getOptional(options.service, scheduleId);
    } catch {
      append(result, {
        missionId: mission.id,
        scheduleId,
        status: "failed",
        code: "READ_FAILED",
        message: "Existing schedule could not be inspected",
      });
      continue;
    }
    if (existing) {
      appendExistingOrConflict(result, existing, mission.id, translated);
      continue;
    }
    if (options.dryRun === true) {
      append(result, {
        missionId: mission.id,
        scheduleId,
        status: "skipped",
        code: "DRY_RUN",
      });
      continue;
    }

    try {
      await options.service.create({
        ...translated,
        id: scheduleId,
        ...(mission.status === "paused" ? { status: "paused" as const } : {}),
      });
      append(result, {
        missionId: mission.id,
        scheduleId,
        status: "created",
        code: "CREATED",
      });
    } catch (error) {
      if (isScheduleConflict(error)) {
        try {
          const raced = await getOptional(options.service, scheduleId);
          if (raced) {
            appendExistingOrConflict(result, raced, mission.id, translated);
            continue;
          }
        } catch {
          append(result, {
            missionId: mission.id,
            scheduleId,
            status: "failed",
            code: "READ_FAILED",
            message: "Existing schedule could not be inspected",
          });
          continue;
        }
      }
      append(result, {
        missionId: mission.id,
        scheduleId,
        status: "failed",
        code: "CREATE_FAILED",
        message: "Legacy mission schedule could not be created",
      });
    }
  }

  return result;
}

export function legacyMissionScheduleId(missionId: string): string {
  return `legacy-mission:${missionId.trim()}`;
}

function parseMission(value: unknown): LegacyMissionScheduleRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string"
    || record.id.trim().length === 0
    || typeof record.status !== "string"
    || !LEGACY_MISSION_STATUSES.has(record.status)
  ) {
    return null;
  }
  if (
    record.schedule !== undefined
    && (typeof record.schedule !== "string"
      || record.schedule.trim().length === 0)
  ) {
    return null;
  }
  if (
    record.endDate !== undefined
    && typeof record.endDate !== "string"
  ) {
    return null;
  }
  if (
    record.recurring !== undefined
    && typeof record.recurring !== "boolean"
  ) {
    return null;
  }
  return {
    id: record.id.trim(),
    status: record.status,
    ...(record.schedule === undefined
      ? {}
      : { schedule: record.schedule }),
    ...(record.endDate === undefined
      ? {}
      : { endDate: record.endDate }),
    ...(record.recurring === undefined
      ? {}
      : { recurring: record.recurring }),
  };
}

function legacyRecurrence(
  mission: LegacyMissionScheduleRecord,
): boolean | null {
  if (mission.status === "recurring") return true;
  if (mission.status === "scheduled") return false;
  return mission.recurring ?? null;
}

async function getOptional(
  service: ScheduleService,
  id: string,
): Promise<Schedule | null> {
  try {
    return await service.get(id);
  } catch (error) {
    if (error instanceof ScheduleNotFoundError) return null;
    throw error;
  }
}

function appendExistingOrConflict(
  result: LegacyMissionMigrationResult,
  existing: Schedule,
  missionId: string,
  expected: ReturnType<typeof translateLegacyMissionSchedule>,
): void {
  if (
    existing.invocation.surface === "legacy_mission"
    && existing.invocation.missionId === missionId
  ) {
    if (!sameLegacyDefinition(existing, expected)) {
      append(result, {
        missionId,
        scheduleId: existing.id,
        status: "failed",
        code: "DEFINITION_CONFLICT",
        message: "Migrated schedule differs from the legacy definition",
      });
      return;
    }
    append(result, {
      missionId,
      scheduleId: existing.id,
      status: "existing",
      code: "ALREADY_MIGRATED",
    });
    return;
  }
  append(result, {
    missionId,
    scheduleId: existing.id,
    status: "failed",
    code: "ID_CONFLICT",
    message: "Schedule id is already used by a different definition",
  });
}

function sameLegacyDefinition(
  existing: Schedule,
  expected: ReturnType<typeof translateLegacyMissionSchedule>,
): boolean {
  if (
    existing.invocation.surface !== "legacy_mission"
    || expected.invocation.surface !== "legacy_mission"
    || existing.invocation.missionId !== expected.invocation.missionId
    || existing.timing.kind !== expected.timing.kind
  ) {
    return false;
  }
  const sameTiming = existing.timing.kind === "cron"
    && expected.timing.kind === "cron"
    ? existing.timing.expression === expected.timing.expression
      && existing.timing.timezone === expected.timing.timezone
    : existing.timing.kind === "once"
      && expected.timing.kind === "once"
      && existing.timing.at === expected.timing.at
      && existing.timing.timezone === expected.timing.timezone;
  if (!sameTiming) return false;

  const actualCompatibility = compatibilityMetadata(existing);
  const expectedCompatibility = compatibilityMetadata(expected);
  return actualCompatibility.source === expectedCompatibility.source
    && actualCompatibility.recurring === expectedCompatibility.recurring
    && actualCompatibility.endDate === expectedCompatibility.endDate
    && actualCompatibility.maxOccurrences
      === expectedCompatibility.maxOccurrences;
}

function compatibilityMetadata(
  schedule: Pick<Schedule, "metadata">,
): Record<string, unknown> {
  const value = schedule.metadata.compatibility;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function isScheduleConflict(error: unknown): boolean {
  return error instanceof ScheduleConflictError
    || (
      error instanceof Error
      && "code" in error
      && error.code === "CONFLICT"
    );
}

function append(
  result: LegacyMissionMigrationResult,
  item: LegacyMissionMigrationItem,
): void {
  result.items.push(item);
  result[item.status] += 1;
}
