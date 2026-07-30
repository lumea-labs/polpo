import { createDefaultToolGuardrailPolicies } from "./detectors.js";
import { RuntimeGuardrailEngine } from "./engine.js";
import { createRunToolMiddleware } from "./tool-middleware.js";
import type {
  RunToolMiddleware,
  RuntimeGuardrailHostAdapters,
  RuntimeGuardrailSettings,
} from "./types.js";

export function normalizeRuntimeGuardrailSettings(
  value: unknown,
): RuntimeGuardrailSettings | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("guardrails must be an object");
  }

  const raw = value as Record<string, unknown>;
  if (raw.toolPolicyPack === undefined && Object.keys(raw).length === 0) {
    return undefined;
  }
  if (raw.toolPolicyPack !== "default") {
    throw new TypeError('guardrails.toolPolicyPack must be "default"');
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
  return Object.freeze({
    toolPolicyPack: "default",
    ...(maxToolOutputCharacters !== undefined ? { maxToolOutputCharacters } : {}),
    ...(readOnlyPolicyFailure !== undefined ? { readOnlyPolicyFailure } : {}),
  });
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
  if (!settings) return undefined;

  const engine = new RuntimeGuardrailEngine(
    createDefaultToolGuardrailPolicies(),
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
