export type ConnectErrorCode =
  | "invalid_request"
  | "invalid_provider"
  | "invalid_scope"
  | "provider_not_found"
  | "unsupported_auth"
  | "connection_not_found"
  | "connection_revoked"
  | "secret_not_found"
  | "token_not_available"
  | "token_exchange_failed"
  | "oauth_state_not_found"
  | "oauth_state_expired"
  | "oauth_error"
  | "policy_denied"
  | "http_error";

export class ConnectError extends Error {
  readonly code: ConnectErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ConnectErrorCode, message: string, options: { status?: number; details?: unknown } = {}) {
    super(message);
    this.name = "ConnectError";
    this.code = code;
    this.status = options.status ?? defaultStatus(code);
    this.details = options.details;
  }
}

function defaultStatus(code: ConnectErrorCode): number {
  switch (code) {
    case "invalid_request":
    case "invalid_provider":
    case "invalid_scope":
    case "unsupported_auth":
    case "oauth_error":
      return 400;
    case "connection_not_found":
    case "provider_not_found":
    case "oauth_state_not_found":
    case "secret_not_found":
      return 404;
    case "connection_revoked":
    case "oauth_state_expired":
    case "policy_denied":
      return 403;
    case "token_exchange_failed":
    case "token_not_available":
    case "http_error":
      return 502;
    default:
      return 500;
  }
}

export function isConnectError(error: unknown): error is ConnectError {
  return error instanceof ConnectError;
}
