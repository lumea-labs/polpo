import {
  assertToolNameAllowedByPolicy,
  filterToolNamesByPolicy,
  resolveAllowedToolPolicy,
  toolNameAllowedByPolicy,
  type ResolvedAllowedToolPolicy,
} from "@polpo-ai/core";
import type { CompletionToolExecutor } from "./tool-guardrails.js";

export type ExecutionToolPolicyMode = "chat" | "channels" | "loop";

export function resolveExecutionToolPolicy(input: {
  agent?: {
    allowedTools?: readonly string[];
    chat?: { allowedTools?: readonly string[] };
    channels?: { allowedTools?: readonly string[] };
  };
  mode: ExecutionToolPolicyMode;
  routeAllowedTools?: readonly string[];
  requestAllowedTools?: readonly string[];
  executionAllowedTools?: readonly string[];
  loopAllowedTools?: readonly string[];
  stepAllowedTools?: readonly string[];
  grantAllowedTools?: readonly string[];
}): ResolvedAllowedToolPolicy {
  const modeAllowedTools = input.mode === "chat"
    ? input.agent?.chat?.allowedTools
    : input.mode === "channels"
      ? input.agent?.channels?.allowedTools
      : undefined;
  return resolveAllowedToolPolicy({
    global: input.agent?.allowedTools,
    mode: modeAllowedTools,
    ...(input.mode === "channels" && input.routeAllowedTools !== undefined
      ? { route: input.routeAllowedTools }
      : {}),
    request: input.requestAllowedTools,
    execution: input.executionAllowedTools,
    ...(input.mode === "loop" && input.loopAllowedTools !== undefined
      ? { loop: input.loopAllowedTools }
      : {}),
    ...(input.mode === "loop" && input.stepAllowedTools !== undefined
      ? { step: input.stepAllowedTools }
      : {}),
    grant: input.grantAllowedTools,
  });
}

export function filterToolDefinitionsByPolicy<T extends { name?: unknown }>(
  tools: readonly T[],
  policy: ResolvedAllowedToolPolicy,
): T[] {
  return tools.filter(
    (tool) => typeof tool.name === "string"
      && toolNameAllowedByPolicy(tool.name, policy),
  );
}

export function filterToolRecordByPolicy<T>(
  tools: Readonly<Record<string, T>> | undefined,
  policy: ResolvedAllowedToolPolicy,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(tools ?? {}).filter(([name]) =>
      toolNameAllowedByPolicy(name, policy)),
  );
}

export function createPolicyGuardedToolExecutor(
  executor: CompletionToolExecutor,
  policy: ResolvedAllowedToolPolicy,
): CompletionToolExecutor {
  if (!policy.restricted) return executor;
  return async (name, args, options) => {
    assertToolNameAllowedByPolicy(name, policy);
    return executor(name, args, options);
  };
}

export function toolPolicyAuditData(input: {
  policy: ResolvedAllowedToolPolicy;
  requested: readonly string[];
  mode: ExecutionToolPolicyMode;
}): Readonly<{
  denied: readonly string[];
  effective: readonly string[];
  layers: readonly { name: string; allowedTools: readonly string[] }[];
  mode: ExecutionToolPolicyMode;
  requested: readonly string[];
}> {
  const requested = [...new Set(input.requested)].sort();
  const effective = filterToolNamesByPolicy(requested, input.policy).sort();
  const effectiveSet = new Set(effective);
  return Object.freeze({
    denied: Object.freeze(requested.filter((name) => !effectiveSet.has(name))),
    effective: Object.freeze(effective),
    layers: input.policy.layers,
    mode: input.mode,
    requested: Object.freeze(requested),
  });
}
