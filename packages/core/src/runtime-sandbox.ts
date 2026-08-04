/**
 * Provider-neutral runtime sandbox policy.
 *
 * Core carries the caller's isolation preference through RunnerConfig; the
 * host sandbox provider decides how to materialize reuse or fresh allocation.
 */

export type SandboxIsolation = "reuse" | "fresh";
export type SandboxReleasePolicy = "pool" | "destroy";

export const SANDBOX_IDLE_TTL_MINUTES_MAX = 7 * 24 * 60;

export interface RuntimeSandboxLifecycleOptions {
  /** What the host should do after the outer run releases the sandbox. */
  onRelease?: SandboxReleasePolicy;
  /**
   * Destroy a pooled sandbox after this many minutes without activity.
   * Hosts may enforce this at minute precision. Only applies to `pool`.
   */
  idleTtlMinutes?: number;
}

export interface RuntimeSandboxOptions {
  /**
   * `reuse` lets the host reuse a warm project sandbox when available.
   * `fresh` requests one clean sandbox for the outer run. Root tools and
   * nested loop steps share it until that run finishes.
   */
  isolation?: SandboxIsolation;
  lifecycle?: RuntimeSandboxLifecycleOptions;
}

const VALID_ISOLATION: ReadonlySet<string> = new Set(["reuse", "fresh"]);
const VALID_RELEASE_POLICY: ReadonlySet<string> = new Set(["pool", "destroy"]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validIdleTtlMinutes(value: unknown): value is number {
  return Number.isInteger(value)
    && (value as number) >= 1
    && (value as number) <= SANDBOX_IDLE_TTL_MINUTES_MAX;
}

function normalizeRuntimeSandboxOptions(value: unknown): RuntimeSandboxOptions | undefined {
  if (!isPlainRecord(value)) return undefined;
  const isolation = (value as { isolation?: unknown }).isolation;
  const rawLifecycle = (value as { lifecycle?: unknown }).lifecycle;
  const normalized: RuntimeSandboxOptions = {};

  if (typeof isolation === "string" && VALID_ISOLATION.has(isolation)) {
    normalized.isolation = isolation as SandboxIsolation;
  }

  if (isPlainRecord(rawLifecycle)) {
    const lifecycle = rawLifecycle as {
      onRelease?: unknown;
      idleTtlMinutes?: unknown;
    };
    const normalizedLifecycle: RuntimeSandboxLifecycleOptions = {};
    if (
      typeof lifecycle.onRelease === "string"
      && VALID_RELEASE_POLICY.has(lifecycle.onRelease)
    ) {
      normalizedLifecycle.onRelease = lifecycle.onRelease as SandboxReleasePolicy;
    }
    if (
      normalizedLifecycle.onRelease !== "destroy"
      && validIdleTtlMinutes(lifecycle.idleTtlMinutes)
    ) {
      normalizedLifecycle.idleTtlMinutes = lifecycle.idleTtlMinutes;
    }
    if (Object.keys(normalizedLifecycle).length > 0) {
      normalized.lifecycle = normalizedLifecycle;
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
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
    if (normalized?.lifecycle) {
      const lifecycle = merged.lifecycle ?? {};
      if (normalized.lifecycle.onRelease !== undefined) {
        lifecycle.onRelease = normalized.lifecycle.onRelease;
        if (lifecycle.onRelease === "destroy") {
          delete lifecycle.idleTtlMinutes;
        }
      }
      if (
        normalized.lifecycle.idleTtlMinutes !== undefined
        && lifecycle.onRelease !== "destroy"
      ) {
        lifecycle.idleTtlMinutes = normalized.lifecycle.idleTtlMinutes;
      }
      if (Object.keys(lifecycle).length > 0) merged.lifecycle = lifecycle;
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}
