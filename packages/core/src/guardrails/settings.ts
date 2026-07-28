import {
  createDefaultOutputGuardrailPolicies,
  createDefaultToolGuardrailPolicies,
} from "./detectors.js";
import { RuntimeGuardrailEngine } from "./engine.js";
import { createRunOutputPolicy } from "./output-policy.js";
import { createRunToolMiddleware } from "./tool-middleware.js";
import type {
  RunOutputPolicy,
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
  if (
    raw.toolPolicyPack === undefined
    && raw.outputPolicyPack === undefined
    && Object.keys(raw).length === 0
  ) {
    return undefined;
  }
  if (raw.toolPolicyPack !== undefined && raw.toolPolicyPack !== "default") {
    throw new TypeError('guardrails.toolPolicyPack must be "default"');
  }
  if (raw.outputPolicyPack !== undefined && raw.outputPolicyPack !== "default") {
    throw new TypeError('guardrails.outputPolicyPack must be "default"');
  }
  if (raw.toolPolicyPack === undefined && (
    raw.maxToolOutputCharacters !== undefined
    || raw.readOnlyPolicyFailure !== undefined
  )) {
    throw new TypeError(
      "guardrails tool settings require guardrails.toolPolicyPack",
    );
  }
  if (raw.outputPolicyPack === undefined && (
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
  if (raw.toolPolicyPack === undefined && raw.outputPolicyPack === undefined) {
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
  if (raw.outputPolicyPack !== undefined) {
    if (
      raw.streamingOutputMode !== undefined
      && raw.streamingOutputMode !== "audit"
      && raw.streamingOutputMode !== "buffer"
    ) {
      throw new TypeError(
        'guardrails.streamingOutputMode must be "audit" or "buffer"',
      );
    }
    streamingOutputMode = (raw.streamingOutputMode ?? "audit") as "audit" | "buffer";
  }
  return Object.freeze({
    ...(raw.toolPolicyPack === "default" ? { toolPolicyPack: "default" as const } : {}),
    ...(raw.outputPolicyPack === "default" ? { outputPolicyPack: "default" as const } : {}),
    ...(maxToolOutputCharacters !== undefined ? { maxToolOutputCharacters } : {}),
    ...(maxFinalOutputCharacters !== undefined ? { maxFinalOutputCharacters } : {}),
    ...(readOnlyPolicyFailure !== undefined ? { readOnlyPolicyFailure } : {}),
    ...(streamingOutputMode !== undefined ? { streamingOutputMode } : {}),
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
  if (!settings?.toolPolicyPack) return undefined;

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

export function createConfiguredRunOutputPolicy(
  value: RuntimeGuardrailSettings | undefined,
  adapters: RuntimeGuardrailHostAdapters = {},
): RunOutputPolicy | undefined {
  const settings = normalizeRuntimeGuardrailSettings(value);
  if (!settings?.outputPolicyPack) return undefined;

  const engine = new RuntimeGuardrailEngine(
    createDefaultOutputGuardrailPolicies(settings.maxFinalOutputCharacters),
    { onDecision: adapters.onDecision },
  );
  return createRunOutputPolicy(engine, {
    approval: adapters.outputApproval,
    streamingMode: settings.streamingOutputMode,
  });
}
