import type {
  LegacyMissionScheduleInput,
  NormalizedCreateScheduleInput,
  ScheduleCatchUpPolicy,
  ScheduleExecutionOptions,
  ScheduleInvocation,
  ScheduleJsonValue,
  ScheduleMessage,
  ScheduleMetadata,
  SchedulePolicy,
  ScheduleTiming,
  UpdateScheduleInput,
} from "./types.js";

export const SCHEDULE_LIMITS = Object.freeze({
  idLength: 256,
  nameLength: 200,
  descriptionLength: 2_000,
  promptLength: 128_000,
  messageCount: 100,
  metadataBytes: 16_384,
  metadataDepth: 12,
  metadataNodes: 1_000,
  maxConcurrency: 100,
  maxMisfireGraceSeconds: 7 * 24 * 60 * 60,
});

const DEFAULT_POLICY: SchedulePolicy = Object.freeze({
  catchUp: "skip",
  misfireGraceSeconds: 300,
  maxConcurrency: 1,
});

const ISO_TIMESTAMP_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

const CRON_FIELD_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

const FORBIDDEN_JSON_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export interface NormalizeScheduleOptions {
  now?: Date | string;
  allowPastOnce?: boolean;
}

export interface TranslateLegacyScheduleOptions extends NormalizeScheduleOptions {
  timezone?: string;
}

export function normalizeCronExpression(value: unknown): string {
  const expression = requiredString(value, "Schedule cron expression", 512);
  const fields = expression.split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `Invalid schedule cron expression: expected 5 fields, got ${fields.length}`,
    );
  }

  fields.forEach((field, index) => {
    validateCronField(field, CRON_FIELD_RANGES[index][0], CRON_FIELD_RANGES[index][1]);
  });

  return fields.join(" ");
}

export function normalizeScheduleTiming(
  value: unknown,
  options: NormalizeScheduleOptions = {},
): ScheduleTiming {
  const timing = record(value, "Schedule timing");
  const kind = timing.kind;

  if (kind === "cron") {
    assertKnownKeys(timing, ["kind", "expression", "timezone"], "Schedule cron timing");
    return {
      kind,
      expression: normalizeCronExpression(timing.expression),
      timezone: normalizeTimezone(timing.timezone),
    };
  }

  if (kind === "once") {
    assertKnownKeys(timing, ["kind", "at", "timezone"], "Schedule once timing");
    const at = normalizeTimestamp(timing.at, "Schedule once timing at");
    const now = normalizeNow(options.now);
    if (!options.allowPastOnce && Date.parse(at) <= now.getTime()) {
      throw new Error("Schedule once timing must be in the future");
    }
    return {
      kind,
      at,
      timezone: normalizeTimezone(timing.timezone),
    };
  }

  throw new Error('Schedule timing kind must be "cron" or "once"');
}

export function normalizeScheduleInvocation(value: unknown): ScheduleInvocation {
  const invocation = record(value, "Schedule invocation");

  switch (invocation.surface) {
    case "agent":
      return normalizeAgentInvocation(invocation);
    case "task":
      return normalizeTaskInvocation(invocation);
    case "channel":
      return normalizeChannelInvocation(invocation);
    case "webhook":
      return normalizeWebhookInvocation(invocation);
    case "legacy_mission":
      return normalizeLegacyMissionInvocation(invocation);
    default:
      throw new Error(
        "Schedule invocation surface must be agent, task, channel, webhook, or legacy_mission",
      );
  }
}

