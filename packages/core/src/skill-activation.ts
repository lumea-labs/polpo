/** Maximum number of skills that a caller may explicitly activate per run. */
export const MAX_ACTIVATED_SKILLS = 16;

/** Maximum length of a skill identifier accepted by runtime surfaces. */
export const MAX_ACTIVATED_SKILL_NAME_LENGTH = 256;

/** Immutable skill identity frozen at outer-run admission. */
export interface ActivatedSkillReference {
  name: string;
  /** Absent only for legacy hosts that have not wired a content-addressed store. */
  digest?: string;
}

/** Reject malformed persisted or host-resolved activation snapshots. */
export function normalizeActivatedSkillReferences(value: unknown): ActivatedSkillReference[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ACTIVATED_SKILLS) {
    throw new SkillActivationError("Activated skill references are invalid");
  }
  const seen = new Set<string>();
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new SkillActivationError(`Activated skill reference at index ${index} must be an object`);
    }
    const name = (item as { name?: unknown }).name;
    const digest = (item as { digest?: unknown }).digest;
    if (typeof name !== "string" || name.length === 0 || name.length > MAX_ACTIVATED_SKILL_NAME_LENGTH) {
      throw new SkillActivationError(`Activated skill reference at index ${index} has an invalid name`);
    }
    if (digest !== undefined && (typeof digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(digest))) {
      throw new SkillActivationError(`Activated skill reference "${name}" has an invalid digest`);
    }
    if (seen.has(name)) throw new SkillActivationError(`Duplicate activated skill reference: ${name}`);
    seen.add(name);
    return digest === undefined ? { name } : { name, digest };
  });
}

export class SkillActivationError extends Error {
  readonly code = "skill_activation_invalid";

  constructor(message: string) {
    super(message);
    this.name = "SkillActivationError";
  }
}

/**
 * Normalize the additive skill selection shared by chat, Tasks and Schedules.
 * Undefined means "no explicit activation"; an explicit empty array is invalid.
 */
export function normalizeActivatedSkills(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ACTIVATED_SKILLS) {
    throw new SkillActivationError(
      `Activated skills must contain between 1 and ${MAX_ACTIVATED_SKILLS} names`,
    );
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string") {
      throw new SkillActivationError(`Activated skill at index ${index} must be a string`);
    }
    const name = item.trim();
    if (name.length === 0 || name.length > MAX_ACTIVATED_SKILL_NAME_LENGTH) {
      throw new SkillActivationError(
        `Activated skill at index ${index} must contain between 1 and ${MAX_ACTIVATED_SKILL_NAME_LENGTH} characters`,
      );
    }
    if (seen.has(name)) {
      throw new SkillActivationError(`Duplicate activated skill: ${name}`);
    }
    seen.add(name);
    normalized.push(name);
  }
  return normalized;
}

/** Validate that explicit activation cannot grant a skill the agent was not assigned. */
export function requireAssignedActivatedSkills(
  requested: unknown,
  assigned: readonly string[] | undefined,
): string[] | undefined {
  const normalized = normalizeActivatedSkills(requested);
  if (!normalized) return undefined;
  const assignedNames = new Set(
    (assigned ?? []).filter((name): name is string => typeof name === "string"),
  );
  const missing = normalized.find((name) => !assignedNames.has(name));
  if (missing) {
    throw new SkillActivationError(
      `Skill "${missing}" is not assigned to the selected agent`,
    );
  }
  return normalized;
}
