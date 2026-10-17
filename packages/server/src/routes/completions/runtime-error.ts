import { TerminationGateError } from "@polpo-ai/core/runtime-hooks";

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
  // Run-backed hosts serialize errors into trusted runtime transcript events.
  const gate = error && typeof error === "object" ? error as Record<string, unknown> : undefined;
  if (error instanceof TerminationGateError || (gate?.name === "TerminationGateError"
    && typeof gate.code === "string" && /^termination_gate_[a-z_]+$/.test(gate.code) && typeof gate.message === "string")) {
    return { status: 409, error: { type: "runtime_error", code: gate!.code as string, message: gate!.message as string } };
  }
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
