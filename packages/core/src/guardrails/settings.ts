import {
  createDefaultPreflightGuardrailPolicies,
  createDefaultOutputGuardrailPolicies,
  createDefaultToolGuardrailPolicies,
} from "./detectors.js";
import { RuntimeGuardrailEngine } from "./engine.js";
import { createRunOutputPolicy } from "./output-policy.js";
import { createRunPreflightPolicy } from "./preflight-policy.js";
import { createRunToolMiddleware } from "./tool-middleware.js";
import type {
  RunPreflightPolicy,
  RunOutputPolicy,
  RunToolMiddleware,
  RuntimeGuardrailContentRule,
  RuntimeGuardrailHostAdapters,
  RuntimeGuardrailPolicyPack,
  RuntimeGuardrailRequestPolicy,
  RuntimeGuardrailSettings,
} from "./types.js";

const MAX_CONTENT_RULES = 32;
const MAX_RULE_TERMS = 32;
const MAX_TERM_CHARACTERS = 128;
const CONTENT_RULE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const CONTENT_RULE_PHASES = new Set([
  "input",
  "context",
  "model.preflight",
  "output",
]);
const CONTENT_RULE_ACTIONS = new Set(["audit", "redact", "block"]);
const CONTENT_RULE_RISKS = new Set(["low", "medium", "high", "critical"]);
const STANDARD_PREFLIGHT_LIMITS = Object.freeze({
  maxInputCharacters: 4_000_000,
  maxContextCharacters: 2_000_000,
  maxModelInputCharacters: 8_000_000,
});
const STRICT_PREFLIGHT_LIMITS = Object.freeze({
  maxInputCharacters: 1_000_000,
  maxContextCharacters: 1_000_000,
  maxModelInputCharacters: 2_000_000,
});

function normalizeRuntimeGuardrailRequestPolicy(
  value: unknown,
): RuntimeGuardrailRequestPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Request guardrails must be an object");
  }
  const raw = value as Record<string, unknown>;
  const unknown = Object.keys(raw).find((key) => key !== "policyPack");
  if (unknown) {
    throw new TypeError(
      `Request guardrails contains unknown field "${unknown}"`,
    );
  }
  if (raw.policyPack !== "strict") {
    throw new TypeError(
      'Request guardrails policyPack must be "strict"',
    );
  }
  return Object.freeze({ policyPack: "strict" });
}

function clampLimit(
  value: number | undefined,
  maximum: number,
): number {
  return value === undefined ? maximum : Math.min(value, maximum);
}

function optionalPositiveInteger(
  raw: Record<string, unknown>,
  field: string,
): number | undefined {
  const value = raw[field];
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`guardrails.${field} must be a positive safe integer`);
  }
  return value as number;
}

