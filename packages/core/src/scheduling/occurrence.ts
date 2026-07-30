import { CronExpressionParser, type CronDate } from "cron-parser";
import type { Schedule } from "./types.js";
import { normalizeCronExpression } from "./validation.js";

const MAX_OCCURRENCE_LIST_SIZE = 1_000;
const SEARCH_HORIZON_YEARS = 5;

export interface ScheduleOccurrence {
  occurrenceAt: string;
  localKey: string;
  triggerId: string;
  idempotencyKey: string;
}

export interface ListScheduleOccurrencesOptions {
  after: Date | string;
  through?: Date | string;
  limit?: number;
}

export function nextScheduleOccurrence(
  schedule: Schedule,
  after: Date | string,
): ScheduleOccurrence | null {
  const afterDate = validDate(after, "Schedule occurrence after");

  if (schedule.timing.kind === "once") {
    const at = validDate(schedule.timing.at, "Schedule once occurrence");
    return at.getTime() > afterDate.getTime()
      ? scheduleOccurrenceIdentity(schedule, at)
      : null;
  }

  const expression = normalizeCronExpression(schedule.timing.expression);
  const endDate = addUtcYears(afterDate, SEARCH_HORIZON_YEARS);
  const interval = CronExpressionParser.parse(expression, {
    currentDate: afterDate,
    endDate,
    tz: schedule.timing.timezone,
  });
  const afterLocalKey = localMinuteKey(afterDate, schedule.timing.timezone);

  for (;;) {
    let candidate: CronDate;
    try {
      candidate = interval.next();
    } catch (error) {
      if (isRangeExhaustion(error)) return null;
      throw error;
    }
    if (!matchesRequestedWallClock(interval, candidate)) continue;

    const occurrence = identityUnchecked(schedule, candidate.toDate());
    if (occurrence.localKey === afterLocalKey) continue;
    return occurrence;
  }
}

export function previousScheduleOccurrence(
  schedule: Schedule,
  atOrBefore: Date | string,
): ScheduleOccurrence | null {
  const bound = validDate(atOrBefore, "Schedule occurrence bound");
  if (schedule.timing.kind === "once") {
    const at = validDate(schedule.timing.at, "Schedule once occurrence");
    return at.getTime() <= bound.getTime()
      ? scheduleOccurrenceIdentity(schedule, at)
      : null;
  }

  const expression = normalizeCronExpression(schedule.timing.expression);
  const currentDate = new Date(bound.getTime() + 1);
  const startDate = addUtcYears(bound, -SEARCH_HORIZON_YEARS);
  const interval = CronExpressionParser.parse(expression, {
    currentDate,
    startDate,
    tz: schedule.timing.timezone,
  });

  for (;;) {
    let candidate: CronDate;
    try {
      candidate = interval.prev();
    } catch (error) {
      if (isRangeExhaustion(error)) return null;
      throw error;
    }
    if (!matchesRequestedWallClock(interval, candidate)) continue;
    const date = candidate.toDate();
    if (date.getTime() <= bound.getTime()) {
      return identityUnchecked(schedule, date);
    }
  }
}

export function listScheduleOccurrences(
  schedule: Schedule,
  options: ListScheduleOccurrencesOptions,
): ScheduleOccurrence[] {
  const after = validDate(options.after, "Schedule occurrence after");
  const through = options.through === undefined
    ? undefined
    : validDate(options.through, "Schedule occurrence through");
  if (through && through.getTime() <= after.getTime()) return [];

  const limit = options.limit ?? 100;
  if (
    !Number.isInteger(limit)
    || limit < 1
    || limit > MAX_OCCURRENCE_LIST_SIZE
  ) {
    throw new Error(
      `Schedule occurrence limit must be an integer between 1 and ${MAX_OCCURRENCE_LIST_SIZE}`,
    );
  }

  const occurrences: ScheduleOccurrence[] = [];
  let cursor = after;
  while (occurrences.length < limit) {
    const occurrence = nextScheduleOccurrence(schedule, cursor);
    if (!occurrence) break;
    if (
      through
      && Date.parse(occurrence.occurrenceAt) > through.getTime()
    ) {
      break;
    }
    occurrences.push(occurrence);
    cursor = new Date(occurrence.occurrenceAt);
  }
  return occurrences;
}

export function scheduleOccurrenceIdentity(
  schedule: Schedule,
  occurrenceAt: Date | string,
): ScheduleOccurrence {
  const at = validDate(occurrenceAt, "Schedule occurrence");
  if (schedule.timing.kind === "once") {
    if (at.getTime() !== Date.parse(schedule.timing.at)) {
      throw new Error(
        `Schedule occurrence ${at.toISOString()} does not match one-time schedule "${schedule.id}"`,
      );
    }
    return identityUnchecked(schedule, at);
  }

  const previous = new Date(at.getTime() - 1);
  const candidate = nextScheduleOccurrence(schedule, previous);
  if (!candidate || candidate.occurrenceAt !== at.toISOString()) {
    throw new Error(
      `Schedule occurrence ${at.toISOString()} does not match schedule "${schedule.id}"`,
    );
  }
  return candidate;
}

function identityUnchecked(
  schedule: Schedule,
  occurrenceAt: Date,
): ScheduleOccurrence {
  const occurrenceIso = occurrenceAt.toISOString();
  const localKey = schedule.timing.kind === "cron"
    ? localMinuteKey(occurrenceAt, schedule.timing.timezone)
    : occurrenceIso;
  return {
    occurrenceAt: occurrenceIso,
    localKey,
    triggerId: `local:${schedule.id}:${localKey}`,
    idempotencyKey: `schedule:${schedule.id}:${localKey}`,
  };
}

function localMinuteKey(date: Date, timezone: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}[${timezone}]`;
}

function matchesRequestedWallClock(
  interval: ReturnType<typeof CronExpressionParser.parse>,
  candidate: CronDate,
): boolean {
  const minutes: readonly number[] = interval.fields.minute.values;
  const hours: readonly number[] = interval.fields.hour.values;
  return minutes.includes(candidate.getMinutes())
    && hours.includes(candidate.getHours());
}

function validDate(value: Date | string, label: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`${label} must be a valid date`);
  }
  return date;
}

function addUtcYears(date: Date, years: number): Date {
  const result = new Date(date);
  result.setUTCFullYear(result.getUTCFullYear() + years);
  return result;
}

function isRangeExhaustion(error: unknown): boolean {
  return error instanceof Error && /time span range/i.test(error.message);
}
