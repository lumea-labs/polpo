import { nanoid } from "nanoid";
import { normalizeModelPolicy, type ModelSelection } from "../model-policy.js";
import {
  RUNTIME_DECISION_SOURCES,
  RUNTIME_EXECUTION_MODES,
  RUNTIME_GUARDRAIL_ACTIONS,
  RUNTIME_GUARDRAIL_PHASES,
  RUNTIME_GUARDRAIL_RISKS,
  RUNTIME_INVOCATION_SOURCES,
  RUNTIME_PLAN_DEFAULTS,
  RUNTIME_SURFACES,
  RUNTIME_TOOL_EXPOSURES,
} from "./settings.js";
import type {
  CreateRuntimePlanInput,
  RuntimeContextPolicy,
  RuntimeDecisionSource,
  RuntimeGuardrailDecision,
  RuntimePlan,
  RuntimePlanFactoryOptions,
  RuntimePlanJsonValue,
} from "./types.js";

type Primitive = string | number | boolean | null;

function assertMember<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): asserts value is T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${label} must be one of: ${allowed.join(", ")}`);
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, label);
}

function requiredValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`${label} is required`);
  return value;
}

function uniqueStrings(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array of strings`);

  const seen = new Set<string>();
  const output: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") throw new Error(`${label} must contain only strings`);
    const normalized = item.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function normalizeLatencyMap(
  value: unknown,
): Readonly<Record<string, number>> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Runtime plan audit latencyMs must be an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Runtime plan audit latencyMs must be a plain object");
  }

  const output: Record<string, number> = {};
  for (const [rawKey, rawLatency] of Object.entries(value)) {
    const key = requiredString(rawKey, "Runtime plan audit latencyMs key");
    if (
      key === "__proto__" ||
      key === "constructor" ||
      key === "prototype" ||
      key.length > 64
    ) {
      throw new Error("Runtime plan audit latencyMs contains an invalid key");
    }
    if (
      typeof rawLatency !== "number" ||
      !Number.isFinite(rawLatency) ||
      rawLatency < 0
    ) {
      throw new Error(
        "Runtime plan audit latencyMs values must be non-negative finite numbers",
      );
    }
    output[key] = rawLatency;
  }
  return output;
}

function normalizedModelSelection(selection: ModelSelection): ModelSelection {
  const policy = normalizeModelPolicy(selection);
  if (policy.fallbacks.length === 0) return policy.primary;
  return {
    primary: policy.primary,
    fallbacks: policy.fallbacks,
  };
}

function cloneJson(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): RuntimePlanJsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value as Primitive;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${path} must be JSON-serializable`);
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new Error(`${path} must be JSON-serializable`);
  }
  if (ancestors.has(value)) {
    throw new Error(`${path} must be JSON-serializable (cyclic value)`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => cloneJson(item, `${path}[${index}]`, ancestors));
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${path} must be JSON-serializable`);
    }

    const output: Record<string, RuntimePlanJsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        throw new Error(`${path}.${key} is not allowed`);
      }
      output[key] = cloneJson(item, `${path}.${key}`, ancestors);
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function normalizeGuardrailDecision(
  decision: RuntimeGuardrailDecision,
  index: number,
): RuntimeGuardrailDecision {
  const label = `Runtime plan guardrails[${index}]`;
  const id = requiredString(decision?.id, `${label}.id`);
  const policyId = requiredString(decision?.policyId, `${label}.policyId`);
  const policyVersion = optionalString(decision?.policyVersion, `${label}.policyVersion`);
  assertMember(decision?.phase, RUNTIME_GUARDRAIL_PHASES, `${label}.phase`);
  assertMember(decision?.action, RUNTIME_GUARDRAIL_ACTIONS, `${label}.action`);
  assertMember(decision?.risk, RUNTIME_GUARDRAIL_RISKS, `${label}.risk`);
  const reason = requiredString(decision?.reason, `${label}.reason`);

  if (
    decision.latencyMs !== undefined &&
    (!Number.isFinite(decision.latencyMs) || decision.latencyMs < 0)
  ) {
    throw new Error(`${label}.latencyMs must be a non-negative finite number`);
  }
  if (
    decision.fallbackUsed !== undefined &&
    typeof decision.fallbackUsed !== "boolean"
  ) {
    throw new Error(`${label}.fallbackUsed must be a boolean`);
  }

  return {
    id,
    policyId,
    ...(policyVersion ? { policyVersion } : {}),
    phase: decision.phase,
    action: decision.action,
    risk: decision.risk,
    reason,
    ...(decision.latencyMs !== undefined ? { latencyMs: decision.latencyMs } : {}),
    ...(decision.fallbackUsed !== undefined
      ? { fallbackUsed: decision.fallbackUsed }
      : {}),
  };
}

function resolvedAt(factory: RuntimePlanFactoryOptions): string {
  const value = factory.now?.() ?? new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Runtime plan clock must return a valid date");
  }
  return date.toISOString();
}

export function freezeRuntimePlan<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) {
    freezeRuntimePlan(nested);
  }
  return Object.freeze(value);
}

