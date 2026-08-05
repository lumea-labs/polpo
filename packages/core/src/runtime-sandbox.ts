/**
 * Provider-neutral runtime sandbox policy.
 *
 * Core carries the caller's isolation preference through RunnerConfig; the
 * host sandbox provider decides how to materialize exclusive reuse, fresh
 * allocation, or explicit project-scoped sharing.
 */

export type SandboxIsolation = "reuse" | "fresh" | "shared";
export type SandboxReleasePolicy = "pool" | "destroy";

export const SANDBOX_IDLE_TTL_MINUTES_MAX = 7 * 24 * 60;

export interface RuntimeSandboxLifecycleOptions {
  /** What the host should do after the outer run releases the sandbox. */
  onRelease?: SandboxReleasePolicy;
  /**
   * Stop a pooled sandbox after this many minutes without activity.
   * Hosts may enforce this at minute precision. Only applies to `pool`.
   */
  stopAfterIdleMinutes?: number;
  /**
   * Delete a stopped sandbox after this many minutes. `0` requests deletion
   * immediately after stop. Only applies to `pool`.
   */
  deleteAfterStopMinutes?: number;
  /**
   * Legacy compressed lifecycle control. Hosts preserve its historical
   * semantics when it is supplied on its own.
   *
   * @deprecated Use `stopAfterIdleMinutes` and `deleteAfterStopMinutes`.
   */
  idleTtlMinutes?: number;
}

export interface RuntimeSandboxOptions {
  /**
   * `reuse` lets the host reuse a warm project sandbox when available.
   * `fresh` requests one clean sandbox for the outer run. `shared` opts into
   * a host-managed project sandbox that concurrent outer runs may use. Root
   * tools and nested loop steps always share one lease inside their outer run.
   */
  isolation?: SandboxIsolation;
  lifecycle?: RuntimeSandboxLifecycleOptions;
}

const VALID_ISOLATION: ReadonlySet<string> = new Set(["reuse", "fresh", "shared"]);
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

function validDeleteAfterStopMinutes(value: unknown): value is number {
  return Number.isInteger(value)
    && (value as number) >= 0
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
      stopAfterIdleMinutes?: unknown;
      deleteAfterStopMinutes?: unknown;
      idleTtlMinutes?: unknown;
    };
    const normalizedLifecycle: RuntimeSandboxLifecycleOptions = {};
    if (
      typeof lifecycle.onRelease === "string"
      && VALID_RELEASE_POLICY.has(lifecycle.onRelease)
    ) {
      normalizedLifecycle.onRelease = lifecycle.onRelease as SandboxReleasePolicy;
    }
    if (normalizedLifecycle.onRelease !== "destroy") {
      // Preserve legacy payloads deterministically. Strict API schemas reject
      // mixed legacy/new controls, but this lenient resolver may receive
      // untyped persisted config from older hosts.
      if (validIdleTtlMinutes(lifecycle.idleTtlMinutes)) {
        normalizedLifecycle.idleTtlMinutes = lifecycle.idleTtlMinutes;
      } else {
        if (validIdleTtlMinutes(lifecycle.stopAfterIdleMinutes)) {
          normalizedLifecycle.stopAfterIdleMinutes = lifecycle.stopAfterIdleMinutes;
        }
        if (validDeleteAfterStopMinutes(lifecycle.deleteAfterStopMinutes)) {
          normalizedLifecycle.deleteAfterStopMinutes = lifecycle.deleteAfterStopMinutes;
        }
      }
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
          delete lifecycle.stopAfterIdleMinutes;
          delete lifecycle.deleteAfterStopMinutes;
          delete lifecycle.idleTtlMinutes;
        }
      }
      if (lifecycle.onRelease !== "destroy") {
        if (normalized.lifecycle.idleTtlMinutes !== undefined) {
          delete lifecycle.stopAfterIdleMinutes;
          delete lifecycle.deleteAfterStopMinutes;
          lifecycle.idleTtlMinutes = normalized.lifecycle.idleTtlMinutes;
        } else {
          if (normalized.lifecycle.stopAfterIdleMinutes !== undefined) {
            delete lifecycle.idleTtlMinutes;
            lifecycle.stopAfterIdleMinutes = normalized.lifecycle.stopAfterIdleMinutes;
          }
          if (normalized.lifecycle.deleteAfterStopMinutes !== undefined) {
            delete lifecycle.idleTtlMinutes;
            lifecycle.deleteAfterStopMinutes = normalized.lifecycle.deleteAfterStopMinutes;
          }
        }
      }
      if (Object.keys(lifecycle).length > 0) merged.lifecycle = lifecycle;
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}
