import type {
  RuntimeDecisionSource,
  RuntimeExecutionMode,
  RuntimeGuardrailAction,
  RuntimeGuardrailPhase,
  RuntimeGuardrailRisk,
  RuntimeInvocationSource,
  RuntimeSurface,
  RuntimeToolExposure,
} from "./types.js";

export const RUNTIME_SURFACES = [
  "agent",
  "task",
  "channel",
  "webhook",
] as const satisfies readonly RuntimeSurface[];

export const RUNTIME_INVOCATION_SOURCES = [
  "request",
  "channel",
  "task",
  "schedule",
  "loop-step",
  "internal",
] as const satisfies readonly RuntimeInvocationSource[];

export const RUNTIME_DECISION_SOURCES = [
  "request",
  "agent",
  "project",
  "router",
  "default",
] as const satisfies readonly RuntimeDecisionSource[];

export const RUNTIME_EXECUTION_MODES = [
  "direct",
  "loop",
] as const satisfies readonly RuntimeExecutionMode[];

export const RUNTIME_TOOL_EXPOSURES = [
  "direct",
  "router",
] as const satisfies readonly RuntimeToolExposure[];

export const RUNTIME_GUARDRAIL_PHASES = [
  "input",
  "context",
  "model.preflight",
  "tool.before",
  "tool.after",
  "output",
] as const satisfies readonly RuntimeGuardrailPhase[];

export const RUNTIME_GUARDRAIL_ACTIONS = [
  "allow",
  "audit",
  "taint",
  "redact",
  "rewrite",
  "block",
  "approval",
] as const satisfies readonly RuntimeGuardrailAction[];

export const RUNTIME_GUARDRAIL_RISKS = [
  "none",
  "low",
  "medium",
  "high",
  "critical",
] as const satisfies readonly RuntimeGuardrailRisk[];

export const RUNTIME_PLAN_DEFAULTS = Object.freeze({
  executionMode: "direct",
  executionSource: "default",
  modelSource: "default",
  sandboxIsolation: "reuse",
  sandboxSource: "default",
  toolExposure: "direct",
  planner: "runtime-default",
} as const);