export function createRuntimePlan(
  input: CreateRuntimePlanInput,
  factory: RuntimePlanFactoryOptions = {},
): RuntimePlan {
  assertMember(input?.surface, RUNTIME_SURFACES, "Runtime plan surface");
  assertMember(input?.source, RUNTIME_INVOCATION_SOURCES, "Runtime plan source");

  const id = requiredString(
    input.id ?? factory.createId?.() ?? `plan-${nanoid(16)}`,
    "Runtime plan id",
  );

  const executionMode = input.execution?.mode ?? RUNTIME_PLAN_DEFAULTS.executionMode;
  assertMember(executionMode, RUNTIME_EXECUTION_MODES, "Runtime plan execution mode");
  const executionSource =
    input.execution?.source ?? RUNTIME_PLAN_DEFAULTS.executionSource;
  assertMember(
    executionSource,
    RUNTIME_DECISION_SOURCES,
    "Runtime plan execution source",
  );
  const loop = optionalString(input.execution?.loop, "Runtime plan loop name");
  if (executionMode === "loop" && !loop) {
    throw new Error("Runtime plan loop mode requires a loop name");
  }
  if (executionMode === "direct" && loop) {
    throw new Error("Direct runtime plans cannot carry a loop name");
  }

  const modelSource = input.model?.source ?? RUNTIME_PLAN_DEFAULTS.modelSource;
  assertMember(modelSource, RUNTIME_DECISION_SOURCES, "Runtime plan model source");
  const modelSelection = normalizedModelSelection(input.model?.selection);
  const profile = optionalString(input.model?.profile, "Runtime plan model profile");

  const sandboxIsolation =
    input.sandbox?.isolation ?? RUNTIME_PLAN_DEFAULTS.sandboxIsolation;
  if (
    sandboxIsolation !== "reuse"
    && sandboxIsolation !== "fresh"
    && sandboxIsolation !== "shared"
  ) {
    throw new Error("Runtime plan sandbox isolation must be one of: reuse, fresh, shared");
  }
  const sandboxSource = input.sandbox?.source ?? RUNTIME_PLAN_DEFAULTS.sandboxSource;
  if (
    sandboxSource !== "request" &&
    sandboxSource !== "agent" &&
    sandboxSource !== "default"
  ) {
    throw new Error(
      "Runtime plan sandbox source must be one of: request, agent, default",
    );
  }
  const sandboxReleasePolicy =
    input.sandbox?.lifecycle?.onRelease
    ?? RUNTIME_PLAN_DEFAULTS.sandboxReleasePolicy;
  if (sandboxReleasePolicy !== "pool" && sandboxReleasePolicy !== "destroy") {
    throw new Error("Runtime plan sandbox release policy must be one of: pool, destroy");
  }
  const sandboxIdleTtlMinutes = input.sandbox?.lifecycle?.idleTtlMinutes;
  if (
    sandboxIdleTtlMinutes !== undefined
    && (
      !Number.isInteger(sandboxIdleTtlMinutes)
      || sandboxIdleTtlMinutes < 1
      || sandboxIdleTtlMinutes > 10_080
    )
  ) {
    throw new Error(
      "Runtime plan sandbox idle TTL must be an integer between 1 and 10080 minutes",
    );
  }
  if (sandboxReleasePolicy === "destroy" && sandboxIdleTtlMinutes !== undefined) {
    throw new Error("Runtime plan sandbox idle TTL cannot be used with destroy");
  }
  const sandboxLifecycleSource =
    input.sandbox?.lifecycle?.source
    ?? RUNTIME_PLAN_DEFAULTS.sandboxLifecycleSource;
  if (
    sandboxLifecycleSource !== "request"
    && sandboxLifecycleSource !== "agent"
    && sandboxLifecycleSource !== "default"
  ) {
    throw new Error(
      "Runtime plan sandbox lifecycle source must be one of: request, agent, default",
    );
  }

  const toolExposure = input.tools?.exposure ?? RUNTIME_PLAN_DEFAULTS.toolExposure;
  assertMember(toolExposure, RUNTIME_TOOL_EXPOSURES, "Runtime plan tool exposure");

  const confidence = input.audit?.confidence;
  if (
    confidence !== undefined &&
    (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)
  ) {
    throw new Error("Runtime plan confidence must be between 0 and 1");
  }
  if (
    input.audit?.fallbackUsed !== undefined &&
    typeof input.audit.fallbackUsed !== "boolean"
  ) {
    throw new Error("Runtime plan fallbackUsed must be a boolean");
  }
  const auditLatencyMs = normalizeLatencyMap(input.audit?.latencyMs);

  const context = input.context === undefined
    ? {}
    : cloneJson(input.context, "Runtime plan context", new Set()) as RuntimeContextPolicy;

  const plan: RuntimePlan = {
    id,
    surface: input.surface,
    source: input.source,
    execution: {
      mode: executionMode,
      ...(loop ? { loop } : {}),
      source: executionSource,
    },
    model: {
      selection: modelSelection,
      ...(profile ? { profile } : {}),
      source: modelSource,
    },
    sandbox: {
      isolation: sandboxIsolation,
      source: sandboxSource,
      lifecycle: {
        onRelease: sandboxReleasePolicy,
        ...(sandboxIdleTtlMinutes !== undefined
          ? { idleTtlMinutes: sandboxIdleTtlMinutes }
          : {}),
        source: sandboxLifecycleSource,
      },
    },
    tools: {
      exposure: toolExposure,
      allowed: uniqueStrings(input.tools?.allowed, "Runtime plan allowed tools"),
    },
    guardrails: (input.guardrails ?? []).map(normalizeGuardrailDecision),
    context,
    audit: {
      resolvedAt: resolvedAt(factory),
      planner: optionalString(input.audit?.planner, "Runtime plan planner")
        ?? RUNTIME_PLAN_DEFAULTS.planner,
      reasons: uniqueStrings(input.audit?.reasons, "Runtime plan audit reasons"),
      warnings: uniqueStrings(input.audit?.warnings, "Runtime plan audit warnings"),
      policyIds: uniqueStrings(input.audit?.policyIds, "Runtime plan audit policy ids"),
      ...(confidence !== undefined ? { confidence } : {}),
      ...(auditLatencyMs !== undefined ? { latencyMs: auditLatencyMs } : {}),
      fallbackUsed: input.audit?.fallbackUsed ?? false,
    },
  };

  return freezeRuntimePlan(plan);
}

