import type { ErrorCode } from "./types.js";

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
    return this.code === "NOT_FOUND" || this.code === "SANDBOX_NOT_FOUND";
  }

  get isAuthError(): boolean {
    return this.code === "AUTH_REQUIRED"
      || this.code === "FORBIDDEN"
      || this.code === "SANDBOX_FORBIDDEN";
  }

  get isValidationError(): boolean {
    return this.code === "VALIDATION_ERROR"
      || this.code === "SANDBOX_INVALID_REQUEST";
  }

  get isConflict(): boolean {
    return this.code === "INVALID_STATE"
      || this.code === "CONFLICT"
      || this.code === "SANDBOX_BUSY"
      || this.code === "SANDBOX_STATE_CONFLICT";
  }
}