function normalizeContentRules(value: unknown): readonly RuntimeGuardrailContentRule[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CONTENT_RULES) {
    throw new TypeError(
      `guardrails.contentRules must contain 1-${MAX_CONTENT_RULES} rules`,
    );
  }
  const seen = new Set<string>();
  return Object.freeze(value.map((entry, index) => {
    const path = `guardrails.contentRules[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError(`${path} must be an object`);
    }
    const raw = entry as Record<string, unknown>;
    if (typeof raw.id !== "string" || !CONTENT_RULE_ID.test(raw.id)) {
      throw new TypeError(`${path}.id must be a stable 1-64 character identifier`);
    }
    if (seen.has(raw.id)) {
      throw new TypeError(`${path}.id must be unique`);
    }
    seen.add(raw.id);
    if (
      !Array.isArray(raw.phases)
      || raw.phases.length === 0
      || raw.phases.some((phase) =>
        typeof phase !== "string" || !CONTENT_RULE_PHASES.has(phase))
    ) {
      throw new TypeError(
        `${path}.phases may contain input, context, model.preflight, or output`,
      );
    }
    if (typeof raw.action !== "string" || !CONTENT_RULE_ACTIONS.has(raw.action)) {
      throw new TypeError(`${path}.action must be audit, redact, or block`);
    }
    if (typeof raw.risk !== "string" || !CONTENT_RULE_RISKS.has(raw.risk)) {
      throw new TypeError(`${path}.risk must be low, medium, high, or critical`);
    }
    if (
      !Array.isArray(raw.containsAny)
      || raw.containsAny.length === 0
      || raw.containsAny.length > MAX_RULE_TERMS
      || raw.containsAny.some((term) =>
        typeof term !== "string"
        || term.trim().length === 0
        || term.length > MAX_TERM_CHARACTERS)
    ) {
      throw new TypeError(
        `${path}.containsAny must contain 1-${MAX_RULE_TERMS} bounded terms`,
      );
    }
    if (raw.caseSensitive !== undefined && typeof raw.caseSensitive !== "boolean") {
      throw new TypeError(`${path}.caseSensitive must be a boolean`);
    }
    if (
      raw.replacement !== undefined
      && (
        raw.action !== "redact"
        || typeof raw.replacement !== "string"
        || raw.replacement.length > 64
      )
    ) {
      throw new TypeError(
        `${path}.replacement is only allowed for redact and is limited to 64 characters`,
      );
    }
    return Object.freeze({
      id: raw.id,
      phases: Object.freeze([...new Set(raw.phases)]),
      action: raw.action,
      risk: raw.risk,
      containsAny: Object.freeze([
        ...new Set(raw.containsAny.map((term) => term.trim())),
      ]),
      ...(raw.caseSensitive === true ? { caseSensitive: true } : {}),
      ...(raw.replacement !== undefined ? { replacement: raw.replacement } : {}),
    }) as RuntimeGuardrailContentRule;
  }));
}

export function normalizeRuntimeGuardrailSettings(
  value: unknown,
): RuntimeGuardrailSettings | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("guardrails must be an object");
  }

  const raw = value as Record<string, unknown>;
  if (
    raw.policyPack === undefined
    &&
    raw.toolPolicyPack === undefined
    && raw.outputPolicyPack === undefined
    && Object.keys(raw).length === 0
  ) {
    return undefined;
  }
  if (
    raw.policyPack !== undefined
    && raw.policyPack !== "standard"
    && raw.policyPack !== "strict"
    && raw.policyPack !== "custom"
  ) {
    throw new TypeError(
      'guardrails.policyPack must be "standard", "strict", or "custom"',
    );
  }
  if (
    raw.policyPack !== undefined
    && (raw.toolPolicyPack !== undefined || raw.outputPolicyPack !== undefined)
  ) {
    throw new TypeError(
      "guardrails.policyPack cannot be combined with legacy split policy packs",
    );
  }
  if (raw.toolPolicyPack !== undefined && raw.toolPolicyPack !== "default") {
    throw new TypeError('guardrails.toolPolicyPack must be "default"');
  }
  if (raw.outputPolicyPack !== undefined && raw.outputPolicyPack !== "default") {
    throw new TypeError('guardrails.outputPolicyPack must be "default"');
  }
  const unifiedPack = raw.policyPack as RuntimeGuardrailPolicyPack | undefined;
  const toolEnabled = unifiedPack !== undefined || raw.toolPolicyPack !== undefined;
  const outputEnabled = unifiedPack !== undefined || raw.outputPolicyPack !== undefined;
  if (!toolEnabled && (
    raw.maxToolOutputCharacters !== undefined
    || raw.readOnlyPolicyFailure !== undefined
  )) {
    throw new TypeError(
      "guardrails tool settings require guardrails.toolPolicyPack",
    );
  }
  if (!outputEnabled && (
    raw.maxFinalOutputCharacters !== undefined
    || raw.streamingOutputMode !== undefined
  )) {
    const field = raw.streamingOutputMode !== undefined
      ? "streamingOutputMode"
      : "maxFinalOutputCharacters";
    throw new TypeError(
      `guardrails.${field} requires guardrails.outputPolicyPack`,
    );
  }
  if (
    unifiedPack === undefined
    && (
      raw.maxInputCharacters !== undefined
      || raw.maxContextCharacters !== undefined
      || raw.maxModelInputCharacters !== undefined
    )
  ) {
    throw new TypeError(
      "guardrails preflight limits require guardrails.policyPack",
    );
  }
  let contentRules: readonly RuntimeGuardrailContentRule[] | undefined;
  if (unifiedPack === "custom") {
    contentRules = normalizeContentRules(raw.contentRules);
  } else if (raw.contentRules !== undefined) {
    throw new TypeError(
      'guardrails.contentRules requires guardrails.policyPack="custom"',
    );
  }
  if (
    unifiedPack === undefined
    && raw.toolPolicyPack === undefined
    && raw.outputPolicyPack === undefined
  ) {
    return undefined;
  }

  let maxToolOutputCharacters: number | undefined;
  if (raw.maxToolOutputCharacters !== undefined) {
    if (
      !Number.isSafeInteger(raw.maxToolOutputCharacters) ||
      (raw.maxToolOutputCharacters as number) < 1
    ) {
      throw new TypeError(
        "guardrails.maxToolOutputCharacters must be a positive safe integer",
      );
    }
    maxToolOutputCharacters = raw.maxToolOutputCharacters as number;
  }
  let readOnlyPolicyFailure: "audit" | "block" | undefined;
  if (raw.readOnlyPolicyFailure !== undefined) {
    if (raw.readOnlyPolicyFailure !== "audit" && raw.readOnlyPolicyFailure !== "block") {
      throw new TypeError(
        'guardrails.readOnlyPolicyFailure must be "audit" or "block"',
      );
    }
    readOnlyPolicyFailure = raw.readOnlyPolicyFailure;
  }
  let maxFinalOutputCharacters: number | undefined;
  if (raw.maxFinalOutputCharacters !== undefined) {
    if (
      !Number.isSafeInteger(raw.maxFinalOutputCharacters)
      || (raw.maxFinalOutputCharacters as number) < 1
    ) {
      throw new TypeError(
        "guardrails.maxFinalOutputCharacters must be a positive safe integer",
      );
    }
    maxFinalOutputCharacters = raw.maxFinalOutputCharacters as number;
  }
  let streamingOutputMode: "audit" | "buffer" | undefined;
  if (outputEnabled) {
    if (
      raw.streamingOutputMode !== undefined
      && raw.streamingOutputMode !== "audit"
      && raw.streamingOutputMode !== "buffer"
    ) {
      throw new TypeError(
        'guardrails.streamingOutputMode must be "audit" or "buffer"',
      );
    }
    streamingOutputMode = (
      raw.streamingOutputMode
      ?? (unifiedPack === "strict" ? "buffer" : "audit")
    ) as "audit" | "buffer";
  }
  if (unifiedPack === "strict" && readOnlyPolicyFailure === undefined) {
    readOnlyPolicyFailure = "block";
  }
  const maxInputCharacters = optionalPositiveInteger(raw, "maxInputCharacters");
  const maxContextCharacters = optionalPositiveInteger(raw, "maxContextCharacters");
  const maxModelInputCharacters = optionalPositiveInteger(raw, "maxModelInputCharacters");
  return Object.freeze({
    ...(unifiedPack !== undefined ? { policyPack: unifiedPack } : {}),
    ...(contentRules !== undefined ? { contentRules } : {}),
    ...(maxInputCharacters !== undefined ? { maxInputCharacters } : {}),
    ...(maxContextCharacters !== undefined ? { maxContextCharacters } : {}),
    ...(maxModelInputCharacters !== undefined ? { maxModelInputCharacters } : {}),
    ...(raw.toolPolicyPack === "default" ? { toolPolicyPack: "default" as const } : {}),
    ...(raw.outputPolicyPack === "default" ? { outputPolicyPack: "default" as const } : {}),
    ...(maxToolOutputCharacters !== undefined ? { maxToolOutputCharacters } : {}),
    ...(maxFinalOutputCharacters !== undefined ? { maxFinalOutputCharacters } : {}),
    ...(readOnlyPolicyFailure !== undefined ? { readOnlyPolicyFailure } : {}),
    ...(streamingOutputMode !== undefined ? { streamingOutputMode } : {}),
  });
}

/**
 * Resolve a caller-requested policy without allowing the caller to enable,
 * loosen, or replace the host's authorized project policy.
 */
export function resolveRuntimeGuardrailRequestPolicy(
  projectPolicy: unknown,
  requestPolicy: unknown,
): RuntimeGuardrailSettings {
  normalizeRuntimeGuardrailRequestPolicy(requestPolicy);
  const project = normalizeRuntimeGuardrailSettings(projectPolicy);
  if (!project) {
    throw new TypeError(
      "Project guardrails are not configured; a request cannot enable them",
    );
  }
  if (project.policyPack === "custom") {
    throw new TypeError(
      "A strict request cannot replace a custom project guardrail policy",
    );
  }
  if (project.policyPack === "strict") return project;

  return normalizeRuntimeGuardrailSettings({
    policyPack: "strict",
    maxInputCharacters: clampLimit(
      project.maxInputCharacters,
      STRICT_PREFLIGHT_LIMITS.maxInputCharacters,
    ),
    maxContextCharacters: clampLimit(
      project.maxContextCharacters,
      STRICT_PREFLIGHT_LIMITS.maxContextCharacters,
    ),
    maxModelInputCharacters: clampLimit(
      project.maxModelInputCharacters,
      STRICT_PREFLIGHT_LIMITS.maxModelInputCharacters,
    ),
    ...(project.maxToolOutputCharacters !== undefined
      ? { maxToolOutputCharacters: project.maxToolOutputCharacters }
      : {}),
    ...(project.maxFinalOutputCharacters !== undefined
      ? { maxFinalOutputCharacters: project.maxFinalOutputCharacters }
      : {}),
    readOnlyPolicyFailure: "block",
    streamingOutputMode: "buffer",
  })!;
}

function configuredPolicies(
  builtIn: readonly import("./types.js").RuntimeGuardrailPolicy[],
  adapters: RuntimeGuardrailHostAdapters,
): readonly import("./types.js").RuntimeGuardrailPolicy[] {
  const policies = [
    ...builtIn,
    ...(adapters.policies ?? []),
  ];
  const ids = new Set<string>();
  for (const policy of policies) {
    if (ids.has(policy.id)) {
      throw new TypeError(`Duplicate guardrail policy id "${policy.id}"`);
    }
    ids.add(policy.id);
  }
  return Object.freeze(policies);
}

export function createConfiguredRunPreflightPolicy(
  value: RuntimeGuardrailSettings | undefined,
  adapters: RuntimeGuardrailHostAdapters = {},
): RunPreflightPolicy | undefined {
  const settings = normalizeRuntimeGuardrailSettings(value);
  if (!settings?.policyPack) return undefined;
  const limits = settings.policyPack === "strict"
    ? STRICT_PREFLIGHT_LIMITS
    : STANDARD_PREFLIGHT_LIMITS;
  const engine = new RuntimeGuardrailEngine(
    configuredPolicies(
      createDefaultPreflightGuardrailPolicies({
        contentRules: settings.contentRules,
        maxInputCharacters: settings.maxInputCharacters ?? limits.maxInputCharacters,
        maxContextCharacters: settings.maxContextCharacters ?? limits.maxContextCharacters,
        maxModelInputCharacters:
          settings.maxModelInputCharacters ?? limits.maxModelInputCharacters,
      }),
      adapters,
    ),
    { onDecision: adapters.onDecision },
  );
  return createRunPreflightPolicy(engine);
}

/**
 * Build the OSS deterministic policy pack from serializable host settings.
 *
 * Undefined settings are the off switch and return undefined. Host adapters
 * remain process-local: audit and approval callbacks never enter persisted
 * RunnerConfig data.
 */
export function createConfiguredRunToolMiddleware(
  value: RuntimeGuardrailSettings | undefined,
  adapters: RuntimeGuardrailHostAdapters = {},
): RunToolMiddleware | undefined {
  const settings = normalizeRuntimeGuardrailSettings(value);
  if (!settings?.policyPack && !settings?.toolPolicyPack) return undefined;

  const engine = new RuntimeGuardrailEngine(
    configuredPolicies(
      createDefaultToolGuardrailPolicies({
        strict: settings.policyPack === "strict",
      }),
      adapters,
    ),
    {
      onDecision: adapters.onDecision,
      readOnlyPolicyFailure: settings.readOnlyPolicyFailure,
    },
  );
  return createRunToolMiddleware(engine, {
    approval: adapters.approval,
    maxOutputCharacters: settings.maxToolOutputCharacters,
  });
}

export function createConfiguredRunOutputPolicy(
  value: RuntimeGuardrailSettings | undefined,
  adapters: RuntimeGuardrailHostAdapters = {},
): RunOutputPolicy | undefined {
  const settings = normalizeRuntimeGuardrailSettings(value);
  if (!settings?.policyPack && !settings?.outputPolicyPack) return undefined;

  const engine = new RuntimeGuardrailEngine(
    configuredPolicies(
      createDefaultOutputGuardrailPolicies(
        settings.maxFinalOutputCharacters,
        settings.contentRules,
      ),
      adapters,
    ),
    { onDecision: adapters.onDecision },
  );
  return createRunOutputPolicy(engine, {
    approval: adapters.outputApproval,
    streamingMode: settings.streamingOutputMode,
  });
}
