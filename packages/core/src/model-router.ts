import {
  MODEL_PROFILE_NAME_PATTERN,
  ModelProfileResolutionError,
  resolveModelProfileSelection,
} from "./model-profiles.js";
import type {
  ModelProfileRegistry,
} from "./types/config.js";
import type { ModelSelection } from "./model-policy.js";
import type {
  RuntimeDecisionSource,
  RuntimeInvocationSource,
  RuntimeSurface,
} from "./runtime-plan/index.js";

export const MODEL_ROUTER_MODES = ["off", "auto"] as const;
export type ModelRouterMode = (typeof MODEL_ROUTER_MODES)[number];

export const DEFAULT_MODEL_ROUTE_MIN_CONFIDENCE = 0.7;
export const DEFAULT_MODEL_ROUTE_TIMEOUT_MS = 1_000;
export const DEFAULT_MODEL_ROUTE_MAX_INPUT_CHARS = 4_096;
export const MAX_MODEL_ROUTE_INPUT_CHARS = 16_384;
export const MAX_MODEL_ROUTE_LABELS = 16;
export const MAX_MODEL_ROUTE_LABEL_CHARS = 64;
export const MAX_MODEL_ROUTE_REASON_CHARS = 512;

export interface ModelRouteDecision {
  readonly profile: string;
  readonly confidence: number;
  readonly reason: string;
  readonly labels: readonly string[];
}

/**
 * Deliberately compact classifier payload. It carries the current bounded
 * request only, semantic profile names, and coarse host labels. Profile model
 * definitions, prompts, history, tool schemas, and credentials are excluded.
 */
export interface ModelRouteClassifierInput {
  readonly version: 1;
  readonly surface: RuntimeSurface;
  readonly source: RuntimeInvocationSource;
  readonly input: string;
  readonly profiles: readonly string[];
  readonly labels: readonly string[];
}

export interface ModelRouteClassifierOptions {
  readonly signal: AbortSignal;
}

export interface ModelRouteClassifier {
  classify(
    input: ModelRouteClassifierInput,
    options: ModelRouteClassifierOptions,
  ): Promise<unknown>;
}

export interface ModelRouterConfig {
  readonly mode?: ModelRouterMode;
  /** Deterministic profile used whenever the classifier is skipped or unsafe. */
  readonly fallbackProfile: string;
  /** Router candidates. This list can only narrow the project registry. */
  readonly allowedProfiles: readonly string[];
  readonly minConfidence?: number;
  readonly timeoutMs?: number;
  readonly maxInputChars?: number;
}

export interface ResolveModelRouteInput {
  readonly surface: RuntimeSurface;
  readonly source: RuntimeInvocationSource;
  /** Current request/task summary only. Callers must not pass full history. */
  readonly input?: string;
  readonly labels?: readonly string[];
  readonly profiles: ModelProfileRegistry;
  readonly allowedModels?: readonly string[];
  readonly config: ModelRouterConfig;
  /** Already-authorized request override. It always wins and skips automation. */
  readonly explicitProfile?: string;
}

export interface ResolveModelRouteOptions {
  readonly classifier?: ModelRouteClassifier;
  readonly signal?: AbortSignal;
}

export type ModelRouteStatus =
  | "disabled"
  | "explicit"
  | "skipped"
  | "routed"
  | "fallback";

export interface ResolvedModelRoute {
  readonly status: ModelRouteStatus;
  readonly source: Extract<RuntimeDecisionSource, "request" | "agent" | "router">;
  readonly profile: string;
  readonly selection: ModelSelection;
  readonly confidence?: number;
  readonly reason: string;
  readonly labels: readonly string[];
  readonly latencyMs: number;
  readonly fallbackUsed: boolean;
}

export interface ModelRouteRuntimePlanFields {
  readonly model: Readonly<{
    selection: ModelSelection;
    profile: string;
    source: Extract<RuntimeDecisionSource, "request" | "agent" | "router">;
  }>;
  readonly audit: Readonly<{
    reasons: readonly string[];
    warnings: readonly string[];
    confidence?: number;
    latencyMs: Readonly<{ modelRouter: number }>;
    fallbackUsed: boolean;
  }>;
}

export class ModelRouteCancelledError extends Error {
  readonly code = "MODEL_ROUTE_CANCELLED" as const;

  constructor() {
    super("Model routing was cancelled");
    this.name = "ModelRouteCancelledError";
  }
}