export function normalizeCreateScheduleInput(
  value: unknown,
  options: NormalizeScheduleOptions = {},
): NormalizedCreateScheduleInput {
  const input = record(value, "Schedule create input");
  assertKnownKeys(
    input,
    ["id", "name", "description", "timing", "invocation", "status", "policy", "metadata"],
    "Schedule create input",
  );

  const status = input.status ?? "active";
  if (status !== "active" && status !== "paused") {
    throw new Error('Schedule create status must be "active" or "paused"');
  }

  const normalized: NormalizedCreateScheduleInput = {
    timing: normalizeScheduleTiming(input.timing, options),
    invocation: normalizeScheduleInvocation(input.invocation),
    status,
    policy: normalizeCompletePolicy(input.policy),
    metadata: normalizeMetadata(input.metadata, "Schedule metadata"),
  };

  if (input.id !== undefined) {
    normalized.id = requiredString(input.id, "Schedule id", SCHEDULE_LIMITS.idLength);
  }
  if (input.name !== undefined) {
    normalized.name = requiredString(input.name, "Schedule name", SCHEDULE_LIMITS.nameLength);
  }
  if (input.description !== undefined) {
    normalized.description = requiredString(
      input.description,
      "Schedule description",
      SCHEDULE_LIMITS.descriptionLength,
    );
  }

  return normalized;
}

export function normalizeUpdateScheduleInput(
  value: unknown,
  options: NormalizeScheduleOptions = {},
): UpdateScheduleInput {
  const input = record(value, "Schedule update input");
  assertKnownKeys(
    input,
    ["name", "description", "timing", "invocation", "status", "policy", "metadata"],
    "Schedule update input",
  );
  if (Object.keys(input).length === 0) {
    throw new Error("Schedule update must include at least one field");
  }

  const normalized: UpdateScheduleInput = {};

  if (input.name !== undefined) {
    normalized.name = input.name === null
      ? null
      : requiredString(input.name, "Schedule name", SCHEDULE_LIMITS.nameLength);
  }
  if (input.description !== undefined) {
    normalized.description = input.description === null
      ? null
      : requiredString(
        input.description,
        "Schedule description",
        SCHEDULE_LIMITS.descriptionLength,
      );
  }
  if (input.timing !== undefined) {
    normalized.timing = normalizeScheduleTiming(input.timing, options);
  }
  if (input.invocation !== undefined) {
    normalized.invocation = normalizeScheduleInvocation(input.invocation);
  }
  if (input.status !== undefined) {
    if (
      input.status !== "active"
      && input.status !== "paused"
      && input.status !== "completed"
    ) {
      throw new Error(
        'Schedule update status must be "active", "paused", or "completed"',
      );
    }
    normalized.status = input.status;
  }
  if (input.policy !== undefined) {
    normalized.policy = normalizePartialPolicy(input.policy);
  }
  if (input.metadata !== undefined) {
    normalized.metadata = normalizeMetadata(input.metadata, "Schedule metadata");
  }

  return normalized;
}

export function translateLegacyMissionSchedule(
  value: unknown,
  options: TranslateLegacyScheduleOptions = {},
): NormalizedCreateScheduleInput {
  const input = record(value, "Legacy mission schedule");
  assertKnownKeys(
    input,
    ["missionId", "expression", "recurring", "endDate"],
    "Legacy mission schedule",
  );

  const missionId = requiredString(
    input.missionId,
    "Legacy mission schedule missionId",
    SCHEDULE_LIMITS.idLength,
  );
  const expression = requiredString(
    input.expression,
    "Legacy mission schedule expression",
    512,
  );
  const recurring = input.recurring ?? false;
  if (typeof recurring !== "boolean") {
    throw new Error("Legacy mission schedule recurring must be a boolean");
  }
  const timezone = normalizeTimezone(options.timezone ?? "UTC");

  let timing: ScheduleTiming;
  try {
    timing = {
      kind: "cron",
      expression: normalizeCronExpression(expression),
      timezone,
    };
  } catch (cronError) {
    if (!ISO_TIMESTAMP_WITH_OFFSET.test(expression)) {
      throw new Error(
        `Legacy mission schedule expression must be a valid cron or absolute ISO timestamp: ${errorMessage(cronError)}`,
      );
    }
    if (recurring) {
      throw new Error("A recurring legacy mission schedule requires a cron expression");
    }
    timing = normalizeScheduleTiming(
      { kind: "once", at: expression, timezone },
      options,
    );
  }

  const compatibility: Record<string, ScheduleJsonValue> = {
    source: "mission-v1",
    recurring,
    deprecated: true,
  };
  if (timing.kind === "cron" && !recurring) {
    compatibility.maxOccurrences = 1;
  }
  if (input.endDate !== undefined) {
    const endDate = normalizeTimestamp(
      input.endDate,
      "Legacy mission schedule endDate",
    );
    if (Date.parse(endDate) <= normalizeNow(options.now).getTime()) {
      throw new Error("Legacy mission schedule endDate must be in the future");
    }
    compatibility.endDate = endDate;
  }

  return normalizeCreateScheduleInput({
    name: `Mission ${missionId} schedule`,
    timing,
    invocation: {
      surface: "legacy_mission",
      missionId,
    },
    status: "active",
    policy: DEFAULT_POLICY,
    metadata: { compatibility },
  }, options);
}

