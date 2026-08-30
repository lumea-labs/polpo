import type { SessionContinuationScope } from "./session-continuation.js";

export const CANONICAL_TURN_SURFACES = ["chat", "channel"] as const;
export type CanonicalTurnSurface = (typeof CANONICAL_TURN_SURFACES)[number];

export const CANONICAL_TURN_TERMINAL_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
  "waiting",
] as const;
export type CanonicalTurnTerminalStatus =
  (typeof CANONICAL_TURN_TERMINAL_STATUSES)[number];

export interface CanonicalVisibleMessageRef {
  readonly id: string;
  readonly role: "user" | "assistant";
}

export interface CanonicalTurnInvocationIdentity {
  readonly externalUserId?: string;
  readonly channelId?: string;
  readonly scope?: SessionContinuationScope;
}

export interface CanonicalTurnLearningPolicy {
  readonly mode: "suggest" | "automatic";
  readonly surfaces: readonly ("chat" | "channel")[];
  readonly kinds: readonly (
    | "fact"
    | "preference"
    | "open_thread"
    | "style"
    | "failure_pattern"
    | "successful_episode"
    | "procedure_hint"
  )[];
}

export interface CanonicalTurnCommitted {
  readonly turnId: string;
  readonly requestId?: string;
  readonly runId?: string;
  readonly sessionId: string;
  readonly agentName: string;
  readonly surface: CanonicalTurnSurface;
  readonly terminalStatus: CanonicalTurnTerminalStatus;
  readonly userMessage: CanonicalVisibleMessageRef;
  readonly assistantMessage?: CanonicalVisibleMessageRef;
  readonly trustedInvocation: CanonicalTurnInvocationIdentity;
  /** Immutable learning policy selected when the turn began. */
  readonly learningPolicy?: CanonicalTurnLearningPolicy;
  readonly occurredAt: string;
}

const surfaces = new Set<string>(CANONICAL_TURN_SURFACES);
const statuses = new Set<string>(CANONICAL_TURN_TERMINAL_STATUSES);
const MAX_REFERENCE_LENGTH = 512;

export function normalizeCanonicalTurnCommitted(
  value: CanonicalTurnCommitted,
): CanonicalTurnCommitted {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("canonical turn must be an object");
  }
  const surface = requiredEnum(value.surface, surfaces, "surface");
  const terminalStatus = requiredEnum(
    value.terminalStatus,
    statuses,
    "terminalStatus",
  );
  const occurredAt = timestamp(value.occurredAt, "occurredAt");
  const userMessage = messageRef(value.userMessage, "user", "userMessage");
  const assistantMessage = value.assistantMessage === undefined
    ? undefined
    : messageRef(value.assistantMessage, "assistant", "assistantMessage");
  if (terminalStatus === "succeeded" && !assistantMessage) {
    throw new TypeError("succeeded canonical turns require an assistant message");
  }
  const trustedInvocation = invocationIdentity(value.trustedInvocation);
  const learningPolicy = value.learningPolicy === undefined
    ? undefined
    : normalizeLearningPolicy(value.learningPolicy);
  return Object.freeze({
    turnId: requiredText(value.turnId, "turnId"),
    ...(value.requestId ? { requestId: requiredText(value.requestId, "requestId") } : {}),
    ...(value.runId ? { runId: requiredText(value.runId, "runId") } : {}),
    sessionId: requiredText(value.sessionId, "sessionId"),
    agentName: requiredText(value.agentName, "agentName"),
    surface: surface as CanonicalTurnSurface,
    terminalStatus: terminalStatus as CanonicalTurnTerminalStatus,
    userMessage,
    ...(assistantMessage ? { assistantMessage } : {}),
    trustedInvocation,
    ...(learningPolicy ? { learningPolicy } : {}),
    occurredAt,
  });
}

function normalizeLearningPolicy(value: CanonicalTurnLearningPolicy): CanonicalTurnLearningPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("learningPolicy must be an object");
  }
  if (value.mode !== "suggest" && value.mode !== "automatic") {
    throw new TypeError("learningPolicy.mode is invalid");
  }
  const allowedSurfaces = new Set(["chat", "channel"]);
  const allowedKinds = new Set([
    "fact",
    "preference",
    "open_thread",
    "style",
    "failure_pattern",
    "successful_episode",
    "procedure_hint",
  ]);
  const learningSurfaces = normalizedArray(value.surfaces, allowedSurfaces, "learningPolicy.surfaces");
  const kinds = normalizedArray(value.kinds, allowedKinds, "learningPolicy.kinds");
  return Object.freeze({
    mode: value.mode,
    surfaces: Object.freeze(learningSurfaces) as CanonicalTurnLearningPolicy["surfaces"],
    kinds: Object.freeze(kinds) as CanonicalTurnLearningPolicy["kinds"],
  });
}

function normalizedArray(
  value: readonly string[],
  allowed: ReadonlySet<string>,
  path: string,
): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${path} is invalid`);
  const normalized = [...new Set(value)];
  if (normalized.some((entry) => typeof entry !== "string" || !allowed.has(entry))) {
    throw new TypeError(`${path} is invalid`);
  }
  return normalized;
}

function messageRef(
  value: CanonicalVisibleMessageRef,
  expectedRole: CanonicalVisibleMessageRef["role"],
  path: string,
): CanonicalVisibleMessageRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  if (value.role !== expectedRole) {
    throw new TypeError(`${path}.role must be ${expectedRole}`);
  }
  return Object.freeze({ id: requiredText(value.id, `${path}.id`), role: expectedRole });
}

function invocationIdentity(
  value: CanonicalTurnInvocationIdentity,
): CanonicalTurnInvocationIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("trustedInvocation must be an object");
  }
  const scope = value.scope === undefined
    ? undefined
    : Object.freeze({
        key: requiredText(value.scope.key, "trustedInvocation.scope.key"),
        ...(value.scope.version
          ? { version: requiredText(value.scope.version, "trustedInvocation.scope.version") }
          : {}),
      });
  return Object.freeze({
    ...(value.externalUserId
      ? { externalUserId: requiredText(value.externalUserId, "trustedInvocation.externalUserId") }
      : {}),
    ...(value.channelId
      ? { channelId: requiredText(value.channelId, "trustedInvocation.channelId") }
      : {}),
    ...(scope ? { scope } : {}),
  });
}

function requiredText(value: unknown, path: string): string {
  if (typeof value !== "string") throw new TypeError(`${path} must be a string`);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > MAX_REFERENCE_LENGTH) {
    throw new TypeError(`${path} must contain between 1 and ${MAX_REFERENCE_LENGTH} characters`);
  }
  return normalized;
}

function requiredEnum(
  value: unknown,
  allowed: ReadonlySet<string>,
  path: string,
): string {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new TypeError(`${path} is invalid`);
  }
  return value;
}

function timestamp(value: unknown, path: string): string {
  if (typeof value !== "string") throw new TypeError(`${path} must be a timestamp`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${path} must be a timestamp`);
  return date.toISOString();
}