export function modelRouteRuntimePlanFields(
  route: ResolvedModelRoute,
): ModelRouteRuntimePlanFields {
  const warnings = route.status === "fallback"
    ? [`Model router used fallback profile "${route.profile}"`]
    : [];
  return Object.freeze({
    model: Object.freeze({
      selection: route.selection,
      profile: route.profile,
      source: route.source,
    }),
    audit: Object.freeze({
      reasons: Object.freeze([route.reason]),
      warnings: Object.freeze(warnings),
      ...(route.confidence !== undefined
        ? { confidence: route.confidence }
        : {}),
      latencyMs: Object.freeze({ modelRouter: route.latencyMs }),
      fallbackUsed: route.fallbackUsed,
    }),
  });
}

interface NormalizedModelRouterConfig {
  mode: ModelRouterMode;
  fallbackProfile: string;
  allowedProfiles: readonly string[];
  minConfidence: number;
  timeoutMs: number;
  maxInputChars: number;
}

type ClassifierOutcome =
  | { type: "decision"; value: unknown }
  | { type: "error" }
  | { type: "timeout" };

function finiteRange(
  value: unknown,
  fallback: number,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`${label} must be a finite number between ${minimum} and ${maximum}`);
  }
  return value;
}

function positiveInteger(
  value: unknown,
  fallback: number,
  label: string,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > maximum
  ) {
    throw new Error(`${label} must be a positive integer no greater than ${maximum}`);
  }
  return value;
}

