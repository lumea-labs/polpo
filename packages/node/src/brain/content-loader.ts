import { lookup as systemLookup } from "node:dns/promises";
import { lstat, readFile, realpath } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Readable } from "node:stream";
import type { BrainParserBody } from "@polpo-ai/core/brain";
import { BrainContentLoadError } from "./errors.js";

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_REDIRECTS = 5;
const ALLOWED_MIME_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/html",
  "application/xhtml+xml",
  "application/json",
]);

export type BrainContentInput =
  | {
      readonly kind: "paste";
      readonly text: string;
      readonly contentType?: string;
    }
  | {
      readonly kind: "file";
      readonly path: string;
    }
  | {
      readonly kind: "url";
      readonly url: string;
    };

export interface BrainLoadedContent {
  readonly body: BrainParserBody;
  readonly contentType: string;
  readonly byteSize: number;
  readonly fileName?: string;
  readonly citationUri?: string;
}

export interface BrainDnsAddress {
  readonly address: string;
  readonly family: number;
}

export interface BrainSafeFetchInit {
  readonly signal: AbortSignal;
  readonly redirect: "manual";
  readonly headers: Readonly<Record<string, string>>;
  readonly validatedAddresses: readonly string[];
}

export type BrainDnsLookup = (
  hostname: string,
) => Promise<readonly BrainDnsAddress[]>;

export type BrainSafeFetch = (
  url: string,
  init: BrainSafeFetchInit,
) => Promise<Response>;

export interface NodeBrainContentLoaderOptions {
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
  readonly allowedFileRoots?: readonly string[];
  readonly dnsLookup?: BrainDnsLookup;
  readonly fetch?: BrainSafeFetch;
}

function normalizePositiveInteger(
  value: number | undefined,
  fallback: number,
  name: string,
  max: number,
): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > max) {
    throw new BrainContentLoadError(
      `${name} must be an integer between 1 and ${max}`,
      "unsupported_file",
    );
  }
  return candidate;
}

function baseMime(value: string | null | undefined): string | undefined {
  return value?.split(";", 1)[0]?.trim().toLowerCase() || undefined;
}

function isPrivateIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (
    octets.length !== 4
    || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return true;
  }
  const [a, b] = octets;
  return (
    a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 88)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51)
    || (a === 203 && b === 0)
    || a >= 224
  );
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split("%", 1)[0];
  if (
    normalized === "::"
    || normalized === "::1"
    || normalized.startsWith("fc")
    || normalized.startsWith("fd")
    || /^fe[89ab]/.test(normalized)
    || normalized.startsWith("ff")
  ) {
    return true;
  }
  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mapped) return isPrivateIpv4(mapped);
  const first = Number.parseInt(normalized.split(":", 1)[0] || "0", 16);
  if (!Number.isFinite(first) || first < 0x2000 || first > 0x3fff) return true;
  return normalized.startsWith("2001:db8:");
}

function isUnsafeAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return true;
}

async function defaultDnsLookup(hostname: string): Promise<BrainDnsAddress[]> {
  const result = await systemLookup(hostname, { all: true, verbatim: true });
  return result.map(({ address, family }) => ({ address, family }));
}

export function createPinnedAddressLookup(
  address: string,
  family: number,
): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  };
}

async function pinnedNodeFetch(
  url: string,
  init: BrainSafeFetchInit,
): Promise<Response> {
  const failures: unknown[] = [];
  for (const address of init.validatedAddresses) {
    try {
      return await requestPinnedAddress(url, init, address);
    } catch (error) {
      if (init.signal.aborted) throw error;
      failures.push(error);
    }
  }
  throw new AggregateError(failures, "Unable to connect to any validated address");
}

function requestPinnedAddress(
  url: string,
  init: BrainSafeFetchInit,
  address: string,
): Promise<Response> {
  return new Promise((resolveResponse, rejectResponse) => {
    const target = new URL(url);
    const family = isIP(address);
    if (!address || family === 0) {
      rejectResponse(new Error("No validated network address"));
      return;
    }
    const requestImpl = target.protocol === "https:" ? httpsRequest : httpRequest;
    const request = requestImpl(target, {
      method: "GET",
      headers: { ...init.headers, host: target.host },
      signal: init.signal,
      agent: false,
      lookup: createPinnedAddressLookup(address, family),
    }, (response) => {
      const headers = new Headers();
      for (let index = 0; index < response.rawHeaders.length; index += 2) {
        headers.append(response.rawHeaders[index], response.rawHeaders[index + 1]);
      }
      const status = response.statusCode ?? 500;
      const body = status === 204 || status === 304
        ? null
        : Readable.toWeb(response);
      resolveResponse(new Response(body as BodyInit | null, {
        status,
        statusText: response.statusMessage,
        headers,
      }));
    });
    request.once("error", rejectResponse);
    request.end();
  });
}