function normalizeAgentInvocation(
  invocation: Record<string, unknown>,
): ScheduleInvocation {
  assertKnownKeys(
    invocation,
    ["surface", "agentName", "input", "session", "execution"],
    "Schedule agent invocation",
  );
  const input = record(invocation.input, "Schedule agent input");
  assertKnownKeys(input, ["prompt", "messages"], "Schedule agent input");

  const hasPrompt = input.prompt !== undefined;
  const hasMessages = input.messages !== undefined;
  if (hasPrompt === hasMessages) {
    throw new Error("Schedule agent input requires prompt or messages, but not both");
  }

  const normalizedInput: { prompt?: string; messages?: ScheduleMessage[] } = {};
  if (hasPrompt) {
    normalizedInput.prompt = requiredString(
      input.prompt,
      "Schedule agent prompt",
      SCHEDULE_LIMITS.promptLength,
    );
  } else {
    normalizedInput.messages = normalizeMessages(input.messages);
  }

  const normalized: ScheduleInvocation = {
    surface: "agent",
    agentName: requiredString(
      invocation.agentName,
      "Schedule agent invocation agentName",
      SCHEDULE_LIMITS.idLength,
    ),
    input: normalizedInput,
  };
  if (invocation.session !== undefined) {
    normalized.session = normalizeSession(invocation.session);
  }
  if (invocation.execution !== undefined) {
    normalized.execution = normalizeExecution(invocation.execution);
  }
  return normalized;
}

function normalizeTaskInvocation(
  invocation: Record<string, unknown>,
): ScheduleInvocation {
  assertKnownKeys(
    invocation,
    ["surface", "agentName", "title", "prompt", "userId", "metadata", "execution"],
    "Schedule task invocation",
  );
  const normalized: ScheduleInvocation = {
    surface: "task",
    agentName: requiredString(
      invocation.agentName,
      "Schedule task invocation agentName",
      SCHEDULE_LIMITS.idLength,
    ),
    title: requiredString(invocation.title, "Schedule task title", SCHEDULE_LIMITS.nameLength),
    prompt: requiredString(
      invocation.prompt,
      "Schedule task prompt",
      SCHEDULE_LIMITS.promptLength,
    ),
  };
  if (invocation.userId !== undefined) {
    normalized.userId = requiredString(
      invocation.userId,
      "Schedule task userId",
      SCHEDULE_LIMITS.idLength,
    );
  }
  if (invocation.metadata !== undefined) {
    normalized.metadata = normalizeMetadata(
      invocation.metadata,
      "Schedule task metadata",
    );
  }
  if (invocation.execution !== undefined) {
    normalized.execution = normalizeExecution(invocation.execution);
  }
  return normalized;
}

