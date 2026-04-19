/**
 * Security redaction module — pure functions for sanitizing sensitive data
 * before exposing it through API responses or persisting to transcript logs.
 *
 * Handles:
 * - Provider API key masking
 * - Transcript parameter sanitization (passwords, tokens, secrets)
 *
 * NOTE: Vault credentials are no longer stored on AgentConfig — they live in
 * the encrypted vault store (.polpo/vault.enc). Agent/team/state redaction
 * functions are kept as pass-throughs for API compatibility.
 */

import type { AgentConfig, Team, PolpoState, PolpoConfig, PolpoFileConfig } from "../core/types.js";

// ── Constants ──

/** Regex matching parameter names that likely contain secrets. */
export const SENSITIVE_PARAM_RE = /pass|secret|token|key|auth|password|credential/i;

// ── Agent Config Redaction ──

/**
 * Returns the agent config as-is (vault credentials are no longer inline).
 * Kept for backward compatibility with callers that expect redaction.
 */
export function redactAgentConfig(agent: AgentConfig): AgentConfig {
  return agent;
}

// ── Team Redaction ──

/** Returns the team as-is (no inline credentials to redact). */
export function redactTeam(team: Team): Team {
  return team;
}

// ── State Redaction ──

/** Returns the state as-is (no inline credentials to redact). */
export function redactPolpoState(state: PolpoState): PolpoState {
  return state;
}

// ── Config Redaction ──

/** Return config as-is — providers no longer contain secrets (API keys resolved via env/OAuth only). */
export function redactPolpoConfig<T extends PolpoConfig | PolpoFileConfig>(config: T): T {
  return config;
}

// ── Transcript Sanitization ──

/**
 * Recursively sanitize an object, redacting any string values whose keys
 * match the SENSITIVE_PARAM_RE pattern. Handles nested objects and arrays.
 *
 * @param obj - The object to sanitize.
 * @param depth - Current recursion depth (capped to prevent DoS on cyclic data).
 * @returns A tuple of [sanitized copy, whether any value was redacted].
 */
const MAX_SANITIZE_DEPTH = 10;

function sanitizeObject(
  obj: Record<string, unknown>,
  depth: number = 0,
): [Record<string, unknown>, boolean] {
  if (depth > MAX_SANITIZE_DEPTH) return [obj, false];

  const result: Record<string, unknown> = {};
  let changed = false;

  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_PARAM_RE.test(key) && typeof value === "string") {
      result[key] = "[REDACTED]";
      changed = true;
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      const [sanitized, childChanged] = sanitizeObject(
        value as Record<string, unknown>,
        depth + 1,
      );
      result[key] = childChanged ? sanitized : value;
      if (childChanged) changed = true;
    } else if (Array.isArray(value)) {
      const [sanitized, childChanged] = sanitizeArray(value, depth + 1);
      result[key] = childChanged ? sanitized : value;
      if (childChanged) changed = true;
    } else {
      result[key] = value;
    }
  }

  return [result, changed];
}

/**
 * Recursively sanitize an array, descending into nested objects/arrays.
 */
function sanitizeArray(
  arr: unknown[],
  depth: number,
): [unknown[], boolean] {
  if (depth > MAX_SANITIZE_DEPTH) return [arr, false];

  let changed = false;
  const result = arr.map((item) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const [sanitized, childChanged] = sanitizeObject(
        item as Record<string, unknown>,
        depth + 1,
      );
      if (childChanged) changed = true;
      return childChanged ? sanitized : item;
    }
    if (Array.isArray(item)) {
      const [sanitized, childChanged] = sanitizeArray(item, depth + 1);
      if (childChanged) changed = true;
      return childChanged ? sanitized : item;
    }
    return item;
  });

  return [result, changed];
}

/**
 * Sanitize a transcript entry by masking sensitive parameter values in tool_use inputs.
 * Recursively descends into nested objects and arrays to catch secrets at any depth.
 * Only touches entries with `type === "tool_use"` that have an `input` object.
 * Returns the entry unchanged for all other types (assistant, tool_result, etc.).
 */
export function sanitizeTranscriptEntry(entry: Record<string, unknown>): Record<string, unknown> {
  if (entry.type !== "tool_use") return entry;

  const input = entry.input;
  if (!input || typeof input !== "object") return entry;

  const [sanitized, changed] = sanitizeObject(input as Record<string, unknown>);

  if (!changed) return entry;

  return { ...entry, input: sanitized };
}