function assertTextBytes(bytes: Uint8Array): string {
  if (bytes.includes(0)) {
    throw new BrainContentLoadError(
      "Brain content is not supported text",
      "unsupported_mime",
    );
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new BrainContentLoadError(
      "Brain content must be valid UTF-8 text",
      "unsupported_mime",
      { cause: error },
    );
  }
  const controls = [...text].filter((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 && character !== "\n" && character !== "\r" && character !== "\t";
  }).length;
  if (text.length > 0 && controls / text.length > 0.01) {
    throw new BrainContentLoadError(
      "Brain content contains unsupported control data",
      "unsupported_mime",
    );
  }
  if (!text.trim()) {
    throw new BrainContentLoadError("Brain content is empty", "empty_content");
  }
  return text;
}

function sniffMime(text: string, extension?: string): string {
  const trimmed = text.trimStart();
  if (
    /^<!doctype\s+html/i.test(trimmed)
    || /^<(?:html|head|body|title|main|article|section|div|p|h[1-6])[\s>]/i.test(trimmed)
  ) {
    return "text/html";
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
      return "application/json";
    } catch {
      // Malformed JSON remains text unless the provider declared JSON.
    }
  }
  if (extension === ".md" || extension === ".markdown") return "text/markdown";
  return "text/plain";
}

function checkedMime(declared: string | undefined, text: string): string {
  if (declared && !ALLOWED_MIME_TYPES.has(declared)) {
    throw new BrainContentLoadError(
      "Remote Brain content type is not supported",
      "unsupported_mime",
    );
  }
  const sniffed = sniffMime(text);
  if (declared === "application/json") {
    try {
      JSON.parse(text);
    } catch (error) {
      throw new BrainContentLoadError(
        "Remote Brain JSON is malformed",
        "unsupported_mime",
        { cause: error },
      );
    }
  }
  if (sniffed === "text/html" || sniffed === "application/json") return sniffed;
  return declared ?? sniffed;
}