function normalizeChannelInvocation(
  invocation: Record<string, unknown>,
): ScheduleInvocation {
  const sharedKeys = [
    "surface",
    "channelId",
    "routeId",
    "externalThreadId",
    "mode",
    "metadata",
  ];
  const channelId = requiredString(
    invocation.channelId,
    "Schedule channel invocation channelId",
    SCHEDULE_LIMITS.idLength,
  );
  const shared = {
    channelId,
    ...(invocation.routeId === undefined
      ? {}
      : {
          routeId: requiredString(
            invocation.routeId,
            "Schedule channel invocation routeId",
            SCHEDULE_LIMITS.idLength,
          ),
        }),
    ...(invocation.externalThreadId === undefined
      ? {}
      : {
          externalThreadId: requiredString(
            invocation.externalThreadId,
            "Schedule channel invocation externalThreadId",
            SCHEDULE_LIMITS.idLength,
          ),
        }),
    ...(invocation.metadata === undefined
      ? {}
      : {
          metadata: normalizeMetadata(
            invocation.metadata,
            "Schedule channel metadata",
          ),
        }),
  };

  if (invocation.mode === "send") {
    assertKnownKeys(
      invocation,
      [...sharedKeys, "text"],
      "Schedule channel send invocation",
    );
    return {
      surface: "channel",
      ...shared,
      mode: "send",
      text: requiredString(
        invocation.text,
        "Schedule channel send text",
        SCHEDULE_LIMITS.promptLength,
      ),
    };
  }

  if (invocation.mode === "agent_reply") {
    assertKnownKeys(
      invocation,
      [...sharedKeys, "agentName", "prompt", "execution"],
      "Schedule channel agent_reply invocation",
    );
    return {
      surface: "channel",
      ...shared,
      mode: "agent_reply",
      agentName: requiredString(
        invocation.agentName,
        "Schedule channel agent_reply agentName",
        SCHEDULE_LIMITS.idLength,
      ),
      prompt: requiredString(
        invocation.prompt,
        "Schedule channel agent_reply prompt",
        SCHEDULE_LIMITS.promptLength,
      ),
      ...(invocation.execution === undefined
        ? {}
        : { execution: normalizeExecution(invocation.execution) }),
    };
  }

  throw new Error('Schedule channel invocation mode must be "send" or "agent_reply"');
}

function normalizeWebhookInvocation(
  invocation: Record<string, unknown>,
): ScheduleInvocation {
  assertKnownKeys(
    invocation,
    ["surface", "webhookId", "payload"],
    "Schedule webhook invocation",
  );
  return {
    surface: "webhook",
    webhookId: requiredString(
      invocation.webhookId,
      "Schedule webhook invocation webhookId",
      SCHEDULE_LIMITS.idLength,
    ),
    ...(invocation.payload === undefined
      ? {}
      : {
          payload: normalizeMetadata(
            invocation.payload,
            "Schedule webhook payload",
          ),
        }),
  };
}

function normalizeLegacyMissionInvocation(
  invocation: Record<string, unknown>,
): ScheduleInvocation {
  assertKnownKeys(
    invocation,
    ["surface", "missionId"],
    "Schedule legacy mission invocation",
  );
  return {
    surface: "legacy_mission",
    missionId: requiredString(
      invocation.missionId,
      "Schedule legacy mission invocation missionId",
      SCHEDULE_LIMITS.idLength,
    ),
  };
}

function normalizeMessages(value: unknown): ScheduleMessage[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Schedule agent messages must be a non-empty array");
  }
  if (value.length > SCHEDULE_LIMITS.messageCount) {
    throw new Error(
      `Schedule agent messages supports at most ${SCHEDULE_LIMITS.messageCount} entries`,
    );
  }

  return value.map((item, index) => {
    const message = record(item, `Schedule agent message ${index}`);
    assertKnownKeys(message, ["role", "content"], `Schedule agent message ${index}`);
    if (
      message.role !== "system"
      && message.role !== "user"
      && message.role !== "assistant"
    ) {
      throw new Error(
        `Schedule agent message ${index} role must be system, user, or assistant`,
      );
    }
    return {
      role: message.role,
      content: requiredString(
        message.content,
        `Schedule agent message ${index} content`,
        SCHEDULE_LIMITS.promptLength,
      ),
    };
  });
}

