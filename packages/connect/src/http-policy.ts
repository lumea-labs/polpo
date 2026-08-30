import {
  ConnectionSelectionError,
  type ConnectionRequest,
} from "@polpo-ai/core";

import type { ConnectorHttpPolicy } from "./types.js";

const DEFAULT_METHODS = ["GET"];
const DEFAULT_MAX_REQUEST_BYTES = 256 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_HTTP_BYTES = 64 * 1024 * 1024;
const MAX_TIMEOUT_MS = 10 * 60_000;

const FORBIDDEN_REQUEST_HEADERS = new Set([
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "forwarded",
  "host",
  "idempotency-key",
  "proxy-authorization",
  "proxy-connection",
  "set-cookie",
  "transfer-encoding",
  "upgrade",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
]);

export interface ResolvedConnectorHttpRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  idempotencyKey: string | undefined;
  timeoutMs: number;
  maxResponseBytes: number;
  followRedirects: boolean;
}

function denied(message: string): never {
  throw new ConnectionSelectionError("connection_operation_denied", message);
}

function positiveInteger(
  name: string,
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate <= 0 || candidate > maximum) {
    denied(`Connector HTTP policy ${name} is invalid`);
  }
  return candidate;
}

function normalizeOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    denied(`Connector HTTP origin is invalid: ${value}`);
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
    || isUnsafeHostname(url.hostname)
  ) {
    denied(`Connector HTTP origin is not a safe public HTTPS origin: ${value}`);
  }
  return url.origin;
}

function isUnsafeHostname(rawHostname: string): boolean {
  const hostname = rawHostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (
    !hostname
    || hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".internal")
  ) return true;

  if (hostname.includes(":")) {
    if (hostname === "::" || hostname === "::1") return true;
    if (/^(?:fc|fd|fe[89ab])/i.test(hostname)) return true;
    const mapped = hostname.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
    return mapped ? isUnsafeIpv4(mapped) : false;
  }
  return /^\d+\.\d+\.\d+\.\d+$/.test(hostname)
    ? isUnsafeIpv4(hostname)
    : false;
}

function isUnsafeIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map(Number);
  if (
    parts.length !== 4
    || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) return true;
  const [a, b, c] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && c === 2)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

function normalizePathPattern(pattern: string): string {
  const normalized = pattern.trim();
  if (
    !normalized.startsWith("/")
    || normalized.startsWith("//")
    || normalized.includes("\\")
    || normalized.includes("?")
    || normalized.includes("#")
    || (normalized.includes("*") && !normalized.endsWith("*"))
    || normalized.slice(0, -1).includes("*")
  ) {
    denied(`Connector HTTP path pattern is invalid: ${pattern}`);
  }
  assertNoPathTraversal(normalized.replace(/\*$/, ""));
  return normalized;
}

function assertNoPathTraversal(path: string): void {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    denied("Connection request path contains invalid percent encoding");
  }
  if (
    decoded.includes("\\")
    || decoded.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    denied("Connection request path traversal is not allowed");
  }
}

function pathAllowed(pathname: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => pattern.endsWith("*")
    ? pathname.startsWith(pattern.slice(0, -1))
    : pathname === pattern);
}

export function normalizeConnectorHttpPolicy(
  input: ConnectorHttpPolicy,
): ConnectorHttpPolicy {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    denied("Connector HTTP policy must be an object");
  }
  if (!Array.isArray(input.origins) || input.origins.length === 0 || input.origins.length > 16) {
    denied("Connector HTTP policy must declare between 1 and 16 origins");
  }
  const origins = [...new Set(input.origins.map(normalizeOrigin))];
  const methods = [...new Set((input.allowedMethods ?? DEFAULT_METHODS).map((method) => {
    const normalized = method.trim().toUpperCase();
    if (!/^[A-Z]+$/.test(normalized)) denied(`Connector HTTP method is invalid: ${method}`);
    return normalized;
  }))];
  if (methods.length === 0 || methods.length > 16) {
    denied("Connector HTTP policy must allow between 1 and 16 methods");
  }
  const patterns = [...new Set((input.allowedPathPatterns ?? ["/*"]).map(normalizePathPattern))];
  if (patterns.length === 0 || patterns.length > 128) {
    denied("Connector HTTP policy must allow between 1 and 128 path patterns");
  }
  if (!input.auth || !["bearer", "header", "query"].includes(input.auth.mode)) {
    denied("Connector HTTP auth policy is invalid");
  }
  const authName = input.auth.name?.trim();
  if (
    (input.auth.mode === "header" || input.auth.mode === "query")
    && (!authName || !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(authName))
  ) {
    denied(`Connector HTTP ${input.auth.mode} auth requires a safe name`);
  }

  return Object.freeze({
    origins: Object.freeze(origins) as unknown as string[],
    allowedMethods: Object.freeze(methods) as unknown as string[],
    allowedPathPatterns: Object.freeze(patterns) as unknown as string[],
    auth: Object.freeze({
      mode: input.auth.mode,
      ...(authName ? { name: authName } : {}),
    }),
    followRedirects: input.followRedirects === true,
    maxRequestBytes: positiveInteger(
      "maxRequestBytes",
      input.maxRequestBytes,
      DEFAULT_MAX_REQUEST_BYTES,
      MAX_HTTP_BYTES,
    ),
    maxResponseBytes: positiveInteger(
      "maxResponseBytes",
      input.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      MAX_HTTP_BYTES,
    ),
    timeoutMs: positiveInteger("timeoutMs", input.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
  });
}

