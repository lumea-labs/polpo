/**
 * SSRF-hardened fetch for agent HTTP tools.
 *
 * - Redirects are followed manually so the SSRF guard runs on every hop
 *   (`redirect: "follow"` let a public URL bounce to 169.254.169.254).
 * - Hostnames are checked against the addresses DNS actually returns, inside
 *   the socket `lookup` of the dispatcher, so the address that is validated is
 *   the address that is connected to (no DNS-rebinding window). Same approach
 *   as the Connect public-network transport, but allowing http:// as well.
 * - Response bodies are read through a byte cap, under the caller's signal.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { assertUrlAllowed, blockedAddressReason } from "./ssrf-guard.js";

export type ResolveHostname = (hostname: string) => Promise<readonly string[]>;

const defaultResolveHostname: ResolveHostname = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map((answer) => answer.address);

export const DEFAULT_MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const CREDENTIAL_HEADERS = new Set(["authorization", "cookie", "proxy-authorization"]);
const BODY_HEADERS = new Set(["content-type", "content-length", "content-encoding", "content-language", "content-location"]);

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

/** Socket lookup that only hands public addresses to net/tls.connect. */
export function publicAddressLookup(resolveHostname: ResolveHostname): LookupFunction {
  return (hostname, options, callback) => {
    const deny = (reason: string) =>
      callback(new SsrfBlockedError(`SSRF blocked: ${hostname} ${reason}`), "");
    resolveHostname(hostname).then((addresses) => {
      if (addresses.length === 0) return deny("did not resolve to any address");
      for (const address of addresses) {
        if (!isIP(address)) return deny(`resolved to an invalid address (${address})`);
        const reason = blockedAddressReason(address);
        if (reason) return deny(`resolves to ${address} (${reason}), which is not allowed`);
      }
      const answers = addresses.map((address) => ({ address, family: isIP(address) }));
      if (options.all) return callback(null, answers);
      const selected = answers.find((answer) => !options.family || answer.family === options.family);
      if (!selected) return deny("has no address of the requested family");
      callback(null, selected.address, selected.family);
    }, (err: unknown) => callback(err instanceof Error ? err as NodeJS.ErrnoException : new Error(String(err)), ""));
  };
}

type Dispatcher = object;
const dispatchers = new Map<ResolveHostname, Promise<Dispatcher | undefined>>();

/**
 * One pinned undici Agent per resolver (process-wide for the default one).
 * Returns undefined where undici is unavailable (non-Node runtimes); callers
 * then fall back to a resolve-then-connect check.
 */
function pinnedDispatcher(resolveHostname: ResolveHostname): Promise<Dispatcher | undefined> {
  let pending = dispatchers.get(resolveHostname);
  if (!pending) {
    pending = import("undici").then(
      ({ Agent }) => new Agent({ connect: { lookup: publicAddressLookup(resolveHostname) } }),
      () => undefined,
    );
    dispatchers.set(resolveHostname, pending);
  }
  return pending;
}

async function assertHostResolvesPublic(url: URL, resolveHostname: ResolveHostname): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return; // literals were already checked by assertUrlAllowed
  const addresses = await resolveHostname(host);
  if (addresses.length === 0) throw new SsrfBlockedError(`SSRF blocked: ${host} did not resolve to any address`);
  for (const address of addresses) {
    const reason = blockedAddressReason(address);
    if (reason) throw new SsrfBlockedError(`SSRF blocked: ${host} resolves to ${address} (${reason}), which is not allowed`);
  }
}

function assertHttpUrl(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfBlockedError(`SSRF blocked: unsupported URL scheme ${url.protocol}`);
  }
  try {
    assertUrlAllowed(url.href);
  } catch (err) {
    throw new SsrfBlockedError(err instanceof Error ? err.message : String(err));
  }
}

export interface SafeFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal: AbortSignal;
  maxRedirects?: number;
  /** Test hook — defaults to the system resolver. */
  resolveHostname?: ResolveHostname;
}

export interface SafeFetchResult {
  response: Response;
  /** URL of the final (non-redirect) response. */
  url: string;
  redirects: number;
}

/**
 * fetch() with the SSRF guard applied to the initial URL and every redirect
 * hop, and DNS answers validated at connect time. Throws SsrfBlockedError when
 * a hop is not allowed and Error when the redirect limit is exceeded.
 */
export async function safeFetch(rawUrl: string, options: SafeFetchOptions): Promise<SafeFetchResult> {
  const resolveHostname = options.resolveHostname ?? defaultResolveHostname;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const dispatcher = await pinnedDispatcher(resolveHostname);

  let url = new URL(rawUrl);
  let method = (options.method ?? "GET").toUpperCase();
  let body = options.body;
  let headers: Record<string, string> = { ...(options.headers ?? {}) };

  for (let redirects = 0; ; redirects++) {
    assertHttpUrl(url);
    if (!dispatcher) await assertHostResolvesPublic(url, resolveHostname);

    const init: RequestInit & { dispatcher?: Dispatcher } = {
      method,
      headers,
      body,
      signal: options.signal,
      redirect: "manual",
    };
    if (dispatcher) init.dispatcher = dispatcher;
    const response = await fetch(url.href, init);

    const location = response.headers.get("location");
    if (!REDIRECT_STATUSES.has(response.status) || !location) {
      return { response, url: url.href, redirects };
    }
    await response.body?.cancel().catch(() => undefined);
    if (redirects >= maxRedirects) {
      throw new Error(`Too many redirects (limit ${maxRedirects})`);
    }

    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      throw new Error(`Invalid redirect location: ${location}`);
    }
    // Fetch-spec method rewriting: 303 → GET; 301/302 turn POST into GET.
    if ((response.status === 303 && method !== "HEAD") || ((response.status === 301 || response.status === 302) && method === "POST")) {
      method = "GET";
      body = undefined;
      headers = Object.fromEntries(Object.entries(headers).filter(([name]) => !BODY_HEADERS.has(name.toLowerCase())));
    }
    // Never forward credentials to a different origin.
    if (next.origin !== url.origin) {
      headers = Object.fromEntries(Object.entries(headers).filter(([name]) => !CREDENTIAL_HEADERS.has(name.toLowerCase())));
    }
    url = next;
  }
}

/**
 * Read at most `maxBytes` of a response body. Stops reading (and cancels the
 * stream) as soon as the cap is exceeded instead of buffering the whole body.
 */
export async function readBodyCapped(
  response: Response,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!response.body) return { bytes: new Uint8Array(0), truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > maxBytes) {
        chunks.push(value.subarray(0, maxBytes - size));
        size = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    if (truncated) await reader.cancel().catch(() => undefined);
    else reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, truncated };
}

/** Unwrap undici's `TypeError: fetch failed` to the underlying cause. */
export function fetchErrorMessage(err: unknown): string {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    if (current instanceof SsrfBlockedError || !(current as { cause?: unknown }).cause) return current.message;
    current = (current as { cause?: unknown }).cause;
  }
  return current instanceof Error ? current.message : String(current);
}

export function isSsrfBlocked(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current; depth++) {
    if (current instanceof SsrfBlockedError) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