function normalizeSession(value: unknown): {
  mode: "new" | "reuse";
  sessionId?: string;
  userId?: string;
} {
  const session = record(value, "Schedule agent session");
  assertKnownKeys(session, ["mode", "sessionId", "userId"], "Schedule agent session");
  if (session.mode !== "new" && session.mode !== "reuse") {
    throw new Error('Schedule agent session mode must be "new" or "reuse"');
  }
  if (session.mode === "new" && session.sessionId !== undefined) {
    throw new Error("A new session cannot include sessionId");
  }
  if (session.mode === "reuse" && session.sessionId === undefined) {
    throw new Error("A reused session requires sessionId");
  }
  return {
    mode: session.mode,
    ...(session.sessionId === undefined
      ? {}
      : {
          sessionId: requiredString(
            session.sessionId,
            "Schedule agent sessionId",
            SCHEDULE_LIMITS.idLength,
          ),
        }),
    ...(session.userId === undefined
      ? {}
      : {
          userId: requiredString(
            session.userId,
            "Schedule agent session userId",
            SCHEDULE_LIMITS.idLength,
          ),
        }),
  };
}

function normalizeExecution(value: unknown): ScheduleExecutionOptions {
  const execution = record(value, "Schedule execution options");
  assertKnownKeys(
    execution,
    ["loop", "model", "sandbox", "guardrails", "metadata"],
    "Schedule execution options",
  );
  const normalized: ScheduleExecutionOptions = {};

  if (execution.loop !== undefined) {
    normalized.loop = requiredString(
      execution.loop,
      "Schedule execution loop",
      SCHEDULE_LIMITS.idLength,
    );
  }
  if (execution.model !== undefined) {
    normalized.model = requiredString(
      execution.model,
      "Schedule execution model",
      SCHEDULE_LIMITS.idLength,
    );
  }
  if (execution.sandbox !== undefined) {
    const sandbox = record(execution.sandbox, "Schedule execution sandbox");
    assertKnownKeys(sandbox, ["isolation", "lifecycle"], "Schedule execution sandbox");
    if (
      sandbox.isolation !== undefined
      && sandbox.isolation !== "reuse"
      && sandbox.isolation !== "fresh"
      && sandbox.isolation !== "shared"
    ) {
      throw new Error('Schedule sandbox isolation must be "reuse", "fresh", or "shared"');
    }
    let lifecycle: {
      onRelease?: "pool" | "destroy";
      idleTtlMinutes?: number;
    } | undefined;
    if (sandbox.lifecycle !== undefined) {
      const rawLifecycle = record(
        sandbox.lifecycle,
        "Schedule execution sandbox lifecycle",
      );
      assertKnownKeys(
        rawLifecycle,
        ["onRelease", "idleTtlMinutes"],
        "Schedule execution sandbox lifecycle",
      );
      if (
        rawLifecycle.onRelease !== undefined
        && rawLifecycle.onRelease !== "pool"
        && rawLifecycle.onRelease !== "destroy"
      ) {
        throw new Error('Schedule sandbox lifecycle onRelease must be "pool" or "destroy"');
      }
      const idleTtlMinutes = rawLifecycle.idleTtlMinutes;
      if (idleTtlMinutes !== undefined && (
        typeof idleTtlMinutes !== "number"
        || !Number.isInteger(idleTtlMinutes)
        || idleTtlMinutes < 1
        || idleTtlMinutes > 10_080
      )) {
        throw new Error("Schedule sandbox lifecycle idleTtlMinutes must be an integer between 1 and 10080");
      }
      if (
        rawLifecycle.onRelease === "destroy"
        && idleTtlMinutes !== undefined
      ) {
        throw new Error("Schedule sandbox lifecycle idleTtlMinutes cannot be used with onRelease=destroy");
      }
      lifecycle = {
        ...(rawLifecycle.onRelease === undefined
          ? {}
          : { onRelease: rawLifecycle.onRelease }),
        ...(idleTtlMinutes === undefined
          ? {}
          : { idleTtlMinutes }),
      };
    }
    normalized.sandbox = {
      ...(sandbox.isolation === undefined ? {} : { isolation: sandbox.isolation }),
      ...(lifecycle === undefined ? {} : { lifecycle }),
    };
  }
  if (execution.guardrails !== undefined) {
    const guardrails = record(
      execution.guardrails,
      "Schedule execution guardrails",
    );
    assertKnownKeys(guardrails, ["mode"], "Schedule execution guardrails");
    normalized.guardrails = {
      ...(guardrails.mode === undefined
        ? {}
        : {
            mode: requiredString(
              guardrails.mode,
              "Schedule guardrails mode",
              SCHEDULE_LIMITS.idLength,
            ),
          }),
    };
  }
  if (execution.metadata !== undefined) {
    normalized.metadata = normalizeMetadata(
      execution.metadata,
      "Schedule execution metadata",
    );
  }

  return normalized;
}

