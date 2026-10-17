import { describe, expect, it } from "vitest";
import { PolpoApiError } from "../client/errors.js";
import type { ErrorCode } from "../client/types.js";

function error(code: ErrorCode): PolpoApiError {
  return new PolpoApiError("fixture", code, 400);
}

describe("PolpoApiError client-tool settlement classification", () => {
  it.each([
    "session_not_found",
    "client_tool_call_not_found",
  ] satisfies ErrorCode[])("classifies %s as not found", (code) => {
    expect(error(code).isNotFound).toBe(true);
  });

  it.each([
    "invalid_api_key",
    "client_tool_settlement_scope_mismatch",
  ] satisfies ErrorCode[])("classifies %s as an authorization error", (code) => {
    expect(error(code).isAuthError).toBe(true);
  });

  it("classifies invalid_client_tool_settlement as validation", () => {
    expect(error("invalid_client_tool_settlement").isValidationError).toBe(true);
  });

  it.each([
    "session_version_conflict",
    "client_tool_call_not_pending",
    "client_tool_call_unverifiable",
    "client_tool_settlement_conflict",
    "continuation_already_accepted",
    "idempotency_conflict",
    "client_tool_settlement_corrupt",
  ] satisfies ErrorCode[])("classifies %s as a conflict", (code) => {
    expect(error(code).isConflict).toBe(true);
  });

  it("does not treat an unavailable host capability as an application conflict", () => {
    const unavailable = error("client_tool_settlement_unavailable");
    expect(unavailable.isNotFound).toBe(false);
    expect(unavailable.isAuthError).toBe(false);
    expect(unavailable.isValidationError).toBe(false);
    expect(unavailable.isConflict).toBe(false);
  });
});
