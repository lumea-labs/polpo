import { ConnectError } from "./errors.js";
import { resolveConnectorHttpRequest } from "./http-policy.js";
import { normalizeScopes } from "./scopes.js";
import type { ConnectorHttpPolicy, ConnectorProtocol } from "./types.js";

/** Local prerequisites only. A passed result does not verify provider consent or credentials. */
export interface ConnectorSetupReadinessInput {
  providerId: string;
  authenticationId?: string;
  projectId?: string;
  orgId?: string;
  oauthClientMode?: "managed" | "customer" | "instance";
  redirectUri?: string;
}

export interface ConnectorSetupReadinessResult {
  providerId: string;
  authenticationId: string;
  check: "configuration";
  outcome: "passed" | "failed" | "inconclusive" | "unsupported";
  code: string;
  checkedAt: string;
  configurationVersion: string;
  nextStep?: "credentials" | "oauth_consent" | "mcp_discovery" | "create";
}

/** A non-destructive, explicitly configured probe; its response body is never returned. */
export type ConnectorVerificationProbe = {
  kind: "http";
  path: string;
  query?: Record<string, string>;
  scopes?: string[];
  /** Only use an account endpoint that requires authentication, not a public health check. */
  account?: { idPath: string[]; labelPath?: string[] };
} | { kind: "mcp_discovery"; scopes?: string[] };

export interface ConnectionVerificationResult {
  connectionId: string;
  providerId: string;
  check: "authenticated_operation" | "operation" | "mcp_discovery" | "configuration";
  outcome: "passed" | "failed" | "inconclusive" | "unsupported";
  code: string;
  checkedAt: string;
  credentialVersion: string;
  configurationVersion: string;
  account?: { id: string; label?: string };
  toolCount?: number;
}

export interface ConnectionVerificationStore {
  saveConnectionVerification(result: ConnectionVerificationResult): Promise<void>;
}

function invalid(): never { throw new ConnectError("invalid_provider", "Invalid non-destructive Connector verification probe"); }
function fieldPath(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 8 || value.some((part) =>
    typeof part !== "string" || !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(part) || ["__proto__", "constructor", "prototype"].includes(part))) invalid();
  return [...value] as string[];
}

export function normalizeConnectorVerification(
  value: unknown,
  protocol: ConnectorProtocol,
  http?: ConnectorHttpPolicy,
): ConnectorVerificationProbe {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const input = value as Record<string, unknown>;
  if (input.scopes !== undefined && (!Array.isArray(input.scopes) || input.scopes.length > 128
    || input.scopes.some((scope) => typeof scope !== "string" || scope.length > 2048))) invalid();
  const scopes = normalizeScopes(input.scopes as string[] | undefined);
  if (protocol === "mcp") {
    if (input.kind !== "mcp_discovery" || Object.keys(input).some((key) => !["kind", "scopes"].includes(key))) invalid();
    return { kind: "mcp_discovery", scopes };
  }
  if (input.kind !== "http" || !http || Object.keys(input).some((key) => !["kind", "path", "query", "scopes", "account"].includes(key))) invalid();
  const query: Record<string, string> = {};
  if (input.query !== undefined) {
    if (!input.query || typeof input.query !== "object" || Array.isArray(input.query) || Object.keys(input.query).length > 32) invalid();
    for (const [key, value] of Object.entries(input.query)) {
      if (typeof value !== "string" || value.length > 2048) invalid();
      query[key] = value;
    }
  }
  try { resolveConnectorHttpRequest(http, { method: "GET", path: input.path as string, query }); } catch { invalid(); }
  let account: Extract<ConnectorVerificationProbe, { kind: "http" }>["account"];
  if (input.account !== undefined) {
    if (!input.account || typeof input.account !== "object" || Array.isArray(input.account)) invalid();
    const fields = input.account as Record<string, unknown>;
    account = { idPath: fieldPath(fields.idPath), ...(fields.labelPath === undefined ? {} : { labelPath: fieldPath(fields.labelPath) }) };
  }
  return { kind: "http", path: input.path as string, scopes, ...(input.query === undefined ? {} : { query }), ...(account ? { account } : {}) };
}
