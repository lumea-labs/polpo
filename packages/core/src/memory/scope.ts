import { MemoryContractError } from "./errors.js";
import {
  MEMORY_SCOPE_KINDS,
  type MemoryScope,
  type MemoryScopeAccess,
  type MemoryScopeKind,
} from "./types.js";

const scopeKinds = new Set<string>(MEMORY_SCOPE_KINDS);
const MAX_SCOPE_IDENTIFIER_CHARACTERS = 512;
const MAX_AGENT_NAME_CHARACTERS = 128;

function requiredIdentifier(
  value: unknown,
  path: string,
  max = MAX_SCOPE_IDENTIFIER_CHARACTERS,
): string {
  if (typeof value !== "string") {
    throw new MemoryContractError(
      `${path} must be a non-empty string`,
      "invalid_scope",
      path,
    );
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > max) {
    throw new MemoryContractError(
      `${path} must contain between 1 and ${max} characters`,
      "invalid_scope",
      path,
    );
  }
  return normalized;
}

export function normalizeMemoryScope(value: unknown): MemoryScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MemoryContractError(
      "Memory scope must be an object",
      "invalid_scope",
      "scope",
    );
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.kind !== "string" || !scopeKinds.has(candidate.kind)) {
    throw new MemoryContractError(
      `Unknown Memory scope kind: ${String(candidate.kind)}`,
      "invalid_scope",
      "scope.kind",
    );
  }
  const kind = candidate.kind as MemoryScopeKind;

  if (kind === "agent") {
    return Object.freeze({
      kind,
      agentName: requiredIdentifier(
        candidate.agentName,
        "scope.agentName",
        MAX_AGENT_NAME_CHARACTERS,
      ),
    });
  }

  const subjectId = requiredIdentifier(candidate.subjectId, "scope.subjectId");
  if (kind === "user" && candidate.agentName !== undefined) {
    return Object.freeze({
      kind,
      subjectId,
      agentName: requiredIdentifier(
        candidate.agentName,
        "scope.agentName",
        MAX_AGENT_NAME_CHARACTERS,
      ),
    });
  }
  return Object.freeze({ kind, subjectId });
}

export function memoryScopeKey(scope: MemoryScope): string {
  const normalized = normalizeMemoryScope(scope);
  return JSON.stringify([
    normalized.kind,
    normalized.subjectId ?? "",
    normalized.agentName ?? "",
  ]);
}

export function canAccessMemoryScope(
  scope: MemoryScope,
  access: MemoryScopeAccess,
): boolean {
  const normalized = normalizeMemoryScope(scope);
  switch (normalized.kind) {
    case "org":
      return normalized.subjectId === access.orgId;
    case "project":
      return normalized.subjectId === access.projectId;
    case "agent":
      return normalized.agentName === access.agentName;
    case "user":
      return (
        normalized.subjectId === access.externalUserId
        && (
          normalized.agentName === undefined
          || normalized.agentName === access.agentName
        )
      );
    case "channel":
      return normalized.subjectId === access.channelId;
    case "session":
      return normalized.subjectId === access.sessionId;
  }
}