function normalizeCompletePolicy(value: unknown): SchedulePolicy {
  if (value === undefined) return { ...DEFAULT_POLICY };
  const partial = normalizePartialPolicy(value);
  return {
    catchUp: partial.catchUp ?? DEFAULT_POLICY.catchUp,
    misfireGraceSeconds:
      partial.misfireGraceSeconds ?? DEFAULT_POLICY.misfireGraceSeconds,
    maxConcurrency: partial.maxConcurrency ?? DEFAULT_POLICY.maxConcurrency,
  };
}

function normalizePartialPolicy(value: unknown): Partial<SchedulePolicy> {
  const policy = record(value, "Schedule policy");
  assertKnownKeys(
    policy,
    ["catchUp", "misfireGraceSeconds", "maxConcurrency"],
    "Schedule policy",
  );
  if (Object.keys(policy).length === 0) {
    throw new Error("Schedule policy must include at least one field");
  }
  const normalized: Partial<SchedulePolicy> = {};

  if (policy.catchUp !== undefined) {
    if (policy.catchUp !== "skip" && policy.catchUp !== "latest") {
      throw new Error('Schedule policy catchUp must be "skip" or "latest"');
    }
    normalized.catchUp = policy.catchUp as ScheduleCatchUpPolicy;
  }
  if (policy.misfireGraceSeconds !== undefined) {
    normalized.misfireGraceSeconds = boundedInteger(
      policy.misfireGraceSeconds,
      "Schedule policy misfireGraceSeconds",
      0,
      SCHEDULE_LIMITS.maxMisfireGraceSeconds,
    );
  }
  if (policy.maxConcurrency !== undefined) {
    normalized.maxConcurrency = boundedInteger(
      policy.maxConcurrency,
      "Schedule policy maxConcurrency",
      1,
      SCHEDULE_LIMITS.maxConcurrency,
    );
  }
  return normalized;
}

function normalizeMetadata(value: unknown, label: string): ScheduleMetadata {
  if (value === undefined) return {};
  const root = record(value, label);
  const state = {
    nodes: 0,
    seen: new Set<object>(),
  };
  const cloned = cloneJson(root, label, 0, state) as ScheduleMetadata;
  const serialized = JSON.stringify(cloned);
  if (new TextEncoder().encode(serialized).byteLength > SCHEDULE_LIMITS.metadataBytes) {
    throw new Error(
      `${label} exceeds the ${SCHEDULE_LIMITS.metadataBytes}-byte metadata limit`,
    );
  }
  return cloned;
}

export function normalizeScheduleMetadata(
  value: unknown,
  label = "Schedule metadata",
): ScheduleMetadata {
  return normalizeMetadata(value, label);
}

