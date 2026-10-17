import type { ErrorCode } from "./types.js";

const NOT_FOUND_CODES = new Set<ErrorCode>([
  "NOT_FOUND",
  "data_not_found",
  "session_not_found",
  "client_tool_call_not_found",
]);

const AUTH_ERROR_CODES = new Set<ErrorCode>([
  "AUTH_REQUIRED",
  "FORBIDDEN",
  "data_forbidden",
  "invalid_api_key",
  "client_tool_settlement_scope_mismatch",
]);

const VALIDATION_ERROR_CODES = new Set<ErrorCode>([
  "VALIDATION_ERROR",
  "data_invalid",
  "data_constraint",
  "invalid_client_tool_settlement",
]);

const CONFLICT_CODES = new Set<ErrorCode>([
  "INVALID_STATE",
  "CONFLICT",
  "data_conflict",
  "session_version_conflict",
  "client_tool_call_not_pending",
  "client_tool_call_unverifiable",
  "client_tool_settlement_conflict",
  "continuation_already_accepted",
  "idempotency_conflict",
  "client_tool_settlement_corrupt",
]);

export class PolpoApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(message: string, code: ErrorCode, status: number, details?: unknown) {
    super(message);
    this.name = "PolpoApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }

  get isNotFound(): boolean {
    return NOT_FOUND_CODES.has(this.code);
  }

  get isAuthError(): boolean {
    return AUTH_ERROR_CODES.has(this.code);
  }

  get isValidationError(): boolean {
    return VALIDATION_ERROR_CODES.has(this.code);
  }

  get isConflict(): boolean {
    return CONFLICT_CODES.has(this.code);
  }
}