async function readBoundedResponse(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength
    && Number.isFinite(Number(declaredLength))
    && Number(declaredLength) > maxBytes
  ) {
    throw new BrainContentLoadError(
      "Remote Brain content is too large",
      "content_too_large",
    );
  }
  const encoding = response.headers.get("content-encoding");
  if (encoding && encoding.toLowerCase() !== "identity") {
    throw new BrainContentLoadError(
      "Encoded remote Brain content is not supported",
      "unsupported_mime",
    );
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new BrainContentLoadError(
          "Remote Brain content is too large",
          "content_too_large",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export class NodeBrainContentLoader {
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  private readonly maxRedirects: number;
  private readonly allowedFileRoots: readonly string[];
  private readonly dnsLookup: BrainDnsLookup;
  private readonly fetch: BrainSafeFetch;

  constructor(options: NodeBrainContentLoaderOptions = {}) {
    this.maxBytes = normalizePositiveInteger(
      options.maxBytes,
      DEFAULT_MAX_BYTES,
      "maxBytes",
      128 * 1024 * 1024,
    );
    this.timeoutMs = normalizePositiveInteger(
      options.timeoutMs,
      DEFAULT_TIMEOUT_MS,
      "timeoutMs",
      300_000,
    );
    this.maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    if (
      !Number.isSafeInteger(this.maxRedirects)
      || this.maxRedirects < 0
      || this.maxRedirects > 20
    ) {
      throw new BrainContentLoadError(
        "maxRedirects must be an integer between 0 and 20",
        "unsupported_file",
      );
    }
    this.allowedFileRoots = Object.freeze([...(options.allowedFileRoots ?? [])]);
    this.dnsLookup = options.dnsLookup ?? defaultDnsLookup;
    this.fetch = options.fetch ?? pinnedNodeFetch;
  }

  async load(input: BrainContentInput): Promise<BrainLoadedContent> {
    if (input.kind === "paste") return this.loadPaste(input);
    if (input.kind === "file") return this.loadFile(input.path);
    return this.loadUrl(input.url);
  }

  private loadPaste(input: Extract<BrainContentInput, { kind: "paste" }>): BrainLoadedContent {
    if (typeof input.text !== "string" || !input.text.trim()) {
      throw new BrainContentLoadError("Brain content is empty", "empty_content");
    }
    const bytes = new TextEncoder().encode(input.text);
    if (bytes.byteLength > this.maxBytes) {
      throw new BrainContentLoadError(
        "Brain content is too large",
        "content_too_large",
      );
    }
    const contentType = checkedMime(baseMime(input.contentType), input.text);
    return Object.freeze({
      body: Object.freeze({ kind: "text", text: input.text }),
      contentType,
      byteSize: bytes.byteLength,
    });
  }

  private async loadFile(path: string): Promise<BrainLoadedContent> {
    if (typeof path !== "string" || !path.trim() || !isAbsolute(path)) {
      throw new BrainContentLoadError(
        "Brain file path must be absolute",
        "unsupported_file",
      );
    }
    let actualPath: string;
    let roots: string[];
    try {
      [actualPath, roots] = await Promise.all([
        realpath(path),
        Promise.all(this.allowedFileRoots.map((root) => realpath(resolve(root)))),
      ]);
    } catch (error) {
      throw new BrainContentLoadError(
        "Brain file is not available",
        "unsupported_file",
        { cause: error },
      );
    }
    const insideRoot = roots.some((root) => {
      const child = relative(root, actualPath);
      return child === "" || (!child.startsWith("..") && !isAbsolute(child));
    });
    if (!insideRoot) {
      throw new BrainContentLoadError(
        "Brain file is outside the allowed roots",
        "file_outside_root",
      );
    }
    const info = await lstat(actualPath);
    if (!info.isFile()) {
      throw new BrainContentLoadError(
        "Brain file must be a regular file",
        "unsupported_file",
      );
    }
    if (info.size > this.maxBytes) {
      throw new BrainContentLoadError(
        "Brain file is too large",
        "content_too_large",
      );
    }
    const bytes = await readFile(actualPath);
    if (bytes.byteLength > this.maxBytes) {
      throw new BrainContentLoadError(
        "Brain file is too large",
        "content_too_large",
      );
    }
    const text = assertTextBytes(bytes);
    const contentType = sniffMime(text, extname(actualPath).toLowerCase());
    return Object.freeze({
      body: Object.freeze({ kind: "text", text }),
      contentType,
      byteSize: bytes.byteLength,
      fileName: basename(actualPath),
      citationUri: pathToFileURL(actualPath).toString(),
    });
  }

  private async validateUrl(value: string): Promise<{
    readonly url: URL;
    readonly addresses: readonly string[];
  }> {
    let url: URL;
    try {
      url = new URL(value);
    } catch (error) {
      throw new BrainContentLoadError("Remote Brain URL is invalid", "unsafe_url", {
        cause: error,
      });
    }
    if (
      (url.protocol !== "http:" && url.protocol !== "https:")
      || url.username
      || url.password
      || !url.hostname
    ) {
      throw new BrainContentLoadError("Remote Brain URL is unsafe", "unsafe_url");
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (
      hostname === "localhost"
      || hostname.endsWith(".localhost")
      || hostname.endsWith(".local")
      || hostname.endsWith(".internal")
    ) {
      throw new BrainContentLoadError("Remote Brain URL is unsafe", "unsafe_url");
    }
    let resolved: readonly BrainDnsAddress[];
    if (isIP(hostname)) {
      resolved = [{ address: hostname, family: isIP(hostname) }];
    } else {
      try {
        resolved = await this.dnsLookup(hostname);
      } catch (error) {
        throw new BrainContentLoadError(
          "Unable to resolve remote Brain host",
          "fetch_failed",
          { cause: error },
        );
      }
    }
    if (
      resolved.length === 0
      || resolved.some(({ address }) => isUnsafeAddress(address))
    ) {
      throw new BrainContentLoadError("Remote Brain URL is unsafe", "unsafe_url");
    }
    return {
      url,
      addresses: Object.freeze([...new Set(resolved.map(({ address }) => address))]),
    };
  }

  private async loadUrl(value: string): Promise<BrainLoadedContent> {
    let current = value;
    for (let redirectCount = 0; ; redirectCount += 1) {
      if (redirectCount > this.maxRedirects) {
        throw new BrainContentLoadError(
          "Remote Brain URL redirected too many times",
          "too_many_redirects",
        );
      }
      const validated = await this.validateUrl(current);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        let response: Response;
        try {
          response = await this.fetch(validated.url.toString(), {
            signal: controller.signal,
            redirect: "manual",
            headers: {
              accept: [...ALLOWED_MIME_TYPES].join(", "),
              "accept-encoding": "identity",
              "user-agent": "Polpo-Brain/1",
            },
            validatedAddresses: validated.addresses,
          });
        } catch (error) {
          throw new BrainContentLoadError(
            "Unable to load remote Brain content",
            "fetch_failed",
            { cause: error },
          );
        }
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("location");
          await response.body?.cancel();
          if (!location) {
            throw new BrainContentLoadError(
              "Remote Brain redirect is invalid",
              "fetch_failed",
            );
          }
          current = new URL(location, validated.url).toString();
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new BrainContentLoadError(
            "Unable to load remote Brain content",
            "fetch_failed",
          );
        }
        const declaredMime = baseMime(response.headers.get("content-type"));
        if (declaredMime && !ALLOWED_MIME_TYPES.has(declaredMime)) {
          await response.body?.cancel();
          throw new BrainContentLoadError(
            "Remote Brain content type is not supported",
            "unsupported_mime",
          );
        }
        const bytes = await readBoundedResponse(response, this.maxBytes);
        const text = assertTextBytes(bytes);
        const contentType = checkedMime(declaredMime, text);
        return Object.freeze({
          body: Object.freeze({ kind: "text", text }),
          contentType,
          byteSize: bytes.byteLength,
          citationUri: validated.url.toString(),
        });
      } catch (error) {
        if (error instanceof BrainContentLoadError) throw error;
        throw new BrainContentLoadError(
          "Unable to load remote Brain content",
          "fetch_failed",
          { cause: error },
        );
      } finally {
        clearTimeout(timer);
      }
    }
  }
}