function normalizedUniqueStrings(
  value: unknown,
  label: string,
  options: {
    maximumItems?: number;
    maximumChars?: number;
    pattern?: RegExp;
  } = {},
): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of strings`);
  }
  const output: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") {
      throw new Error(`${label} must contain only strings`);
    }
    const normalized = item.trim();
    if (!normalized) continue;
    if (options.maximumChars && normalized.length > options.maximumChars) {
      throw new Error(`${label} values must not exceed ${options.maximumChars} characters`);
    }
    if (options.pattern && !options.pattern.test(normalized)) {
      throw new Error(`${label} contains invalid value "${normalized}"`);
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
    if (options.maximumItems && output.length > options.maximumItems) {
      throw new Error(`${label} must not contain more than ${options.maximumItems} values`);
    }
  }
  return output;
}

function normalizeConfig(config: ModelRouterConfig): NormalizedModelRouterConfig {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Model router config must be an object");
  }
  const mode = config.mode ?? "off";
  if (!MODEL_ROUTER_MODES.includes(mode)) {
    throw new Error(`Model router mode must be one of: ${MODEL_ROUTER_MODES.join(", ")}`);
  }
  if (
    typeof config.fallbackProfile !== "string" ||
    !MODEL_PROFILE_NAME_PATTERN.test(config.fallbackProfile)
  ) {
    throw new Error("Model router fallbackProfile must be a valid profile name");
  }
  const allowedProfiles = normalizedUniqueStrings(
    config.allowedProfiles,
    "Model router allowedProfiles",
    { pattern: MODEL_PROFILE_NAME_PATTERN },
  );
  if (allowedProfiles.length === 0) {
    throw new Error("Model router allowedProfiles must contain at least one profile");
  }

  return Object.freeze({
    mode,
    fallbackProfile: config.fallbackProfile,
    allowedProfiles: Object.freeze(allowedProfiles),
    minConfidence: finiteRange(
      config.minConfidence,
      DEFAULT_MODEL_ROUTE_MIN_CONFIDENCE,
      "Model router minConfidence",
      0,
      1,
    ),
    timeoutMs: positiveInteger(
      config.timeoutMs,
      DEFAULT_MODEL_ROUTE_TIMEOUT_MS,
      "Model router timeoutMs",
      60_000,
    ),
    maxInputChars: positiveInteger(
      config.maxInputChars,
      DEFAULT_MODEL_ROUTE_MAX_INPUT_CHARS,
      "Model router maxInputChars",
      MAX_MODEL_ROUTE_INPUT_CHARS,
    ),
  });
}

function normalizeLabels(value: readonly string[] | undefined): string[] {
  if (value === undefined) return [];
  const labels = normalizedUniqueStrings(value, "Model router labels", {
    maximumItems: MAX_MODEL_ROUTE_LABELS,
  });
  return labels.map((label) => label.slice(0, MAX_MODEL_ROUTE_LABEL_CHARS));
}

function resolveProfile(
  profile: string,
  input: ResolveModelRouteInput,
  config: NormalizedModelRouterConfig,
): ModelSelection {
  return resolveModelProfileSelection({ profile }, {
    profiles: input.profiles,
    allowedProfiles: config.allowedProfiles,
    allowedModels: input.allowedModels,
  }).selection;
}

function result(
  value: Omit<ResolvedModelRoute, "labels"> & { labels?: readonly string[] },
): ResolvedModelRoute {
  return Object.freeze({
    ...value,
    labels: Object.freeze([...(value.labels ?? [])]),
  });
}

function fallbackResult(
  input: ResolveModelRouteInput,
  config: NormalizedModelRouterConfig,
  details: {
    status: Extract<ModelRouteStatus, "disabled" | "skipped" | "fallback">;
    source: Extract<RuntimeDecisionSource, "agent" | "router">;
    reason: string;
    latencyMs?: number;
    confidence?: number;
    labels?: readonly string[];
    fallbackUsed: boolean;
  },
): ResolvedModelRoute {
  return result({
    status: details.status,
    source: details.source,
    profile: config.fallbackProfile,
    selection: resolveProfile(config.fallbackProfile, input, config),
    ...(details.confidence !== undefined
      ? { confidence: details.confidence }
      : {}),
    reason: details.reason,
    labels: details.labels,
    latencyMs: details.latencyMs ?? 0,
    fallbackUsed: details.fallbackUsed,
  });
}

function parseDecision(value: unknown, allowedProfiles: readonly string[]): ModelRouteDecision {
  let parsed = value;
  if (typeof value === "string") {
    parsed = JSON.parse(value);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Model route decision must be an object");
  }
  const prototype = Object.getPrototypeOf(parsed);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Model route decision must be a plain object");
  }
  const record = parsed as Record<string, unknown>;
  const expectedKeys = ["confidence", "labels", "profile", "reason"];
  const actualKeys = Object.keys(record).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error("Model route decision contains unsupported fields");
  }
  if (
    typeof record.profile !== "string" ||
    !allowedProfiles.includes(record.profile)
  ) {
    throw new ModelProfileResolutionError(
      "DISALLOWED_PROFILE",
      "Model route decision selected a disallowed profile",
      { profile: typeof record.profile === "string" ? record.profile : undefined },
    );
  }
  if (
    typeof record.confidence !== "number" ||
    !Number.isFinite(record.confidence) ||
    record.confidence < 0 ||
    record.confidence > 1
  ) {
    throw new Error("Model route decision confidence must be between 0 and 1");
  }
  if (typeof record.reason !== "string" || !record.reason.trim()) {
    throw new Error("Model route decision reason must be a non-empty string");
  }
  const reason = record.reason
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!reason || reason.length > MAX_MODEL_ROUTE_REASON_CHARS) {
    throw new Error(
      `Model route decision reason must not exceed ${MAX_MODEL_ROUTE_REASON_CHARS} characters`,
    );
  }
  const labels = normalizedUniqueStrings(record.labels, "Model route decision labels", {
    maximumItems: MAX_MODEL_ROUTE_LABELS,
    maximumChars: MAX_MODEL_ROUTE_LABEL_CHARS,
  });
  return Object.freeze({
    profile: record.profile,
    confidence: record.confidence,
    reason,
    labels: Object.freeze(labels),
  });
}

async function classifyWithDeadline(
  classifier: ModelRouteClassifier,
  input: ModelRouteClassifierInput,
  timeoutMs: number,
  callerSignal?: AbortSignal,
): Promise<ClassifierOutcome> {
  if (callerSignal?.aborted) throw new ModelRouteCancelledError();

  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onCallerAbort: (() => void) | undefined;

  const classifierOutcome: Promise<ClassifierOutcome> = Promise.resolve()
    .then(() => classifier.classify(input, { signal: controller.signal }))
    .then(
      (value): ClassifierOutcome => ({ type: "decision", value }),
      (): ClassifierOutcome => ({ type: "error" }),
    );

  const timeoutOutcome = new Promise<ClassifierOutcome>((resolve) => {
    timeout = setTimeout(() => {
      controller.abort(new Error("Model router timeout"));
      resolve({ type: "timeout" });
    }, timeoutMs);
  });

  const outcomes: Promise<ClassifierOutcome>[] = [classifierOutcome, timeoutOutcome];
  if (callerSignal) {
    outcomes.push(new Promise<ClassifierOutcome>((_resolve, reject) => {
      onCallerAbort = () => {
        controller.abort(new ModelRouteCancelledError());
        reject(new ModelRouteCancelledError());
      };
      callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }));
  }

  try {
    return await Promise.race(outcomes);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (callerSignal && onCallerAbort) {
      callerSignal.removeEventListener("abort", onCallerAbort);
    }
  }
}

export async function resolveModelRoute(
  input: ResolveModelRouteInput,
  options: ResolveModelRouteOptions = {},
): Promise<ResolvedModelRoute> {
  const config = normalizeConfig(input.config);

  // Resolve the fallback before any classifier work. This proves that both the
  // project registry and model allowlist permit every possible fallback path.
  resolveProfile(config.fallbackProfile, input, config);

  if (input.explicitProfile !== undefined) {
    if (
      typeof input.explicitProfile !== "string" ||
      !MODEL_PROFILE_NAME_PATTERN.test(input.explicitProfile)
    ) {
      throw new Error("Explicit model profile must be a valid profile name");
    }
    return result({
      status: "explicit",
      source: "request",
      profile: input.explicitProfile,
      selection: resolveProfile(input.explicitProfile, input, config),
      confidence: 1,
      reason: "Explicit model profile request",
      latencyMs: 0,
      fallbackUsed: false,
    });
  }

  if (config.mode === "off") {
    return fallbackResult(input, config, {
      status: "disabled",
      source: "agent",
      reason: "Model router is disabled",
      fallbackUsed: false,
    });
  }
  if (config.allowedProfiles.length === 1) {
    return fallbackResult(input, config, {
      status: "skipped",
      source: "agent",
      reason: "Only one model profile is allowed",
      fallbackUsed: false,
    });
  }

  const compactInput = (input.input ?? "").trim().slice(0, config.maxInputChars);
  if (!compactInput) {
    return fallbackResult(input, config, {
      status: "skipped",
      source: "agent",
      reason: "Model router input was empty",
      fallbackUsed: false,
    });
  }
  if (!options.classifier) {
    return fallbackResult(input, config, {
      status: "skipped",
      source: "agent",
      reason: "Model router classifier is unavailable",
      fallbackUsed: false,
    });
  }

  const classifierInput = Object.freeze({
    version: 1 as const,
    surface: input.surface,
    source: input.source,
    input: compactInput,
    profiles: Object.freeze([...config.allowedProfiles]),
    labels: Object.freeze(normalizeLabels(input.labels)),
  });
  const startedAt = Date.now();
  const outcome = await classifyWithDeadline(
    options.classifier,
    classifierInput,
    config.timeoutMs,
    options.signal,
  );
  const latencyMs = Math.max(0, Date.now() - startedAt);

  if (outcome.type === "timeout") {
    return fallbackResult(input, config, {
      status: "fallback",
      source: "router",
      reason: `Model router timed out after ${config.timeoutMs}ms`,
      latencyMs,
      fallbackUsed: true,
    });
  }
  if (outcome.type === "error") {
    return fallbackResult(input, config, {
      status: "fallback",
      source: "router",
      reason: "Model router classifier failed",
      latencyMs,
      fallbackUsed: true,
    });
  }

  let decision: ModelRouteDecision;
  try {
    decision = parseDecision(outcome.value, config.allowedProfiles);
    // Re-resolve the exact selected profile before returning. The classifier
    // never receives model ids and cannot bypass registry/model allowlists.
    resolveProfile(decision.profile, input, config);
  } catch {
    return fallbackResult(input, config, {
      status: "fallback",
      source: "router",
      reason: "Model router returned an invalid decision",
      latencyMs,
      fallbackUsed: true,
    });
  }

  if (decision.confidence < config.minConfidence) {
    return fallbackResult(input, config, {
      status: "fallback",
      source: "router",
      reason: `Model router confidence was below ${config.minConfidence}`,
      labels: decision.labels,
      latencyMs,
      confidence: decision.confidence,
      fallbackUsed: true,
    });
  }

  return result({
    status: "routed",
    source: "router",
    profile: decision.profile,
    selection: resolveProfile(decision.profile, input, config),
    confidence: decision.confidence,
    reason: decision.reason,
    labels: decision.labels,
    latencyMs,
    fallbackUsed: false,
  });
}
