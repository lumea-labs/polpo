/**
 * Provider-neutral runtime sandbox policy.
 *
 * Core carries the caller's isolation preference through RunnerConfig; the
 * host sandbox provider decides how to materialize reuse or fresh allocation.
 */

export type SandboxIsolation = "reuse" | "fresh";

export interface RuntimeSandboxOptions {
  /**
   * `reuse` lets the host reuse a warm project sandbox when available.
   * `fresh` requests one clean sandbox for the outer run. Root tools and
   * nested loop steps share it until that run finishes.
   */
  isolation?: SandboxIsolation;
}

const VALID_ISOLATION: ReadonlySet<string> = new Set(["reuse", "fresh"]);

function normalizeRuntimeSandboxOptions(value: unknown): RuntimeSandboxOptions | undefined {
  if (!value || typeof value !== "object") return undefined;
  const isolation = (value as { isolation?: unknown }).isolation;
  if (isolation === undefined) return undefined;
  if (typeof isolation !== "string" || !VALID_ISOLATION.has(isolation)) return undefined;
  return { isolation: isolation as SandboxIsolation };
}

export function resolveRuntimeSandboxOptions(
  settings?: { sandbox?: RuntimeSandboxOptions },
  agent?: { sandbox?: RuntimeSandboxOptions },
  request?: { sandbox?: RuntimeSandboxOptions },
): RuntimeSandboxOptions | undefined {
  const merged: RuntimeSandboxOptions = {};
  for (const source of [settings?.sandbox, agent?.sandbox, request?.sandbox]) {
    const normalized = normalizeRuntimeSandboxOptions(source);
    if (normalized?.isolation !== undefined) merged.isolation = normalized.isolation;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}
