import { MAX_MODEL_FALLBACKS, normalizeModelPolicy } from "./model-policy.js";
import type {
  ModelConfig,
  ModelAllowlistEntry,
  ModelProfileReference,
  ModelProfileRegistry,
  ModelTarget,
  ProfiledModelConfig,
  ProfiledModelSelection,
} from "./types/config.js";

export const DEFAULT_MODEL_PROFILE_MAX_DEPTH = 16;
export const MODEL_PROFILE_NAME_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;

export type ModelProfileResolutionErrorCode =
  | "INVALID_SELECTION"
  | "INVALID_PROFILE_REGISTRY"
  | "INVALID_PROFILE_NAME"
  | "INVALID_ALLOWLIST"
  | "UNKNOWN_PROFILE"
  | "DISALLOWED_PROFILE"
  | "PROFILE_CYCLE"
  | "PROFILE_DEPTH_EXCEEDED"
  | "TOO_MANY_FALLBACKS"
  | "DISALLOWED_MODEL";

export class ModelProfileResolutionError extends Error {
  readonly code: ModelProfileResolutionErrorCode;
  readonly profile?: string;
  readonly model?: string;
  readonly path?: readonly string[];

  constructor(
    code: ModelProfileResolutionErrorCode,
    message: string,
    details: {
      profile?: string;
      model?: string;
      path?: readonly string[];
    } = {},
  ) {
    super(message);
    this.name = "ModelProfileResolutionError";
    this.code = code;
    this.profile = details.profile;
    this.model = details.model;
    this.path = details.path ? Object.freeze([...details.path]) : undefined;
  }
}

export interface ResolveModelProfileSelectionOptions {
  profiles?: ModelProfileRegistry;
  /**
   * Profile references the caller may select directly. Profiles referenced
   * internally by an allowed profile inherit that root grant.
   */
  allowedProfiles?: readonly string[];
  allowedModels?: readonly string[];
  maxDepth?: number;
  maxFallbacks?: number;
}

export interface ResolvedModelProfileSelection {
  readonly selection: string | ModelConfig;
  readonly policy: Readonly<{
    primary: string;
    fallbacks: readonly string[];
    candidates: readonly string[];
  }>;
  readonly profiles: readonly string[];
}

export interface ConfiguredModelProfiles {
  modelProfiles?: ModelProfileRegistry;
  modelAllowlist?: Record<string, ModelAllowlistEntry>;
}

export function resolveConfiguredModelSelection(
  selection: ProfiledModelSelection,
  settings: ConfiguredModelProfiles,
  allowedProfiles?: readonly string[],
): ResolvedModelProfileSelection {
  return resolveModelProfileSelection(selection, {
    profiles: settings.modelProfiles,
    allowedProfiles,
    allowedModels: settings.modelAllowlist
      ? Object.keys(settings.modelAllowlist)
      : undefined,
  });
}

export function isModelProfileReference(value: unknown): value is ModelProfileReference {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === "profile" && typeof value.profile === "string";
}

