import { describe, expect, it } from "vitest";
import {
  SANDBOX_ACTIONS,
  SANDBOX_ALLOCATION_STATES,
  SANDBOX_HEALTH_STATES,
  SANDBOX_MANAGEMENT_ERROR_CODES,
  SANDBOX_OPERATIONAL_STATES,
  SandboxManagementError,
  isSandboxManagementError,
} from "../sandbox-management.js";

describe("sandbox management contracts", () => {
  it("publishes stable exhaustive state and action values", () => {
    expect(SANDBOX_OPERATIONAL_STATES).toEqual([
      "provisioning",
      "running",
      "stopped",
      "archived",
      "deleting",
      "deleted",
      "error",
      "unknown",
    ]);
    expect(SANDBOX_ALLOCATION_STATES).toEqual([
      "idle",
      "leased",
      "shared",
      "reserved",
      "untracked",
    ]);
    expect(SANDBOX_HEALTH_STATES).toEqual(["healthy", "degraded", "stale"]);
    expect(SANDBOX_ACTIONS).toEqual(["start", "stop", "destroy"]);
  });

  it("uses typed errors without making arbitrary errors look trusted", () => {
    const error = new SandboxManagementError(
      "SANDBOX_BUSY",
      "Sandbox is currently leased",
      { retryable: true, details: { holders: 1 } },
    );

    expect(isSandboxManagementError(error)).toBe(true);
    expect(isSandboxManagementError(new Error("SANDBOX_BUSY"))).toBe(false);
    expect(error).toMatchObject({
      name: "SandboxManagementError",
      code: "SANDBOX_BUSY",
      retryable: true,
      details: { holders: 1 },
    });
    expect(SANDBOX_MANAGEMENT_ERROR_CODES).toContain(error.code);
  });
});