function record(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, any>;
}

/**
 * Rebuild a plan crossing a host boundary from the public allowlisted shape.
 * This strips unknown fields and re-applies every invariant even when a
 * JavaScript host bypasses the TypeScript contract.
 */
export function normalizeRuntimePlan(value: unknown): RuntimePlan {
  const plan = record(value, "Runtime plan");
  const execution = record(plan.execution, "Runtime plan execution");
  const model = record(plan.model, "Runtime plan model");
  const sandbox = record(plan.sandbox, "Runtime plan sandbox");
  const sandboxLifecycle = plan.sandbox.lifecycle === undefined
    ? undefined
    : record(plan.sandbox.lifecycle, "Runtime plan sandbox lifecycle");
  const tools = record(plan.tools, "Runtime plan tools");
  const audit = record(plan.audit, "Runtime plan audit");
  if (!Array.isArray(plan.guardrails)) {
    throw new Error("Runtime plan guardrails must be an array");
  }
  const context = record(plan.context, "Runtime plan context");
  if (!Array.isArray(tools.allowed)) {
    throw new Error("Runtime plan allowed tools must be an array");
  }
  if (!Array.isArray(audit.reasons)) {
    throw new Error("Runtime plan audit reasons must be an array");
  }
  if (!Array.isArray(audit.warnings)) {
    throw new Error("Runtime plan audit warnings must be an array");
  }
  if (!Array.isArray(audit.policyIds)) {
    throw new Error("Runtime plan audit policy ids must be an array");
  }
  const resolvedAtValue = requiredString(
    audit.resolvedAt,
    "Runtime plan audit resolvedAt",
  );

  return createRuntimePlan(
    {
      id: plan.id,
      surface: plan.surface,
      source: plan.source,
      execution: {
        mode: requiredValue(execution.mode, "Runtime plan execution mode"),
        ...(execution.loop !== undefined ? { loop: execution.loop } : {}),
        source: requiredValue(execution.source, "Runtime plan execution source"),
      },
      model: {
        selection: requiredValue(model.selection, "Runtime plan model selection"),
        ...(model.profile !== undefined ? { profile: model.profile } : {}),
        source: requiredValue(model.source, "Runtime plan model source"),
      },
      sandbox: {
        isolation: requiredValue(
          sandbox.isolation,
          "Runtime plan sandbox isolation",
        ),
        source: requiredValue(sandbox.source, "Runtime plan sandbox source"),
        ...(sandboxLifecycle
          ? {
              lifecycle: {
                onRelease: requiredValue(
                  sandboxLifecycle.onRelease,
                  "Runtime plan sandbox release policy",
                ),
                ...(sandboxLifecycle.idleTtlMinutes !== undefined
                  ? { idleTtlMinutes: sandboxLifecycle.idleTtlMinutes }
                  : {}),
                source: requiredValue(
                  sandboxLifecycle.source,
                  "Runtime plan sandbox lifecycle source",
                ),
              },
            }
          : {}),
      },
      tools: {
        exposure: requiredValue(tools.exposure, "Runtime plan tool exposure"),
        allowed: tools.allowed,
      },
      guardrails: plan.guardrails,
      context,
      audit: {
        planner: requiredValue(audit.planner, "Runtime plan planner"),
        reasons: audit.reasons,
        warnings: audit.warnings,
        policyIds: audit.policyIds,
        ...(audit.confidence !== undefined ? { confidence: audit.confidence } : {}),
        ...(audit.latencyMs !== undefined ? { latencyMs: audit.latencyMs } : {}),
        fallbackUsed: requiredValue(
          audit.fallbackUsed,
          "Runtime plan fallbackUsed",
        ),
      },
    },
    {
      createId: () => requiredString(plan.id, "Runtime plan id"),
      now: () => resolvedAtValue,
    },
  );
}