export function resolveConnectorHttpRequest(
  rawPolicy: ConnectorHttpPolicy,
  input: ConnectionRequest,
): ResolvedConnectorHttpRequest {
  const policy = normalizeConnectorHttpPolicy(rawPolicy);
  const method = input.method?.trim().toUpperCase();
  if (!method || !/^[A-Z]+$/.test(method) || !policy.allowedMethods!.includes(method)) {
    denied(`Connection request method is not allowed: ${input.method}`);
  }
  if (
    typeof input.path !== "string"
    || !input.path.startsWith("/")
    || input.path.startsWith("//")
    || input.path.includes("\\")
    || input.path.includes("?")
    || input.path.includes("#")
  ) {
    denied("Connection request path must be an absolute provider-relative path without query or fragment");
  }
  assertNoPathTraversal(input.path);
  const base = policy.origins[0];
  const url = new URL(input.path, `${base}/`);
  if (url.origin !== base || !pathAllowed(url.pathname, policy.allowedPathPatterns!)) {
    denied(`Connection request path is not allowed: ${input.path}`);
  }
  for (const [name, value] of Object.entries(input.query ?? {})) {
    if (!name || /[\u0000-\u001f\u007f]/.test(name)) denied("Connection query name is invalid");
    if (
      policy.auth.mode === "query"
      && name.toLowerCase() === policy.auth.name!.toLowerCase()
    ) {
      denied(`Connection request cannot override auth query parameter "${name}"`);
    }
    const values = Array.isArray(value) ? value : [value];
    for (const entry of values) {
      if (typeof entry !== "string") denied(`Connection query value for "${name}" is invalid`);
      url.searchParams.append(name, entry);
    }
  }

  const headers: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(input.headers ?? {})) {
    const name = rawName.trim().toLowerCase();
    if (
      !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)
      || FORBIDDEN_REQUEST_HEADERS.has(name)
      || name.startsWith("proxy-")
      || name.startsWith("sec-")
      || typeof value !== "string"
      || /[\r\n]/.test(value)
    ) {
      denied(`Connection request header is not allowed: ${rawName}`);
    }
    headers[name] = value;
  }

  if (input.idempotencyKey !== undefined) {
    if (
      typeof input.idempotencyKey !== "string"
      || !input.idempotencyKey.trim()
      || input.idempotencyKey.length > 256
      || /[\r\n]/.test(input.idempotencyKey)
    ) {
      denied("Connection request idempotency key is invalid");
    }
  }

  if (input.body !== undefined) {
    let serialized: string;
    try {
      serialized = JSON.stringify(input.body);
    } catch {
      denied("Connection request body must be JSON serializable");
    }
    if (serialized === undefined) denied("Connection request body must be JSON serializable");
    const size = new TextEncoder().encode(serialized).byteLength;
    if (size > policy.maxRequestBytes!) denied("Connection request body exceeds the Connector limit");
  }

  const requestedTimeout = input.timeoutMs === undefined
    ? policy.timeoutMs!
    : positiveInteger("request timeoutMs", input.timeoutMs, policy.timeoutMs!, MAX_TIMEOUT_MS);

  return {
    url: url.toString(),
    method,
    headers,
    body: input.body,
    idempotencyKey: input.idempotencyKey,
    timeoutMs: Math.min(requestedTimeout, policy.timeoutMs!),
    maxResponseBytes: policy.maxResponseBytes!,
    followRedirects: policy.followRedirects === true,
  };
}

export function assertConnectorRedirectAllowed(
  rawPolicy: ConnectorHttpPolicy,
  destination: string,
): string {
  const policy = normalizeConnectorHttpPolicy(rawPolicy);
  if (!policy.followRedirects) denied("Connector redirects are disabled");
  let url: URL;
  try {
    url = new URL(destination);
  } catch {
    denied("Connector redirect destination is invalid");
  }
  if (
    !policy.origins.includes(url.origin)
    || url.username
    || url.password
    || isUnsafeHostname(url.hostname)
    || !pathAllowed(url.pathname, policy.allowedPathPatterns!)
  ) {
    denied("Connector redirect destination is not allowed");
  }
  assertNoPathTraversal(url.pathname);
  return url.toString();
}

export function connectorHostnameIsUnsafe(hostname: string): boolean {
  return isUnsafeHostname(hostname);
}
