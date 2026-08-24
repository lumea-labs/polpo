/**
 * A host-authorized runtime failure that is safe to expose to API clients.
 *
 * Hosts must use this only for deterministic resource/configuration failures.
 * Arbitrary provider and internal errors continue to fail closed as 500s.
 */
export class CompletionRuntimeError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "CompletionRuntimeError";
    this.code = code;
    this.status = status;
  }
}

export function completionRuntimeErrorEnvelope(error: unknown): {
  status: number;
  error: {
    message: string;
    type: "runtime_error";
    code: string;
  };
} | null {
  if (!(error instanceof CompletionRuntimeError)) return null;
  const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599
    ? error.status
    : 500;
  return {
    status,
    error: {
      message: error.message,
      type: "runtime_error",
      code: error.code,
    },
  };
}