function cloneJson(
  value: unknown,
  label: string,
  depth: number,
  state: { nodes: number; seen: Set<object> },
): ScheduleJsonValue {
  state.nodes += 1;
  if (state.nodes > SCHEDULE_LIMITS.metadataNodes) {
    throw new Error(`${label} exceeds the metadata node limit`);
  }
  if (depth > SCHEDULE_LIMITS.metadataDepth) {
    throw new Error(`${label} exceeds the metadata depth limit`);
  }

  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${label} metadata numbers must be finite`);
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new Error(`${label} must contain only JSON-serializable metadata`);
  }
  if (state.seen.has(value)) {
    throw new Error(`${label} cannot contain cyclic metadata`);
  }
  state.seen.add(value);

  try {
    if (Array.isArray(value)) {
      const result: ScheduleJsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throw new Error(`${label} cannot contain sparse metadata arrays`);
        }
        result.push(cloneJson(value[index], label, depth + 1, state));
      }
      return result;
    }

    if (!isPlainRecord(value)) {
      throw new Error(`${label} must contain only plain metadata objects`);
    }
    const result: Record<string, ScheduleJsonValue> = {};
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_JSON_KEYS.has(key)) {
        throw new Error(`${label} key ${key} is not allowed in metadata`);
      }
      result[key] = cloneJson(child, label, depth + 1, state);
    }
    return result;
  } finally {
    state.seen.delete(value);
  }
}

function validateCronField(field: string, min: number, max: number): void {
  if (!field || field.startsWith(",") || field.endsWith(",") || field.includes(",,")) {
    throw new Error(`Invalid schedule cron field "${field}"`);
  }
  for (const item of field.split(",")) {
    const slashParts = item.split("/");
    if (slashParts.length > 2 || !slashParts[0]) {
      throw new Error(`Invalid schedule cron field "${field}"`);
    }
    if (slashParts.length === 2) {
      if (!/^\d+$/.test(slashParts[1])) {
        throw new Error(`Invalid schedule cron step in "${field}"`);
      }
      const step = Number(slashParts[1]);
      if (!Number.isSafeInteger(step) || step <= 0) {
        throw new Error(`Invalid schedule cron step in "${field}"`);
      }
    }

    const base = slashParts[0];
    if (base === "*") continue;

    const rangeParts = base.split("-");
    if (rangeParts.length > 2 || rangeParts.some((part) => !/^\d+$/.test(part))) {
      throw new Error(`Invalid schedule cron value in "${field}"`);
    }
    const start = Number(rangeParts[0]);
    const end = rangeParts.length === 2 ? Number(rangeParts[1]) : start;
    if (
      !Number.isSafeInteger(start)
      || !Number.isSafeInteger(end)
      || start < min
      || start > max
      || end < min
      || end > max
      || start > end
    ) {
      throw new Error(`Invalid schedule cron range in "${field}"`);
    }
  }
}

function normalizeTimezone(value: unknown): string {
  const timezone = requiredString(value, "Schedule timezone", 100);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(
      new Date("2026-01-01T00:00:00.000Z"),
    );
  } catch {
    throw new Error(`Invalid schedule timezone "${timezone}"`);
  }
  return timezone;
}

function normalizeTimestamp(value: unknown, label: string): string {
  const timestamp = requiredString(value, label, 100);
  if (!ISO_TIMESTAMP_WITH_OFFSET.test(timestamp)) {
    throw new Error(`${label} must include an explicit UTC or numeric offset`);
  }
  const parsed = new Date(timestamp);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`${label} must be a valid absolute ISO timestamp`);
  }
  return parsed.toISOString();
}

function normalizeNow(value: Date | string | undefined): Date {
  const now = value === undefined ? new Date() : new Date(value);
  if (!Number.isFinite(now.getTime())) {
    throw new Error("Schedule validation now must be a valid date");
  }
  return now;
}

function boundedInteger(
  value: unknown,
  label: string,
  min: number,
  max: number,
): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return value as number;
}

function requiredString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} cannot be empty`);
  }
  if (normalized.length > maxLength) {
    throw new Error(`${label} exceeds the ${maxLength}-character limit`);
  }
  return normalized;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw new Error(`${label} contains unsupported field "${key}"`);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
