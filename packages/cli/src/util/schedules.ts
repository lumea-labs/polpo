import * as fs from "node:fs";
import * as path from "node:path";
import {
  nextScheduleOccurrence,
  normalizeCreateScheduleInput,
  translateLegacyMissionSchedule,
  type CreateScheduleInput,
  type NormalizedCreateScheduleInput,
  type Schedule,
} from "@polpo-ai/core";
import { listLoopSourceFiles } from "./loops.js";
import { readProjectAgents } from "@polpo-ai/file-stores";

export interface PreparedScheduleDeployment {
  file: string;
  kind: "v2" | "legacy";
  name: string;
  payload: Record<string, unknown>;
  timezone: string;
  nextOccurrenceAt: string | null;
  warnings: string[];
}

export interface PrepareScheduleDeploymentsOptions {
  now?: Date | string;
}

interface ReferenceIndex {
  agents: Set<string> | null;
  loops: Set<string> | null;
  missions: Set<string> | null;
}

/**
 * Performs an all-files preflight before the deployer sends its first request.
 * Error messages contain file names and validation failures, never file data.
 */
export function prepareScheduleDeployments(
  polpoDir: string,
  options: PrepareScheduleDeploymentsOptions = {},
): PreparedScheduleDeployment[] {
  const scheduleDir = path.join(polpoDir, "schedules");
  if (!fs.existsSync(scheduleDir)) return [];
  const files = fs.readdirSync(scheduleDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => path.join(scheduleDir, file))
    .sort();
  const references = readReferenceIndex(polpoDir);
  const prepared: PreparedScheduleDeployment[] = [];
  const errors: string[] = [];

  for (const file of files) {
    try {
      prepared.push(prepareFile(file, references, options));
    } catch (error) {
      errors.push(`${path.basename(file)}: ${errorMessage(error)}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Schedule preflight failed for ${errors.length} file(s):\n`
      + errors.map((error) => `- ${error}`).join("\n"),
    );
  }
  assertUniqueIdentities(prepared);
  return prepared;
}

/**
 * Removes operational/provider fields from a pulled Schedule so the resulting
 * file is a valid create definition and cannot persist provider identifiers.
 */
export function scheduleDefinitionForPull(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const invocation = plainRecord(value.invocation);
  const timing = plainRecord(value.timing);
  if (invocation?.surface === "legacy_mission") {
    const compatibility = plainRecord(plainRecord(value.metadata)?.compatibility);
    return compact({
      missionId: invocation.missionId,
      expression: timing?.kind === "cron" ? timing.expression : timing?.at,
      recurring: compatibility?.recurring === true,
      endDate: compatibility?.endDate,
    });
  }

  return compact({
    id: value.id,
    name: value.name,
    description: value.description,
    timing: value.timing,
    invocation: value.invocation,
    status: value.status,
    policy: value.policy,
    metadata: value.metadata,
  });
}

function prepareFile(
  file: string,
  references: ReferenceIndex,
  options: PrepareScheduleDeploymentsOptions,
): PreparedScheduleDeployment {
  const raw = readJsonObject(file);
  const legacy = "missionId" in raw || "expression" in raw;
  const normalized = legacy
    ? translateLegacyMissionSchedule(raw, { now: options.now })
    : normalizeCreateScheduleInput(raw as unknown as CreateScheduleInput, {
        now: options.now,
      });
  validateReferences(normalized, references);

  const now = validDate(options.now ?? new Date());
  const id = normalized.id ?? path.basename(file, ".json");
  const schedule: Schedule = {
    ...normalized,
    id,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    revision: 1,
  };
  const occurrence = nextScheduleOccurrence(schedule, now);
  const name = legacy
    ? String(raw.missionId ?? path.basename(file, ".json"))
    : normalized.name ?? normalized.id ?? path.basename(file, ".json");

  return {
    file,
    kind: legacy ? "legacy" : "v2",
    name,
    payload: legacy ? raw : normalized as unknown as Record<string, unknown>,
    timezone: normalized.timing.timezone,
    nextOccurrenceAt: occurrence?.occurrenceAt ?? null,
    warnings: legacy
      ? [
          `${path.basename(file)} uses the deprecated legacy mission schedule format; migrate it to a Schedules v2 invocation.`,
        ]
      : [],
  };
}

function validateReferences(
  schedule: NormalizedCreateScheduleInput,
  references: ReferenceIndex,
): void {
  const invocation = schedule.invocation;
  const agentName = invocation.surface === "agent"
    || invocation.surface === "task"
    || (invocation.surface === "channel" && invocation.mode === "agent_reply")
    ? invocation.agentName
    : undefined;
  if (
    agentName
    && references.agents
    && !references.agents.has(agentName)
  ) {
    throw new Error(`References missing local agent "${agentName}"`);
  }

  const loop = "execution" in invocation
    ? invocation.execution?.loop
    : undefined;
  if (loop && references.loops && !references.loops.has(loop)) {
    throw new Error(`References missing local loop "${loop}"`);
  }

  if (
    invocation.surface === "legacy_mission"
    && references.missions
    && !references.missions.has(invocation.missionId)
  ) {
    throw new Error(
      `References missing local mission "${invocation.missionId}"`,
    );
  }
}

function readReferenceIndex(polpoDir: string): ReferenceIndex {
  return {
    agents: readAgentNames(polpoDir),
    loops: readLoopNames(polpoDir),
    missions: readMissionNames(path.join(polpoDir, "missions")),
  };
}

function assertUniqueIdentities(
  schedules: PreparedScheduleDeployment[],
): void {
  const seen = new Map<string, string>();
  for (const schedule of schedules) {
    const id = schedule.kind === "legacy"
      ? `legacy-mission:${String(schedule.payload.missionId)}`
      : typeof schedule.payload.id === "string"
        ? schedule.payload.id
        : undefined;
    if (!id) continue;
    const previous = seen.get(id);
    if (previous) {
      throw new Error(
        `Duplicate schedule identity "${id}" in ${path.basename(previous)} and ${path.basename(schedule.file)}`,
      );
    }
    seen.set(id, schedule.file);
  }
}

function readAgentNames(polpoDir: string): Set<string> | null {
  const legacy = path.join(polpoDir, "agents.json");
  const current = path.join(polpoDir, "agents");
  if (!fs.existsSync(legacy) && !fs.existsSync(current)) return null;
  return new Set(readProjectAgents(polpoDir).map(({ agent }) => agent.name));
}

function readLoopNames(polpoDir: string): Set<string> | null {
  const dir = path.join(polpoDir, "loops");
  if (!fs.existsSync(dir)) return null;
  return new Set(
    listLoopSourceFiles(polpoDir).map((file) =>
      path.basename(file, path.extname(file))
    ),
  );
}

function readMissionNames(dir: string): Set<string> | null {
  if (!fs.existsSync(dir)) return null;
  const names = new Set<string>();
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".json"))) {
    names.add(path.basename(file, ".json"));
    try {
      const value = readJsonObject(path.join(dir, file));
      if (typeof value.id === "string" && value.id.trim()) {
        names.add(value.id.trim());
      }
    } catch {
      // Mission validation belongs to its deployer. The filename still gives
      // schedule preflight a deterministic locally-known reference.
    }
  }
  return names;
}

function readJsonObject(file: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error("Invalid JSON");
  }
  const record = plainRecord(value);
  if (!record) throw new Error("Schedule definition must be a JSON object");
  return record;
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function compact(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}

function validDate(value: Date | string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("Schedule preview clock is invalid");
  }
  return date;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown validation error";
}
