import type {
  ToolInvocationContext,
  ToolInvocationJsonValue,
} from "./tool-invocation.js";

export const MAX_CONNECTION_SLOTS = 16;
export const MAX_CONNECTION_SLOT_SCOPES = 32;
export const MAX_CONNECTION_SLOT_TEXT_LENGTH = 256;

const SLOT_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9._:-]*$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export interface ConnectionSlotSpec {
  readonly provider?: string;
  readonly scopes: readonly string[];
  readonly description?: string;
}

export type ConnectionSlotSpecs = Readonly<Record<string, ConnectionSlotSpec>>;

export interface ConnectionCapability {
  readonly providerId: string;
  readonly scopes: readonly string[];
  readonly metadata?: Readonly<Record<string, ToolInvocationJsonValue>>;
  getHeaders(): Readonly<Record<string, string>> | undefined;
  getToken(): string | undefined;
  getKey(): string | undefined;
}

export interface ResolvedConnectionCapability {
  readonly providerId: string;
  readonly scopes: readonly string[];
  readonly metadata?: Readonly<Record<string, ToolInvocationJsonValue>>;
  getHeaders?(): Readonly<Record<string, string>> | undefined;
  getToken?(): string | undefined;
  getKey?(): string | undefined;
  dispose?(): void | Promise<void>;
}

export interface ConnectionCapabilityResolveInput {
  readonly slot: string;
  readonly spec: ConnectionSlotSpec;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly invocation: ToolInvocationContext;
  readonly signal?: AbortSignal;
}

export interface ConnectionCapabilityResolver {
  resolve(
    input: ConnectionCapabilityResolveInput,
  ): Promise<ResolvedConnectionCapability>;
}

export type ConnectionSelectionErrorCode =
  | "connection_scope_denied"
  | "connection_not_found_for_scope"
  | "connection_selection_ambiguous"
  | "connection_slot_invalid"
  | "connection_resolver_unavailable";

function connectionSelectionStatus(code: ConnectionSelectionErrorCode): number {
  switch (code) {
    case "connection_scope_denied": return 403;
    case "connection_not_found_for_scope": return 404;
    case "connection_selection_ambiguous": return 409;
    case "connection_slot_invalid": return 422;
    case "connection_resolver_unavailable": return 503;
  }
}

export class ConnectionSelectionError extends Error {
  readonly status: number;
  readonly slot?: string;
  readonly cause?: unknown;

  constructor(
    readonly code: ConnectionSelectionErrorCode,
    message: string,
    options: { slot?: string; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "ConnectionSelectionError";
    this.status = connectionSelectionStatus(code);
    this.slot = options.slot;
    this.cause = options.cause;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizedText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_CONNECTION_SLOT_TEXT_LENGTH) return null;
  return normalized;
}

export function getConnectionSlotSpecErrors(value: unknown): string[] {
  if (!isPlainRecord(value)) {
    return ["`connections` must be a plain object when provided"];
  }
  const entries = Object.entries(value);
  if (entries.length === 0) {
    return ["`connections` must declare at least one logical slot"];
  }
  if (entries.length > MAX_CONNECTION_SLOTS) {
    return [`\`connections\` cannot declare more than ${MAX_CONNECTION_SLOTS} slots`];
  }

  const errors: string[] = [];
  for (const [slot, candidate] of entries) {
    if (!SLOT_NAME_RE.test(slot) || FORBIDDEN_KEYS.has(slot)) {
      errors.push(`Connection slot name "${slot}" is invalid`);
      continue;
    }
    if (!isPlainRecord(candidate)) {
      errors.push(`Connection slot "${slot}" must be an object`);
      continue;
    }
    const unsupported = Object.keys(candidate).filter((key) =>
      key !== "provider" && key !== "scopes" && key !== "description");
    if (unsupported.length > 0) {
      errors.push(`Connection slot "${slot}" contains unsupported fields: ${unsupported.join(", ")}`);
    }
    if (candidate.provider !== undefined) {
      const provider = normalizedText(candidate.provider);
      if (!provider || !PROVIDER_ID_RE.test(provider)) {
        errors.push(`Connection slot "${slot}" provider is invalid`);
      }
    }
    if (
      !Array.isArray(candidate.scopes)
      || candidate.scopes.length === 0
      || candidate.scopes.length > MAX_CONNECTION_SLOT_SCOPES
    ) {
      errors.push(
        `Connection slot "${slot}" scopes must contain between 1 and ${MAX_CONNECTION_SLOT_SCOPES} entries`,
      );
    } else {
      for (const scope of candidate.scopes) {
        if (normalizedText(scope) === null) {
          errors.push(`Connection slot "${slot}" contains an invalid scope`);
          break;
        }
      }
    }
    if (candidate.description !== undefined && normalizedText(candidate.description) === null) {
      errors.push(`Connection slot "${slot}" description is invalid`);
    }
  }
  return errors;
}

export function normalizeConnectionSlotSpecs(value: unknown): ConnectionSlotSpecs {
  const errors = getConnectionSlotSpecErrors(value);
  if (errors.length > 0) {
    throw new ConnectionSelectionError(
      "connection_slot_invalid",
      `Invalid Connection slot declaration:\n- ${errors.join("\n- ")}`,
    );
  }

  const normalized: Record<string, ConnectionSlotSpec> = {};
  for (const [slot, raw] of Object.entries(value as Record<string, unknown>)) {
    const candidate = raw as Record<string, unknown>;
    const scopes = [...new Set((candidate.scopes as string[]).map((scope) => scope.trim()))];
    normalized[slot] = Object.freeze({
      ...(candidate.provider === undefined
        ? {}
        : { provider: (candidate.provider as string).trim() }),
      scopes: Object.freeze(scopes),
      ...(candidate.description === undefined
        ? {}
        : { description: (candidate.description as string).trim() }),
    });
  }
  return Object.freeze(normalized);
}