export function resolveModelProfileSelection(
  selection: ProfiledModelSelection,
  options: ResolveModelProfileSelectionOptions = {},
): ResolvedModelProfileSelection {
  const maxDepth = options.maxDepth ?? DEFAULT_MODEL_PROFILE_MAX_DEPTH;
  const maxFallbacks = options.maxFallbacks ?? MAX_MODEL_FALLBACKS;
  assertNonNegativeInteger(maxDepth, "Model profile depth limit");
  assertNonNegativeInteger(maxFallbacks, "Model fallback limit");

  const profiles = normalizeRegistry(options.profiles);
  const allowedProfiles = normalizeAllowlist(options.allowedProfiles, "profile");
  const allowedModels = normalizeAllowlist(options.allowedModels, "model");
  const usedProfiles: string[] = [];
  const seenProfiles = new Set<string>();

  const expandTarget = (
    target: unknown,
    path: string[],
    enforceProfileGrant: boolean,
  ): string[] => {
    if (typeof target === "string") {
      const model = target.trim();
      if (!model) {
        throw new ModelProfileResolutionError(
          "INVALID_SELECTION",
          "Model ids cannot be empty",
        );
      }
      return [model];
    }

    if (!isModelProfileReference(target)) {
      throw new ModelProfileResolutionError(
        "INVALID_SELECTION",
        "Model targets must be model ids or explicit profile references",
      );
    }

    const profile = target.profile;
    assertProfileName(profile);
    if (enforceProfileGrant && allowedProfiles && !allowedProfiles.has(profile)) {
      throw new ModelProfileResolutionError(
        "DISALLOWED_PROFILE",
        `Model profile "${profile}" is not allowed`,
        { profile, path: [...path, profile] },
      );
    }
    if (path.includes(profile)) {
      throw new ModelProfileResolutionError(
        "PROFILE_CYCLE",
        `Model profile cycle detected: ${[...path, profile].join(" -> ")}`,
        { profile, path: [...path, profile] },
      );
    }
    if (path.length >= maxDepth) {
      throw new ModelProfileResolutionError(
        "PROFILE_DEPTH_EXCEEDED",
        `Model profile expansion exceeds depth ${maxDepth}`,
        { profile, path: [...path, profile] },
      );
    }
    if (!Object.prototype.hasOwnProperty.call(profiles, profile)) {
      throw new ModelProfileResolutionError(
        "UNKNOWN_PROFILE",
        `Unknown model profile "${profile}"`,
        { profile, path: [...path, profile] },
      );
    }
    if (!seenProfiles.has(profile)) {
      seenProfiles.add(profile);
      usedProfiles.push(profile);
    }
    return expandSelection(profiles[profile], [...path, profile], false);
  };

  const expandSelection = (
    value: unknown,
    path: string[],
    enforceProfileGrant: boolean,
  ): string[] => {
    if (typeof value === "string" || isModelProfileReference(value)) {
      return expandTarget(value, path, enforceProfileGrant);
    }
    if (!isRecord(value) || Object.prototype.hasOwnProperty.call(value, "profile")) {
      throw new ModelProfileResolutionError(
        "INVALID_SELECTION",
        "Model selection must be a model id, profile reference, or model policy",
        { path },
      );
    }
    const unexpectedKey = Object.keys(value)
      .find((key) => key !== "primary" && key !== "fallbacks");
    if (unexpectedKey) {
      throw new ModelProfileResolutionError(
        "INVALID_SELECTION",
        `Model policy contains unsupported field "${unexpectedKey}"`,
        { path },
      );
    }

    const config = value as Partial<ProfiledModelConfig>;
    if (!Object.prototype.hasOwnProperty.call(config, "primary")) {
      throw new ModelProfileResolutionError(
        "INVALID_SELECTION",
        "Model policy primary model cannot be empty",
        { path },
      );
    }
    if (config.fallbacks !== undefined && !Array.isArray(config.fallbacks)) {
      throw new ModelProfileResolutionError(
        "INVALID_SELECTION",
        "Model policy fallbacks must be an array",
        { path },
      );
    }

    return [
      ...expandTarget(config.primary, path, enforceProfileGrant),
      ...(config.fallbacks ?? []).flatMap((fallback) =>
        expandTarget(fallback, path, enforceProfileGrant)
      ),
    ];
  };

  const candidates = deduplicate(expandSelection(selection, [], true));
  if (candidates.length === 0) {
    throw new ModelProfileResolutionError(
      "INVALID_SELECTION",
      "Model selection must resolve to at least one model",
    );
  }
  if (candidates.length - 1 > maxFallbacks) {
    throw new ModelProfileResolutionError(
      "TOO_MANY_FALLBACKS",
      `Model policy supports at most ${maxFallbacks} fallback models`,
    );
  }
  if (allowedModels) {
    const disallowed = candidates.find((model) => !allowedModels.has(model));
    if (disallowed) {
      throw new ModelProfileResolutionError(
        "DISALLOWED_MODEL",
        `Model "${disallowed}" is not allowed`,
        { model: disallowed },
      );
    }
  }

  const concreteSelection: string | ModelConfig = candidates.length === 1
    ? candidates[0]
    : { primary: candidates[0], fallbacks: candidates.slice(1) };
  const normalized = normalizeModelPolicy(concreteSelection, { maxFallbacks });
  const policy = Object.freeze({
    primary: normalized.primary,
    fallbacks: Object.freeze([...normalized.fallbacks]),
    candidates: Object.freeze([...normalized.candidates]),
  });

  return Object.freeze({
    selection: freezeSelection(concreteSelection),
    policy,
    profiles: Object.freeze([...usedProfiles]),
  });
}

function normalizeRegistry(value: unknown): ModelProfileRegistry {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw new ModelProfileResolutionError(
      "INVALID_PROFILE_REGISTRY",
      "Model profiles must be an object keyed by profile name",
    );
  }
  for (const profile of Object.keys(value)) assertProfileName(profile);
  return value as ModelProfileRegistry;
}

function normalizeAllowlist(
  value: unknown,
  kind: "profile" | "model",
): ReadonlySet<string> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new ModelProfileResolutionError(
      "INVALID_ALLOWLIST",
      `Allowed ${kind}s must be an array of strings`,
    );
  }
  const normalized = value.map((entry) => {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new ModelProfileResolutionError(
        "INVALID_ALLOWLIST",
        `Allowed ${kind}s must contain non-empty strings`,
      );
    }
    const result = entry.trim();
    if (kind === "profile") assertProfileName(result);
    return result;
  });
  return new Set(normalized);
}

function assertProfileName(profile: string): void {
  if (!MODEL_PROFILE_NAME_PATTERN.test(profile)) {
    throw new ModelProfileResolutionError(
      "INVALID_PROFILE_NAME",
      `Invalid model profile name "${profile}"`,
      { profile },
    );
  }
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new ModelProfileResolutionError(
      "INVALID_SELECTION",
      `${label} must be a non-negative integer`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deduplicate(values: string[]): string[] {
  return [...new Set(values)];
}

function freezeSelection(selection: string | ModelConfig): string | ModelConfig {
  if (typeof selection === "string") return selection;
  const frozen = Object.freeze({
    primary: selection.primary,
    fallbacks: Object.freeze([...(selection.fallbacks ?? [])]),
  });
  return frozen as ModelConfig;
}
