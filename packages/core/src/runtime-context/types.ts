import type { RuntimeGuardrailDecision } from "../runtime-plan/types.js";

export type RuntimeContextTrust =
  | "system"
  | "developer"
  | "user"
  | "external"
  | "untrusted";

/**
 * Context trust is opt-in until a host explicitly enables enforcement.
 * The serializable value survives process and deployment boundaries.
 */
export type RuntimeContextTrustMode = "off" | "enforce";

export interface RuntimeContextSegment {
  readonly kind: string;
  readonly sourceId?: string;
  readonly trust: RuntimeContextTrust;
  readonly content: string;
  readonly truncated?: boolean;
  readonly findings?: readonly RuntimeGuardrailDecision[];
}

export interface CreateRuntimeContextSegmentInput {
  readonly kind: string;
  readonly sourceId?: string;
  readonly trust: RuntimeContextTrust;
  readonly content: string;
  readonly truncated?: boolean;
  readonly findings?: readonly RuntimeGuardrailDecision[];
}

export interface RuntimeContextSegmentOptions {
  readonly maxCharacters?: number;
}
