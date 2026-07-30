import { BrainContractError } from "./errors.js";
import {
  BRAIN_SCOPE_KINDS,
  type BrainScope,
  type BrainScopeAccess,
  type BrainScopeKind,
} from "./types.js";
import { requiredText } from "./validation.js";

const scopeKinds = new Set<string>(BRAIN_SCOPE_KINDS);

export function normalizeBrainScope(value: unknown): BrainScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BrainContractError(
      "Brain scope must be an object",
      "invalid_scope",
      "scope",
    );
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.kind !== "string" || !scopeKinds.has(candidate.kind)) {
    throw new BrainContractError(
      `Unknown Brain scope kind: ${String(candidate.kind)}`,
      "invalid_scope",
      "scope.kind",
    );
  }
  return Object.freeze({
    kind: candidate.kind as BrainScopeKind,
    subjectId: requiredText(
      candidate.subjectId,
      "scope.subjectId",
      512,
      "invalid_scope",
    ),
  });
}

export function brainScopeKey(scope: BrainScope): string {
  const normalized = normalizeBrainScope(scope);
  return JSON.stringify([normalized.kind, normalized.subjectId]);
}

export function canAccessBrainScope(
  scope: BrainScope,
  access: BrainScopeAccess,
): boolean {
  const normalized = normalizeBrainScope(scope);
  return normalized.subjectId === (
    normalized.kind === "org" ? access.orgId : access.projectId
  );
}
